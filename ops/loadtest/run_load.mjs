#!/usr/bin/env node
// Load test for the scheduler → queue → worker pipeline.
//
// Fires N ad-hoc "run now" requests at an existing job as fast as the API will
// take them, measuring enqueue latency, then polls /metrics until the queue
// drains to measure end-to-end worker throughput (runs/sec).
//
// Usage:
//   API_URL=http://127.0.0.1:3001/api API_EMAIL=petros@acme.gr API_PASSWORD=petros1234 \
//     node ops/loadtest/run_load.mjs --count 50 --concurrency 10
//
// It only enqueues runs of a job that already exists (no schema changes); the
// runs it creates are ordinary executions that age out via retention.

const BASE = process.env.API_URL ?? 'http://127.0.0.1:3001/api';
const METRICS = (process.env.METRICS_URL ?? BASE.replace(/\/api$/, '') + '/metrics');
const EMAIL = process.env.API_EMAIL ?? 'petros@acme.gr';
const PASSWORD = process.env.API_PASSWORD ?? 'petros1234';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const COUNT = Number(args.count ?? 50);
const CONCURRENCY = Number(args.concurrency ?? 10);

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const body = await res.json();
  const tenant = body.tenants.find((t) => t.slug === 'acme') ?? body.tenants[0];
  return { token: body.accessToken, tenantId: tenant.id };
}

function authHeaders({ token, tenantId }) {
  return { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId };
}

async function pickJob(ctx) {
  const res = await fetch(`${BASE}/jobs`, { headers: authHeaders(ctx) });
  const jobs = await res.json();
  if (!jobs.length) throw new Error('no jobs to load-test against');
  return jobs[0];
}

// Parse a single counter value out of the Prometheus text exposition.
async function metric(name, labelMatch = '') {
  const res = await fetch(METRICS);
  const text = await res.text();
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(name)) continue;
    if (labelMatch && !line.includes(labelMatch)) continue;
    const v = Number(line.trim().split(/\s+/).pop());
    if (!Number.isNaN(v)) total += v;
  }
  return total;
}

async function main() {
  console.log(`Load test: ${COUNT} runs, concurrency ${CONCURRENCY}, target ${BASE}`);
  const ctx = await login();
  const job = await pickJob(ctx);
  console.log(`Target job: ${job.name} (${job.id})`);

  const before = await metric('cronapp_runs_by_status').catch(() => null);
  const startedBefore = Date.now();

  // Fire COUNT run-now requests with a bounded concurrency pool.
  const latencies = [];
  let next = 0;
  let ok = 0;
  let failed = 0;
  async function worker() {
    while (next < COUNT) {
      const i = next++;
      const t0 = performance.now();
      try {
        const res = await fetch(`${BASE}/jobs/${job.id}/run`, {
          method: 'POST',
          headers: authHeaders(ctx),
        });
        if (res.ok) ok++;
        else failed++;
      } catch {
        failed++;
      }
      latencies.push(performance.now() - t0);
    }
  }
  const enqStart = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const enqMs = performance.now() - enqStart;

  latencies.sort((a, b) => a - b);
  console.log('\n── Enqueue (API accept) ──');
  console.log(`  requested : ${COUNT}`);
  console.log(`  accepted  : ${ok}`);
  console.log(`  failed    : ${failed}`);
  console.log(`  wall time : ${enqMs.toFixed(0)} ms`);
  console.log(`  throughput: ${((ok / enqMs) * 1000).toFixed(1)} req/s`);
  console.log(`  latency   : p50 ${pct(latencies, 50).toFixed(1)}ms  p95 ${pct(latencies, 95).toFixed(1)}ms  max ${latencies.at(-1).toFixed(1)}ms`);

  // Drain: poll /metrics until the completed-run counter stops rising.
  if (before === null) {
    console.log('\n(metrics endpoint unavailable — skipping drain measurement)');
    return;
  }
  console.log('\n── Draining queue (worker throughput) ──');
  const target = before + ok;
  const drainStart = Date.now();
  let last = before;
  let stableTicks = 0;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await metric('cronapp_runs_by_status').catch(() => last);
    const done = now - before;
    process.stdout.write(`\r  processed ${done}/${ok}  (+${now - last}/s)   `);
    if (now >= target) { last = now; break; }
    stableTicks = now === last ? stableTicks + 1 : 0;
    last = now;
    if (stableTicks >= 15) break; // nothing moving for 15s — give up
  }
  const drainMs = Date.now() - drainStart;
  const processed = last - before;
  console.log(`\n  processed : ${processed}/${ok} in ${(drainMs / 1000).toFixed(1)}s`);
  console.log(`  throughput: ${((processed / drainMs) * 1000).toFixed(1)} runs/s`);
  console.log(`  total wall: ${((Date.now() - startedBefore) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('Load test failed:', e.message);
  process.exit(1);
});
