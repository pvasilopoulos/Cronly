import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// End-to-end API smoke against a LIVE stack (Postgres + Redis + API). Run with:
//   npm run test:integration            (API on 127.0.0.1:3001)
//   API_URL=http://host:3001/api API_EMAIL=… API_PASSWORD=… npm run test:integration
//
// If the API is unreachable the whole suite skips, so a plain unit-test run (no
// stack) stays green. In CI the workflow boots the stack first, so these run for
// real and a failure blocks the pipeline.

const BASE = process.env.API_URL ?? 'http://127.0.0.1:3001/api';
const EMAIL = process.env.API_EMAIL ?? 'petros@acme.gr';
const PASSWORD = process.env.API_PASSWORD ?? 'petros1234';

interface Ctx {
  up: boolean;
  token: string;
  tenantId: string;
  createdJobId?: string;
}
const ctx: Ctx = { up: false, token: '', tenantId: '' };

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(BASE.replace(/\/api$/, '') + '/ready');
    return res.ok;
  } catch {
    return false;
  }
}

function auth(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${ctx.token}`, 'x-tenant-id': ctx.tenantId, ...extra };
}

before(async () => {
  ctx.up = await reachable();
  if (!ctx.up) return;
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert.equal(res.status, 201, 'login should succeed');
  const body = (await res.json()) as {
    accessToken: string;
    tenants: { id: string; slug: string }[];
  };
  assert.ok(body.accessToken, 'login returns an access token');
  ctx.token = body.accessToken;
  const acme = body.tenants.find((t) => t.slug === 'acme') ?? body.tenants[0];
  assert.ok(acme, 'the account has at least one tenant');
  ctx.tenantId = acme.id;
});

after(async () => {
  // Clean up the job this suite created, whatever happened.
  if (ctx.up && ctx.createdJobId) {
    await fetch(`${BASE}/jobs/${ctx.createdJobId}`, { method: 'DELETE', headers: auth() }).catch(() => {});
  }
});

test('GET /me returns the signed-in identity', async (t) => {
  if (!ctx.up) return t.skip('API not reachable');
  const res = await fetch(`${BASE}/me`, { headers: auth() });
  assert.equal(res.status, 200);
  const me = (await res.json()) as { email: string; tenants: unknown[] };
  assert.equal(me.email, EMAIL);
  assert.ok(Array.isArray(me.tenants) && me.tenants.length > 0);
});

test('GET /me/permissions returns the catalog and the owner keys', async (t) => {
  if (!ctx.up) return t.skip('API not reachable');
  const res = await fetch(`${BASE}/me/permissions`, { headers: auth() });
  assert.equal(res.status, 200);
  const p = (await res.json()) as { keys: string[]; catalog: unknown[] };
  assert.ok(p.catalog.length > 0, 'catalog is present');
  // The owner holds the new entitlements permissions.
  assert.ok(p.keys.includes('entitlements:read'));
  assert.ok(p.keys.includes('entitlements:manage'));
});

test('GET /usage reports all four quota items', async (t) => {
  if (!ctx.up) return t.skip('API not reachable');
  const res = await fetch(`${BASE}/usage`, { headers: auth() });
  assert.equal(res.status, 200);
  const u = (await res.json()) as { plan: string; items: { key: string }[] };
  assert.ok(u.plan);
  const keys = u.items.map((i) => i.key).sort();
  assert.deepEqual(keys, ['maxChannels', 'maxConcurrency', 'maxJobs', 'maxMembers']);
});

test('GET /entitlements returns plan limits and features', async (t) => {
  if (!ctx.up) return t.skip('API not reachable');
  const res = await fetch(`${BASE}/entitlements`, { headers: auth() });
  assert.equal(res.status, 200);
  const e = (await res.json()) as {
    plan: string;
    quota: Record<string, number>;
    availableFeatures: unknown[];
  };
  assert.ok(e.plan);
  assert.equal(typeof e.quota.maxJobs, 'number');
  assert.ok(e.availableFeatures.length > 0);
});

test('a job can be created, listed and deleted (round-trip)', async (t) => {
  if (!ctx.up) return t.skip('API not reachable');
  const name = `inttest ${Date.now()}`;
  const createRes = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      name,
      group: '__inttest__',
      handler: 'http.request',
      cronExpr: '0 3 * * *',
      timezone: 'UTC',
      payload: { url: 'https://example.com/health' },
    }),
  });
  assert.equal(createRes.status, 201, 'job created');
  const job = (await createRes.json()) as { id: string; group: string | null };
  ctx.createdJobId = job.id;
  assert.equal(job.group, '__inttest__', 'group tag is persisted');

  const listRes = await fetch(`${BASE}/jobs`, { headers: auth() });
  const jobs = (await listRes.json()) as { id: string }[];
  assert.ok(jobs.some((j) => j.id === job.id), 'created job appears in the list');

  const delRes = await fetch(`${BASE}/jobs/${job.id}`, { method: 'DELETE', headers: auth() });
  assert.ok(delRes.status === 200 || delRes.status === 204, 'job deleted');
  ctx.createdJobId = undefined;

  const afterList = (await (await fetch(`${BASE}/jobs`, { headers: auth() })).json()) as { id: string }[];
  assert.ok(!afterList.some((j) => j.id === job.id), 'job no longer listed');
});

test('a non-5-field cron is rejected on create', async (t) => {
  if (!ctx.up) return t.skip('API not reachable');
  const res = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      name: `bad ${Date.now()}`,
      handler: 'http.request',
      cronExpr: '* * * * * *', // 6-field seconds form — not allowed
      timezone: 'UTC',
      payload: { url: 'https://example.com/health' },
    }),
  });
  assert.equal(res.status, 400, 'six-field cron rejected with 400');
});
