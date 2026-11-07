# CronApp — Product Roadmap to GA

Status of the platform today (what already exists), followed by the work required
to turn it into a complete, production-grade SaaS product.

Legend — **Status**: ✅ done · 🟡 in progress (this iteration) · ⬜ planned
**Priority**: P0 (security/reliability blocker) · P1 (core product) · P2 (growth/ops)

---

## What already exists (solid foundation)

- **Multi-tenancy** with PostgreSQL **Row-Level Security** — app connects as a
  `NOBYPASSRLS` role; every tenant-scoped row carries `tenantId`; trusted backends
  (scheduler/worker) use `app.bypass_rls`.
- **RBAC** — permission catalog, per-tenant role templates, per-user GRANT/DENY
  overrides (DENY wins), CASL conditions, plan-based feature gating.
- **Jobs & scheduling** — 5-field cron, per-job timezone, tags, `concurrencyKey`,
  `maxRetries`, `timeoutMs`. Postgres is the source of truth; the scheduler claims
  due jobs atomically via `FOR UPDATE SKIP LOCKED` (safe to run 1 instance).
- **Execution** — BullMQ + Redis; worker runs handlers, retries with exponential
  backoff, stores responses (gzipped inline in Postgres when small, object storage
  when large) with a short preview. Enqueue is decoupled from the DB transaction
  (no queue poisoning on Redis latency).
- **Web console** — jobs list, visual cron builder, schedule editing, executions,
  roles, members, settings.
- **Auth** — JWT access/refresh, hashed passwords.
- **Ops** — committed Prisma migrations (schema + RLS), unit tests, PM2 + nginx
  (Plesk) deploy configs.

---

## Phase 0 — Security & reliability blockers (P0, this iteration)

### 1. SSRF protection in the HTTP executor — ✅ P0
**Problem.** `apps/worker/src/handlers.ts` fetches any URL a tenant supplies. A
tenant can target cloud metadata (`169.254.169.254`), `localhost`, or internal
IP ranges — a classic server-side request forgery hole on a multi-tenant box.
**Approach.** A reusable `assertSafeUrl()` guard: allow only http/https, resolve
the hostname and reject loopback / private / link-local / unique-local / CGNAT
ranges and the metadata IP; re-check after redirects (manual redirect follow, cap
hops) to stop DNS-rebinding; optional per-tenant domain allow-list.
**Acceptance.** Unit tests prove private/metadata targets throw `BLOCKED`;
public URLs pass; redirect to a private IP is blocked. **Effort:** S.

### 2. Secrets management — ✅ P0
**Problem.** `Job.payload` stores headers/body (Bearer tokens, API keys) as
plaintext JSON in Postgres. Anyone with DB/backup access reads them.
**Approach.** App-level envelope encryption (AES-256-GCM) with a master key from
`SECRETS_KEY` (32-byte base64). New `Secret` model (per tenant, encrypted value,
never returned in full by the API). Payloads reference secrets as
`{{secret:NAME}}`; the worker resolves them at run time only. Redact any
`{{secret:*}}` / known-sensitive headers in UI, previews and logs.
**Acceptance.** Secret value never leaves the API in plaintext; worker resolves
and injects at fetch time; stored response preview/logs show `***`. **Effort:** M.

### 3. Reliability sweeper (reaper) — ✅ P0
**Problem.** Two recovery gaps: (a) a run committed `QUEUED` whose enqueue failed
is orphaned; (b) if a worker dies mid-run the `JobRun` stays `RUNNING` forever.
**Approach.** A periodic sweep (in the scheduler process): re-enqueue `QUEUED`
runs older than N seconds; mark `RUNNING` runs older than `timeoutMs + grace` as
`FAILED` (and retry if attempts remain). Idempotent, RLS-bypassed, batched.
**Acceptance.** Killing a worker mid-run leaves no permanently-`RUNNING` row;
an un-enqueued `QUEUED` run is picked up within one sweep. **Effort:** S.

