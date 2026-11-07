# Deploying CronApp on a Plesk VPS (no Docker)

Everything runs natively: **PostgreSQL** and **Redis** as systemd services, the
four Node processes under **PM2**, and **nginx** (managed by Plesk) terminating
TLS and reverse-proxying to them.

```
Internet ──443──▶ nginx (Plesk, Let's Encrypt)
                    ├── /        ▶ 127.0.0.1:3000  cronapp-web   (Next.js)
                    └── /api/    ▶ 127.0.0.1:3001  cronapp-api   (NestJS)
PM2 also runs:            cronapp-scheduler · cronapp-worker (×N)
Local services:          PostgreSQL :5432 · Redis :6379   (bound to localhost)
```

---

## 1. System packages (once, as root)

```bash
apt update
apt install -y postgresql redis-server
# Node 20 LTS (if not already present via Plesk's Node toolkit):
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
npm install -g pm2
```

Keep PostgreSQL and Redis bound to localhost (defaults). Only ports **80/443**
should be open to the internet — 3000, 3001, 5432 and 6379 stay local.

## 2. PostgreSQL: database + non-superuser app role

RLS only protects you if the app connects as a role **without** `BYPASSRLS`.

```bash
sudo -u postgres psql <<'SQL'
CREATE DATABASE cronapp;
CREATE ROLE cronapp LOGIN PASSWORD 'use-a-strong-password' NOSUPERUSER NOBYPASSRLS;
GRANT ALL PRIVILEGES ON DATABASE cronapp TO cronapp;
\connect cronapp
GRANT ALL ON SCHEMA public TO cronapp;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO cronapp;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO cronapp;
SQL
```

## 3. Get the code + install

Put the app outside the web root (e.g. `/opt/cronapp`) so nginx never serves
source files.

```bash
cd /opt && git clone <your-repo> cronapp && cd cronapp
npm install            # installs all workspaces
```

## 4. Configure `.env` (never committed)

```bash
cp .env.example .env
```

Set at least:

| Variable | Production value |
|---|---|
| `DATABASE_URL` | `postgresql://cronapp:STRONG@localhost:5432/cronapp?schema=public` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | long random strings (`openssl rand -hex 32`) |
| `CORS_ORIGIN` | `https://your-domain.tld` |
| `STORAGE_LOCAL_PATH` | an absolute path, e.g. `/opt/cronapp/storage` (writable) |
| `REDIS_PASSWORD` | set one if Redis is password-protected |

`ecosystem.config.js` reads this `.env` and injects it into every PM2 process.

## 5. Build, migrate, (optionally) seed

```bash
npm run db:generate                         # Prisma client
npm run build                               # all workspaces → dist/ and .next/
npm run migrate:deploy -w @cronapp/database # apply committed migrations (tables + RLS)
# first install only — demo tenants/users/jobs:
npm run db:seed
mkdir -p storage                            # response object store (local driver)
```

> `migrate:deploy` is non-interactive and needs no shadow database — it just
> applies the SQL in `packages/database/prisma/migrations/`.

## 6. Start under PM2

```bash
pm2 start ecosystem.config.js
pm2 save                 # remember this process list
pm2 startup              # prints a command — run it once so PM2 survives reboot
pm2 status
```

Scale workers to match load (each also runs `WORKER_CONCURRENCY` jobs in parallel):

```bash
pm2 scale cronapp-worker 4
```

Rotate PM2 logs so they don't fill the disk:

```bash
pm2 install pm2-logrotate
```

## 7. nginx (via Plesk)

1. Plesk → **Domains → your domain → Hosting & DNS → SSL/TLS Certificates**:
   issue a **Let's Encrypt** certificate and enable HTTPS redirect.
2. Plesk → **Apache & nginx Settings**:
   - **Uncheck "Proxy mode"** (nginx serves directly; don't hand `/` to Apache).
   - Paste [`deploy/nginx-cronapp.conf`](./nginx-cronapp.conf) into
     **Additional nginx directives** and **Apply**.

Visit `https://your-domain.tld` → the dashboard loads; `…/api/...` hits the API.

---

## Redeploying a new version

```bash
cd /opt/cronapp
git pull
npm install
npm run db:generate
npm run build
npm run migrate:deploy -w @cronapp/database
pm2 reload ecosystem.config.js      # zero-downtime reload
```

Or just run the helper: [`deploy/deploy.sh`](./deploy.sh).

## Scaling later

- **More throughput** → `pm2 scale cronapp-worker N`, raise `WORKER_CONCURRENCY`.
- **Big responses outgrow the disk** → run MinIO as a native binary, set
  `STORAGE_DRIVER=s3` + the `S3_*` vars; no code change.
- **Separate DB/Redis host** → point `DATABASE_URL` / `REDIS_*` at it; keep the
  app role `NOBYPASSRLS`.

## Health checks

```bash
pm2 status
curl -s localhost:3001/api/health            # API (if a health route is enabled)
redis-cli ping                               # PONG
sudo -u postgres psql -d cronapp -c '\dt'    # tables exist
pm2 logs cronapp-scheduler --lines 50        # scheduler ticking
```
