import { createHash, randomBytes } from 'node:crypto';

// Opaque bearer tokens (refresh + password-reset). We hand the caller the raw
// token once and persist only its SHA-256, so a database leak cannot be replayed.

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A URL-safe opaque token with a short type prefix, e.g. "rt_AbC...". */
export function opaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}
