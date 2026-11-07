# CronApp

Multi-tenant platform for managing advanced cron jobs at scale — fine-grained
roles & permissions per user and per tenant, reliable scheduling, and response
storage of any size with a dynamic viewer.

Built for a single dedicated VPS running Plesk, **without Docker**: PostgreSQL,
Redis and the Node processes all run natively (systemd + PM2).

## Architecture

```
          ┌─────────────┐   claims due jobs (FOR UPDATE SKIP LOCKED)
          │  scheduler  │ ───────────────────────────────┐
          └─────────────┘                                 ▼
┌──────────┐     REST      ┌─────────────┐   enqueue   ┌───────┐   execute   ┌──────────┐
│  web     │ ───────────▶  │     api     │ ──────────▶ │ Redis │ ──────────▶ │  workers │
│ (Next.js)│   + x-tenant  │  (NestJS)   │  (BullMQ)   │BullMQ │  (BullMQ)   │  (N×)    │
└──────────┘               └─────────────┘             └───────┘             └────┬─────┘
                                  │                                                │
                                  ▼                                                ▼
                           ┌─────────────┐                                 ┌──────────────┐
                           │ PostgreSQL  │  metadata + small responses     │ object store │
                           │  (RLS on)   │  large responses offloaded ───▶ │ (fs / MinIO) │
                           └─────────────┘                                 └──────────────┘
```

- **`api`** — REST API, authentication, RBAC enforcement, CRUD.
- **`scheduler`** — one trusted process; every tick it atomically claims due
  jobs and pushes them to the queue. Never executes jobs itself.
- **`worker`** — consumes the queue, runs job handlers, stores responses,
  handles retries/backoff and the dead-letter path. Scale horizontally.
- **`web`** — Next.js dashboard (desktop / tablet / mobile). _Next phase._

### Monorepo layout

```
packages/
  database/   Prisma schema, RLS policies, client + tenant helpers, seed
  rbac/       permission catalog, role templates, feature gating, CASL ability
  storage/    response storage abstraction (local filesystem / S3 / MinIO)
apps/
  api/        NestJS REST API
  scheduler/  due-job claimer
  worker/     job executor
  web/        Next.js frontend (next phase)
```

## Multi-tenancy & permissions

Tenant isolation is enforced at **two** layers:

1. **Database (PostgreSQL Row-Level Security).** The app connects as a
   non-superuser role; every request opens a transaction that sets
   `app.current_tenant`, and RLS policies fence every query to that tenant. A
   forgotten `WHERE tenantId = …` cannot leak another client's data. See
   `packages/database/prisma/rls.sql`.
2. **Application (RBAC + CASL).** What a principal may do and see is resolved
   per request.

The effective permission of a user in a tenant is computed as:

```
  role permissions  (unioned across all their roles)
  + GRANT overrides (per-user additions)
  − DENY  overrides (per-user removals — always win)
  ∩ tenant features (plan gating: a disabled feature hides its permissions)
```

- **Permission catalog** (`packages/rbac/src/permissions.ts`) — the fixed set of
  `resource:action` keys (e.g. `jobs:run`, `responses:download`, `roles:manage`).
- **Roles** — per tenant. System roles (Owner / Admin / Operator / Analyst /
  Read-only) are seeded; tenants can also create custom roles.
- **Per-user overrides** — tune one person's access "αναλυτικά" without inventing
  a role (e.g. an Operator with `responses:download` DENIED — see the seed).
- **Feature gating per tenant** — a plan downgrade instantly hides capabilities,
  regardless of role.
- **Conditions** — a permission can carry CASL conditions that narrow *which*
  rows it applies to (e.g. only jobs tagged `billing`), controlling what a user
  *sees*, not just what they can do.

The frontend reads `GET /api/me/permissions` to show/hide controls, scope lists,
and render the permission matrix.

## Response storage (any size)

Each run records metadata in Postgres plus a ~2 KB preview. The body itself:

- **small** (≤ `STORAGE_INLINE_MAX_BYTES`, gzipped) → stored inline in Postgres,
  no object-storage round-trip;