### 4. Single cron engine — ✅ P0
**Problem.** The scheduler uses `cron-parser`; the web uses a custom Intl-based
util. The UI's "next runs" preview can disagree with what actually fires.
**Also found (2026-11-05):** a worse, live bug — jobs re-fired every scheduler
tick (~15s) instead of on their cron. `nextRunAt` is stored UTC-naive but the DB
session ran in the server's local zone (+02), so `nextRunAt <= now()` compared
UTC against local wall-clock and every job looked perpetually due.
**Done.**
- **Timezone fix (P0):** all Prisma connections now pin the session to UTC —
  `getPrisma()` appends `options=-c timezone=UTC` to `DATABASE_URL` (in
  `@cronapp/database`). Every raw-SQL `now()`/interval comparison (scheduler
  claim, reaper sweeps, heartbeat monitor) now matches the UTC-naive stored
  timestamps. Verified: `nextRunAt` values are sane & DST-correct (`0 3 * * *`
  Athens → `01:00Z`), and a `*/5` job fires once per 5 min, `* * * * *` once per
  minute — the scheduler claims only at real due-times, not every tick.
- **Single engine:** new `@cronapp/cron` package (wraps `cron-parser`) is the one
  source of truth. Scheduler, API (`common/cron` re-exports it) and web
  (`lib/cron` `nextRuns`/`isValidCron` delegate to it; `describeCron` stays local
  for humanizing) all use it — web via `transpilePackages`. Verified identical
  output across engines, correct DST (London spring-forward, NY weekdays), and the
  CronBuilder preview matches the scheduler's firing.
**Acceptance.** ✅ UI preview == scheduler's computed `nextRunAt` across
expressions/timezones incl. a DST boundary; a `*/5` job fires every 5 min, not
every tick. **Follow-up:** audit remains that all three use the same parser, so a
preview can't drift again; the reaper's stuck-RUNNING sweep is also fixed by the
UTC change.

---

## Phase 1 — Core product features (P1)

### 5. Failure alerting — ✅ P1 (console UI for channels+rules shipped; SMTP email delivery pending)
**Problem.** No way to be told when a job fails — the single most important
feature of a cron product, entirely absent (no notification model).
**Approach.** `NotificationChannel` (email / Slack / webhook, per tenant) and
`AlertRule` (on FAILED/TIMEOUT/DEAD_LETTER, threshold of N consecutive failures,
per job or tenant-wide). Worker emits an event on terminal failure; a dispatcher
delivers with retry. Signed webhooks.
**Acceptance.** A job that fails N times triggers exactly one alert per channel;
delivery failures are retried; UI to manage channels/rules. **Effort:** M–L.

### 6. Heartbeat / dead-man's-switch — ✅ P1
**Problem.** No "tell me if this job did NOT run" monitoring (expected by users
of Cronitor/Healthchecks).
**Approach.** Inbound ping endpoint per job (`/ping/:token`); a monitor flags a
job whose expected run + grace elapsed without a success/ping; reuses alerting.
**Acceptance.** Silencing a job past its grace window raises an alert. **Effort:** M.
**Done:** `HeartbeatState` + heartbeat fields on `Job` (token, intervalSec,
graceSec, lastPingAt, state, alertedAt). Public `GET|POST /ping/:token` (root,
prefix-excluded, unauthenticated — the token is the credential). Config under the
job: `GET/POST/DELETE /api/jobs/:id/heartbeat` + `/rotate` (jobs:read / jobs:update),
audited. A successful run OR an inbound ping resets the window. Monitor runs in
the **worker** (owns alert delivery + SSRF guard): a single atomic `OK→MISSING`
transition (`FOR UPDATE SKIP LOCKED` + state guard) → safe across instances, one
alert per miss, no re-alert loop. Delivery refactored into a shared
`deliverToChannel` reused by run-failure and heartbeat alerts; a miss also writes
a `job.heartbeat.missed` audit row (system actor). Web: heartbeat panel in the job
drawer (enable with presets, ping URL + copy-curl, rotate/disable, Live/Missing
badge) + a `♥ missed` badge in the jobs list. Verified: fresh ping stays OK across
ticks (no false positive), a real lapse flips once and alerts once, ping recovers.
**Note:** the monitor compares `lastPingAt < (now() AT TIME ZONE 'UTC') - window`
to dodge the live timezone bug in #4 (see below).

