// SSRF guard for the HTTP executor.
//
// A tenant controls the target URL, so a naive fetch is a server-side request
// forgery hole: it could reach cloud metadata (169.254.169.254), loopback, or
// internal services. We reject any URL that (directly or via DNS) points at a
// non-public address, and we re-validate every redirect hop so a public URL
// cannot bounce us to an internal one.
//
// NOTE: there is a residual TOCTOU window between DNS resolution and connect
// (DNS rebinding). Full mitigation pins the connection to the validated IP via
// a custom undici lookup; that is tracked in ROADMAP #1 and needs the `undici`
// dependency. This dependency-free guard closes the common SSRF vectors.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

const MAX_REDIRECTS = 5;

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = ((n << 8) | o) >>> 0;
  }
  return n >>> 0;
}

function inV4Cidr(long: number, base: string, bits: number): boolean {
  const b = ipv4ToLong(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (long & mask) === (b & mask);
}

// Non-public / reserved IPv4 ranges.
const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (incl. 169.254.169.254 metadata)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved
];

function isBlockedV4(ip: string): boolean {
  const long = ipv4ToLong(ip);
  if (long === null) return true; // unparseable → fail closed
  return V4_BLOCKS.some(([base, bits]) => inV4Cidr(long, base, bits));
}

function isBlockedV6(ip: string): boolean {
  let addr = ip.toLowerCase();
  const pct = addr.indexOf('%'); // strip zone id
  if (pct >= 0) addr = addr.slice(0, pct);
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified

  // IPv4-mapped/embedded (::ffff:a.b.c.d or ::a.b.c.d) → check the v4 tail.
  const tail = addr.slice(addr.lastIndexOf(':') + 1);
  if (tail.includes('.')) return isBlockedV4(tail);

  const head = addr.split(':')[0];
  if (head.startsWith('fc') || head.startsWith('fd')) return true; // fc00::/7 ULA
  // fe80::/10 link-local (fe80–febf)
  if (/^fe[89ab]/.test(head)) return true;
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return true; // not an IP → fail closed
}

async function assertHostIsPublic(hostname: string): Promise<void> {
  const literal = hostname.replace(/^\[|\]$/g, ''); // IPv6 may arrive bracketed
  if (isIP(literal)) {
    if (isBlockedIp(literal)) throw new BlockedUrlError(`blocked address ${literal}`);
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await dnsLookup(hostname, { all: true });
  } catch {
    throw new BlockedUrlError(`cannot resolve host ${hostname}`);
  }
  if (records.length === 0) throw new BlockedUrlError(`no DNS records for ${hostname}`);
  for (const r of records) {
    if (isBlockedIp(r.address)) {
      throw new BlockedUrlError(`${hostname} resolves to blocked address ${r.address}`);
    }
  }
}

/** Validate scheme + host; throws BlockedUrlError if unsafe. Returns the URL. */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`scheme "${url.protocol}" not allowed`);
  }
  await assertHostIsPublic(url.hostname);
  return url;
}

/**
 * fetch() wrapper that validates the target and every redirect hop. Redirects
 * are followed manually so each new location is re-checked against the guard.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit = {},
  maxRedirects = MAX_REDIRECTS,
): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new BlockedUrlError('too many redirects');
}