- **large** → gzipped to object storage (local filesystem now, MinIO/S3 later by
  flipping `STORAGE_DRIVER`), with only the key + metadata in Postgres.

Lists stay fast (metadata only); the viewer streams the full body on demand
(`GET /api/runs/:id/response`) so it works regardless of size.

## Getting started (local dev)

Prerequisites: Node 20+, PostgreSQL, Redis.

```bash
# 1. install
npm install

# 2. configure
cp .env.example .env     # edit DATABASE_URL, REDIS_*, secrets

# 3. database: create the app role once (as a superuser), then:
npm run db:generate
npm run db:migrate              # apply committed migrations (tables + RLS policies)
npm run db:seed                 # demo tenants, roles, users, jobs

# 4. run everything (api + scheduler + worker)
npm run dev
```

Migrations live in `packages/database/prisma/migrations/`: `…_init` creates the
schema, `…_rls_policies` installs Row-Level Security. In production apply them
with `npm run migrate:deploy -w @cronapp/database` (no shadow DB, no prompts).

## Tests

```bash
npm test            # all workspaces
npm test -w @cronapp/rbac    # permission engine: role union, GRANT/DENY, feature gating, conditions
npm test -w @cronapp/web     # cron parser/humanizer + timezone-aware next-run preview
```

The suites run headless (no Postgres/Redis needed) and cover the security-critical
core — the effective-permission resolver and the CASL ability — plus the cron
utilities, including DST-correct next-run times.

Seeded logins (see `packages/database/prisma/seed.ts`):

| User | Password | Access |
|---|---|---|
| `admin@cronapp.local` | `admin1234` | platform super-admin |
| `petros@acme.gr` | `petros1234` | **Owner** of Acme, **Analyst** in Nordwind |
| `maria@acme.gr` | `maria1234` | **Operator** in Acme (download DENIED via override) |

### API quick tour

```bash
# login → get accessToken + the tenants you can act in
curl -s localhost:3001/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"petros@acme.gr","password":"petros1234"}'

# every tenant-scoped call carries the active tenant:
curl localhost:3001/api/jobs \
  -H "authorization: Bearer <accessToken>" \
  -H "x-tenant-id: <tenantId>"
```

## Production on Plesk (no Docker)

Full walkthrough: [`deploy/DEPLOY.md`](deploy/DEPLOY.md). In short:

- **PostgreSQL & Redis** — `apt install postgresql redis-server`, bound to
  localhost. The app connects as a `NOSUPERUSER NOBYPASSRLS` role so RLS holds.
- **Node processes** — all four run under PM2 from [`ecosystem.config.js`](ecosystem.config.js)
  (`pm2 start` + `pm2 save` + `pm2 startup`), so the daemons survive crashes and
  reboots; Plesk/Passenger alone would kill idle workers. The scheduler stays a
  single instance; `pm2 scale cronapp-worker N` grows throughput.
- **nginx** — paste [`deploy/nginx-cronapp.conf`](deploy/nginx-cronapp.conf) into
  Plesk's *Additional nginx directives* (with Proxy mode off). It serves the web
  app and proxies `/api` to NestJS on the same host, Let's Encrypt for TLS.
- **Secrets** — live only in an untracked `.env`, which the PM2 manifest reads
  and injects into every process.
- **Redeploy** — `./deploy/deploy.sh` (install → build → `migrate:deploy` →
  `pm2 reload`).
- **Response storage** — local filesystem to start; MinIO as a native binary + S3
  driver (`STORAGE_DRIVER=s3`) when you outgrow it, no code change.

## Status

- [x] Monorepo, Prisma schema + RLS, permission model, CASL ability
- [x] API: auth, jobs, runs + response viewer endpoint, roles, members, me
- [x] Scheduler (SKIP LOCKED) + worker (retries, backoff, dead-letter, storage)
- [x] Next.js dashboard — desktop / tablet / mobile, permission-aware UI
- [x] Visual cron builder (schedule picker + humanizer + next-run preview)
- [x] Prisma migrations committed (schema + RLS); unit tests for RBAC + cron
- [x] Deploy configs — PM2 manifest, nginx directives, Plesk guide + redeploy script
- [ ] End-to-end run against live Postgres/Redis; API integration tests