### 7. Public API + API keys — ✅ P1
**Problem.** Only interactive JWT session auth; no programmatic access.
**Approach.** Per-tenant API keys (hashed, scoped to permissions), `Authorization:
Bearer cak_…`, rate-limited; full CRUD over jobs/runs; OpenAPI/Swagger docs.
**Acceptance.** A key with `jobs:write` can create/trigger a job over REST and is
rejected for `roles:write`; Swagger UI lists every endpoint. **Effort:** M.

### 8. More handlers (plugin model) — ✅ P1
**Problem.** Only `http.request`.
**Approach.** Formalize the handler registry: `webhook` (signed), `email`,
`db.query` (tenant-scoped, read-only), optionally a sandboxed `command`. Per-handler
payload schema + validation; UI picks handler and renders its form.
**Acceptance.** At least `http.request`, `webhook`, `email` shipped with schema
validation and docs. **Effort:** M.
**Done:** new shared `@cronapp/handlers` package — the one catalog (key, label,
description, typed fields) + `validatePayload`, consumed by the web (form +
client validation), the API (server validation + `GET /api/handlers` docs/Swagger)
and the worker. Four handlers shipped:
- **http.request** — unchanged behaviour, now string/object body-aware.
- **webhook** — POSTs a JSON body with an `x-cronapp-signature: sha256=…` HMAC
  (SSRF-guarded). Verified: httpbin echoed the signature.
