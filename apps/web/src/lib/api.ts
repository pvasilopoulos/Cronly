// Minimal API client. Holds the access token + active tenant in localStorage,
// attaches them to every request, and refreshes the token once on a 401.

const LS = { access: 'cronapp.access', refresh: 'cronapp.refresh', tenant: 'cronapp.tenant' };

function ls(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export const tokens = {
  get access() {
    return ls()?.getItem(LS.access) ?? null;
  },
  get refresh() {
    return ls()?.getItem(LS.refresh) ?? null;
  },
  get tenant() {
    return ls()?.getItem(LS.tenant) ?? null;
  },
  set(access: string | null, refresh?: string | null) {
    const s = ls();
    if (!s) return;
    if (access === null) s.removeItem(LS.access);
    else s.setItem(LS.access, access);
    if (refresh !== undefined) {
      if (refresh === null) s.removeItem(LS.refresh);
      else s.setItem(LS.refresh, refresh);
    }
  },
  setTenant(id: string | null) {
    const s = ls();
    if (!s) return;
    if (id === null) s.removeItem(LS.tenant);
    else s.setItem(LS.tenant, id);
  },
  clear() {
    const s = ls();
    if (!s) return;
    [LS.access, LS.refresh, LS.tenant].forEach((k) => s.removeItem(k));
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface Opts {
  method?: string;
  body?: unknown;
  tenant?: boolean; // attach x-tenant-id header (default true)
  raw?: boolean; // return the Response (for streaming bodies)
}

async function doFetch(path: string, opts: Opts): Promise<Response> {
  const headers: Record<string, string> = {};
  const access = tokens.access;
  if (access) headers['authorization'] = `Bearer ${access}`;
  if (opts.tenant !== false && tokens.tenant) headers['x-tenant-id'] = tokens.tenant;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  return fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function refreshToken(): Promise<boolean> {
  const refresh = tokens.refresh;
  if (!refresh) return false;
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
  });
  if (!res.ok) return false;
  // The server rotates the refresh token on every use: persist the new one, or
  // the next refresh would replay a now-revoked token and kill the session.
  const data = (await res.json()) as { accessToken: string; refreshToken?: string };
  tokens.set(data.accessToken, data.refreshToken ?? refresh);
  return true;
}

export async function api<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  let res = await doFetch(path, opts);
  if (res.status === 401 && tokens.refresh) {
    if (await refreshToken()) res = await doFetch(path, opts);
  }
  if (opts.raw) return res as unknown as T;
  if (!res.ok) {
    let message = res.statusText;
    try {
      const j = await res.json();
      message = Array.isArray(j.message) ? j.message.join(', ') : (j.message ?? message);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// SWR fetcher
export const fetcher = <T>(path: string) => api<T>(path);