- **email** — SMTP via nodemailer (`SMTP_*` env); with no SMTP it composes the
  message and returns a `dry-run` WARNING instead of failing. (Also the delivery
  path #5's email channel can adopt.)
- **db.query** — a single read-only `SELECT`/`WITH`, run inside a read-only tx as
  a dedicated **`cronapp_query`** role (migration `…07`, applied as superuser)
  that may only `SELECT` Job & JobRun, still RLS-fenced to the tenant, with a
  statement timeout. Verified: tenant-scoped aggregate works; `SELECT FROM "User"`
  → `permission denied` (sandbox holds).
Job create/update now reject an unknown handler or a payload that fails its
schema. Web: handler picker in the New Job modal renders each handler's fields
dynamically (url/select/text/sql/keyval). **Pending:** sandboxed `command`
handler; payload editing for an existing job in the drawer (create covers all
handlers today); per-plan send limits for `email`/`webhook` (ties into #14).

### 9. Dead-letter & replay UI — ✅ P1
**Problem.** `DEAD_LETTER` exists in data but nowhere to see or requeue it.
**Approach.** A runs filter for DEAD_LETTER/TIMEOUT; "Replay" action that enqueues
a fresh run from a past one; bulk replay.
**Acceptance.** A dead-lettered run can be replayed from the UI and produces a new
run linked to the job. **Effort:** S.

### 10. Audit log viewer + full wiring — ✅ P1
**Problem.** `AuditLog` is modeled; ensure every mutation writes one and expose it.
**Approach.** An `audit()` helper called by all mutating services (job/role/member/
channel changes, logins); a filterable audit screen (actor, action, target, time).
**Acceptance.** Creating/editing/deleting any entity appears in the audit screen
with actor and diff. **Effort:** S–M.
**Done:** global `AuditService` (`record` / `record_for`, fire-and-forget so it
never breaks the audited op; API-key actors stored as null + noted in meta).
Wired into every mutating path — jobs (create/update/delete/toggle/run), roles,
members (roles/overrides/invite/remove), secrets (name only, never the value),
alert channels & rules, API keys (create/revoke/delete), and successful logins
(one row per active tenant). `GET /api/audit` is filterable by action-prefix,
actor, and time range (perm `audit:read`, feature-gated on `audit.log`), with
actor identity resolved. Console viewer at `/audit` with group filter chips and
verb-colored actions. **Pending:** before/after field diffs (currently meta notes
changed keys), and audit for config/settings writes once those land.

---

## Phase 2 — Observability, lifecycle, growth (P1/P2)

### 11. Health & observability — ✅ P1
**Problem.** No health checks or metrics; the stack runs blind.
**Approach.** `/health` (liveness) and `/ready` (DB + Redis reachability) on the
API; Prometheus `/metrics` (queue depth, runs/min, success/fail rate, scheduler
lag, p50/p95 duration); structured JSON logging with run-id correlation; Sentry
for api/worker/scheduler.
**Acceptance.** `/ready` returns 503 when Postgres or Redis is down; metrics
scrape exposes run counters. **Effort:** M.
**Done:** (1) `/health` + `/ready` (503 on DB/Redis down) — already live. (2)
**Prometheus `/metrics`** (prom-client, root path, `@Public`): one scrape target
for the whole stack. In-process API metrics (default process/node metrics +
`cronapp_http_requests_total` + `cronapp_http_request_duration_seconds` histogram
with low-cardinality route labels) plus cross-process gauges derived at scrape
time from the sources of truth — BullMQ queue depth (`cronapp_queue_jobs{state}`)
and Postgres (`cronapp_jobs{status}`, `cronapp_runs_by_status`, `runs_running`,
`runs_last_minute`, `run_duration_milliseconds{quantile=0.5/0.95/0.99}`,
`heartbeat_missing`, `scheduler_lag_seconds`, `tenants`). No fragile IPC; numbers
survive any process restart and respect RLS (aggregates read with bypass).
(3) **Structured JSON logs** to stdout: API access log per response with a
`reqId` (`x-request-id`) + tenant/user — via Express middleware, so guard-rejected
401/403s are logged too; worker `run_complete`/`run_failed`/`run_deferred` with
runId/jobId correlation; scheduler `tick_claimed`. Verified: `/ready` 200 both up;
`/metrics` exposes all families (e.g. duration p50=42ms/p95=58ms/p99=64ms); JSON
logs flowing from all three services. **Pending:** Sentry wiring for
api/worker/scheduler (DSN-gated drop-in; structured error logs are the seam);
alert/recording rules + a Grafana dashboard JSON.

### 12. Retention & purge — ✅ P0
**Problem.** `RESPONSE_RETENTION_DAYS` exists but nothing deletes old runs; the DB
and object store grow unbounded.
**Approach.** A daily purge (in the reaper process) deleting `JobRun` rows and
their storage objects older than the retention window (tenant override honored),
in batches.
**Acceptance.** Runs older than the window (and their S3/local objects) are gone
after a purge cycle; recent runs untouched. **Effort:** S.

### 13. Auth completeness — ✅ P1
Refresh-token rotation + revocation, logout/session invalidation, password reset,
email verification, optional 2FA (TOTP) and SSO (OIDC/SAML) for ENTERPRISE.
**Acceptance.** A stolen refresh token can be revoked; reset-password works e2e.
**Effort:** M–L.
**Done:** (1) **Stateful refresh tokens** — opaque `rt_…` tokens, only their
SHA-256 stored; every `/auth/refresh` rotates (old revoked, new issued in the
same `familyId`). Replaying a revoked token is treated as theft and revokes the
whole family (session killed). `RefreshToken` table, no RLS (identity-scoped).
(2) **Logout / logout-all** — `/auth/logout` revokes the family, `/auth/logout-all`
revokes every session. (3) **Password reset** — `/auth/forgot-password` (no user
enumeration; dev-exposes the link when no mailer) → single-use TTL `prt_…` token →
`/auth/reset-password` sets the new password and revokes all sessions. (4) **TOTP
2FA** (RFC 6238, dependency-free `totp.ts`) — setup → otpauth URI + base32 key →
enable (verifies a code, returns 10 one-time backup codes, stored hashed) →
login step-up (`/auth/login` returns an interim MFA token; `/auth/login/mfa`
exchanges a TOTP **or backup** code for a session) → disable. Web: login MFA step,
`/forgot-password` + `/reset-password` pages, a Security panel (enrol/disable 2FA,
sign-out-everywhere) in Settings. Rate-limited: forgot 5/min, reset & mfa flows
capped. Verified e2e: rotation (rt1≠rt2), reuse→family revoked, logout→401, reset
(old pw 401 / new 201 / single-use), TOTP + backup-code login, disable restores
direct login. **Pending:** email verification on signup; SSO (OIDC/SAML) for
ENTERPRISE; deliver reset/verify mails through the configured SMTP (handler path
exists from #8).

### 14. Quotas & rate limiting — ✅ P1
Enforce plan limits (max jobs, max concurrency/tenant, retention); rate-limit the
API (login brute-force first). **Acceptance.** Exceeding the job cap is rejected
with a clear error; >N logins/min are throttled. **Effort:** S–M.
**Done:** (1) in-memory fixed-window rate limiter (global guard) — 600 req/min
per identity (API key or IP), login throttled to 20/min, `429 + Retry-After`.
(2) Per-plan quotas in `@cronapp/rbac` (`PLAN_QUOTAS`, single source of truth):
STARTER 5 jobs / 2 members / 1 channel / 1 concurrent, PRO 50/10/10/5, SCALE
500/50/50/20, ENTERPRISE unlimited. API `QuotaService` rejects over-cap job,
member-invite and channel creation with **HTTP 402** + a clear structured message
(`quota`, `plan`, `limit`, `used`). Per-tenant concurrency is enforced in the
worker via a transaction-scoped Postgres advisory lock (count-and-claim is atomic,
so RUNNING never exceeds the cap; over-cap runs defer and requeue, no retry bump).
`GET /api/usage` + a **Plan usage** panel on Settings show live usage bars.
Verified e2e: 5th job 201 / 6th 402; member & channel caps 402; 3 simultaneous
runs under concurrency=1 serialized (no overlap in start/finish timestamps).
**Pending:** retention enforcement per plan; a Redis-backed limiter for
multi-instance.

### 15. Billing (if SaaS) — ⬜ P2
Stripe integration, usage metering (runs/month), self-serve upgrade/downgrade,
plan → feature map already present. **Acceptance.** Upgrading a plan unlocks gated
features automatically. **Effort:** L.

### 16. Delivery & quality — ✅ P1
API integration tests (live Postgres/Redis), Playwright E2E for the console,
CI/CD (lint, typecheck, test, build, migrate-check), DB backups/PITR, load test of
scheduler/worker. **Acceptance.** CI is green on PR and blocks on failing tests.
**Effort:** M.

**Delivered.**
- **Unit tests** via the Node test runner (`npm test` runs every workspace):
  shared cron engine (`packages/cron`, incl. the 5-field rule), RBAC quotas &
  entitlements (`packages/rbac`), and TOTP/2FA with the RFC 6238 vector
  (`apps/api`). Fixed two stale web cron tests left from the schedule refactor.
- **Integration tests** against a live stack (`apps/api/test/integration`,
  `npm run test:integration`): login, `/me`, `/me/permissions`, `/usage`,
  `/entitlements`, a job create→list→delete round-trip, and a 5-field-cron
  rejection. Self-cleaning; skips when the API is unreachable.
- **Playwright E2E** scaffold for the console (`apps/web/e2e`, `playwright.config.ts`):
  login, jobs search/filter, executions KPIs, settings entitlements. Run with
  `npm i -D -w @cronapp/web @playwright/test && npx playwright install chromium`.
- **CI/CD** (`.github/workflows/ci.yml`): three jobs — lint + typecheck/build +
  unit; integration (Postgres 16 + Redis 7 services, migrate → RLS → seed →
  boot → test); and Playwright E2E. Blocks the PR on any failing gate.
- **Backups/PITR** (`ops/backup/`): `pg_backup.sh` (compressed `-Fc` dumps with
  RLS-aware bypass, verify, retention), `pg_restore.sh` (restore/verify into a
  throwaway or existing DB), and a README covering WAL archiving + point-in-time
  recovery. Backup→restore round-trip verified locally.
- **Load test** (`ops/loadtest/run_load.mjs`): drives ad-hoc runs at the
  scheduler→queue→worker pipeline and reports enqueue latency and worker
  throughput from `/metrics`.

---

## Suggested delivery order

1. **#1 SSRF, #2 Secrets** — security blockers, do first.
2. **#3 Reaper, #12 Retention** — reliability + storage hygiene.
3. **#11 Health/metrics** — see the system before scaling.
4. **#5 Alerting, #6 Heartbeat** — the product's differentiators.
5. **#7 API keys, #8 Handlers, #9 Replay, #10 Audit** — surface area.
6. **#13 Auth, #14 Quotas, #16 Delivery** — hardening for real tenants.
7. **#15 Billing** — when going self-serve commercial.
