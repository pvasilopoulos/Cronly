# Deploying CronApp (SoftiCron) to a Plesk VPS — step‑by‑step

**Plan A: one dedicated Linux VPS, managed with Plesk, no Docker.**

This runbook takes you from a bare VPS to a running, HTTPS‑secured production
install. CronApp is a monorepo with **four long‑running Node processes** plus
**PostgreSQL** and **Redis**:

| Process     | What it is                    | How it runs                | Port  |
|-------------|-------------------------------|----------------------------|-------|
| `api`       | NestJS REST API (prefix `/api`) | `node dist/main.js`      | 3001  |
| `web`       | Next.js 15 console (the UI)   | `next start -p 3000`       | 3000  |
| `worker`    | BullMQ job executor (daemon)  | `node dist/main.js`        | —     |
| `scheduler` | Due‑job claimer (daemon)      | `node dist/main.js`        | —     |

Plesk serves the public domain over nginx/Apache and **reverse‑proxies** to the
two HTTP ports. `worker` and `scheduler` have no inbound ports — they only talk
to PostgreSQL and Redis. We keep all four alive with **PM2**.

> Throughout, replace `cron.example.com` with your real domain and
> `/var/www/vhosts/cron.example.com` with the real docroot Plesk gives you.
> Commands assume a Debian/Ubuntu base (the most common Plesk OS); on
> AlmaLinux/CentOS swap `apt` for `dnf` and the service names noted inline.

---

## 0. Prerequisites — what you need before you start

- A VPS (2 vCPU / 4 GB RAM is a comfortable minimum) with **Plesk Obsidian**
  installed and a license activated.
- **Root or sudo SSH access** to the server (several steps below cannot be done
  from the Plesk UI alone).
- A **domain or subdomain** whose DNS A/AAAA record points at the VPS IP. Set
  this up first — Let's Encrypt (Step 9) needs it resolving.
- **Node.js ≥ 20** and **PostgreSQL 16** and **Redis** on the box (Steps 1–3).

---

## 1. Install Node.js 20, build tools, Redis

SSH in as root. Plesk ships its own Node via the "Node.js" extension, but the
build and PM2 are far simpler with a system‑wide Node 20.

```bash
# Node 20 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs build-essential git

node -v    # expect v20.x
npm -v
```

Install and enable **Redis** (BullMQ's backing store — required):

```bash
apt-get install -y redis-server
systemctl enable --now redis-server
redis-cli ping      # -> PONG
```

> AlmaLinux/CentOS: `dnf install -y redis` and the service is `redis`.

Leave Redis on its default `127.0.0.1:6379`, bound to localhost only. If you set
a password in `/etc/redis/redis.conf` (`requirepass ...`), put the same value in
`REDIS_PASSWORD` later.

Install **PM2** globally (our process manager):

```bash
npm install -g pm2
```

---

## 2. Install / confirm PostgreSQL 16

Plesk can install PostgreSQL from **Tools & Settings → Database Servers**, or
install it yourself:

```bash
apt-get install -y postgresql-16
systemctl enable --now postgresql
psql --version   # expect 16.x
```

---

## 3. Create the database and the application role

CronApp relies on **PostgreSQL Row‑Level Security (RLS)** for tenant isolation,
so the app **must connect as a non‑superuser role** (a superuser bypasses RLS
and would break isolation).

One migration (`00000000000007_db_query_role`) runs `CREATE ROLE` to make a
read‑only `cronapp_query` role. For `prisma migrate deploy` to apply that as the
app role, grant the app role the **CREATEROLE** attribute for the migration.
The clean approach: create `cronapp` with `CREATEROLE` (but **not** SUPERUSER
and **not** BYPASSRLS), run migrations as `cronapp` so it owns every table, then
optionally drop `CREATEROLE` afterwards.

```bash
sudo -u postgres psql
```

```sql
-- strong password — you'll put it in DATABASE_URL
CREATE ROLE cronapp LOGIN PASSWORD 'REPLACE_WITH_STRONG_PASSWORD'
  CREATEROLE NOSUPERUSER NOBYPASSRLS;

CREATE DATABASE cronapp OWNER cronapp;

\q
```

> **Why CREATEROLE, not superuser:** `cronapp` owning all tables means no
> GRANT/ownership juggling after migration, and CREATEROLE is just enough for
> migration 7 to create `cronapp_query`. It does **not** let the role bypass
> RLS, so tenant isolation stays intact. After the first deploy you may run
> `ALTER ROLE cronapp NOCREATEROLE;` to tighten it — just re‑grant it before any
> future migration that touches roles.

Confirm the app role can log in and RLS will apply to it:

```bash
PGPASSWORD='REPLACE_WITH_STRONG_PASSWORD' psql -h 127.0.0.1 -U cronapp -d cronapp -c '\conninfo'
```

> If this fails with a password/`peer` error, PostgreSQL's `pg_hba.conf` needs a
> `md5`/`scram-sha-256` line for `127.0.0.1/32`. Edit
> `/etc/postgresql/16/main/pg_hba.conf`, then `systemctl reload postgresql`.

---

## 4. Get the code onto the server

Put the app **outside** the web docroot so source and `.env` are never served.
A good home is `/opt/cronapp`:

```bash
mkdir -p /opt/cronapp
# then copy the repo in — e.g. from your machine:
#   rsync -av --exclude node_modules --exclude .next --exclude dist ./ root@SERVER:/opt/cronapp/
# or clone it if it's in a git remote:
#   git clone <your-repo-url> /opt/cronapp
cd /opt/cronapp
```

---

## 5. Create the production `.env`

Copy the example and fill it in. There is **one `.env` at the repo root** shared
by all workspaces.

```bash
cd /opt/cronapp
cp .env.example .env
```

Generate the secrets you must never leave as defaults:

```bash
# SECRETS_KEY — 32‑byte key for AES‑256‑GCM secret encryption (base64)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# JWT secrets — one each, long and random
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"

# VAPID keypair for Web Push (mobile/desktop push)
node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log('PUBLIC',k.publicKey);console.log('PRIVATE',k.privateKey)"
```

> Run the VAPID line **after** `npm ci` (Step 6) so `web-push` is installed, or
> run it inside `apps/worker` where the dep lives.

Edit `.env` so it reads roughly like this (production values):

```ini
# ---- Database ---- (the CREATEROLE non‑superuser from Step 3)
DATABASE_URL="postgresql://cronapp:REPLACE_WITH_STRONG_PASSWORD@127.0.0.1:5432/cronapp?schema=public"

# ---- Redis ----
REDIS_HOST="127.0.0.1"
REDIS_PORT="6379"
REDIS_PASSWORD=""                      # set if you configured requirepass

# ---- Secrets ----
SECRETS_KEY="<base64 from above>"
JWT_ACCESS_SECRET="<random from above>"
JWT_REFRESH_SECRET="<random from above>"
JWT_ACCESS_TTL="900"
JWT_REFRESH_TTL="2592000"
JWT_MFA_TTL="300"
PASSWORD_RESET_TTL="1800"

# ---- Public URLs ---- (your real HTTPS domain)
APP_URL="https://cron.example.com"
CORS_ORIGIN="https://cron.example.com"

# ---- API ----
API_PORT="3001"

# ---- Response storage ----
STORAGE_DRIVER="local"
STORAGE_LOCAL_PATH="/opt/cronapp/storage"
STORAGE_INLINE_MAX_BYTES="8192"

# ---- Scheduler / worker ----
SCHEDULER_TICK_MS="15000"
WORKER_CONCURRENCY="10"
RESPONSE_RETENTION_DAYS="30"

# ---- Web Push (VAPID) ----
VAPID_PUBLIC_KEY="<public from above>"
VAPID_PRIVATE_KEY="<private from above>"
VAPID_SUBJECT="mailto:admin@cron.example.com"
```

Notes:
- `APP_URL` and `CORS_ORIGIN` **must be the HTTPS domain**, or the console can't
  call the API and password‑reset links break.
- `STORAGE_LOCAL_PATH` must be writable by the user PM2 runs as (`mkdir -p
  /opt/cronapp/storage`). For multi‑server or large responses switch
  `STORAGE_DRIVER=s3` and fill the `S3_*` block instead.
- Lock the file down: `chmod 600 .env`.
- **Email**: outbound mail (alerts, invites, password resets) is configured
  **in‑app** by a super‑admin under Settings → email delivery (SMTP / Microsoft
  365 / Gmail) and stored encrypted in the DB — not in `.env`.

---

## 6. Install dependencies, generate Prisma client, build

From the repo root:

```bash
cd /opt/cronapp

# 1) install exact deps for the whole workspace
npm ci

# 2) generate the Prisma client (needed before building api/worker)
npm run db:generate

# 3) build every workspace (packages first, then apps)
npm run build
```

`npm run build` runs `build` in each workspace: the shared `packages/*`
(including `@cronapp/database`, `@cronapp/mailer`, `@cronapp/templating`) compile
to `dist/`, the NestJS `api` and the `worker`/`scheduler` compile to
`dist/main.js`, and `web` produces the Next.js production build (`.next`).

> If a build fails on a missing `@cronapp/*` dist, run `npm run build` again — on
> the first run workspaces occasionally build before a dependency's `dist` is
> ready. Re‑running resolves the order.

---

## 7. Run database migrations, RLS policies, and the seed

Still as the `cronapp` role (via `DATABASE_URL`):

```bash
cd /opt/cronapp

# apply all 18 migrations (includes CREATE ROLE cronapp_query — needs the
# CREATEROLE attribute granted in Step 3)
npm run db:migrate:deploy

# (re)apply RLS helper policies
npm run db:rls

# seed the platform super‑admin + demo workspace
npm run db:seed
```

The seed creates a super‑admin login:

- **email:** `admin@cronapp.local`
- **password:** `admin1234`

> **Change this immediately after first login** (Settings → security). It is a
> well‑known default and must never survive into production use. Consider also
> editing `packages/database/prisma/seed.ts` before seeding to use your own
> admin email/password.

---

## 8. Start the four processes with PM2

Create an ecosystem file so all four start together, load `.env`, and restart on
boot. Save it as `/opt/cronapp/ecosystem.config.js`:

```js
module.exports = {
  apps: [
    {
      name: 'cronapp-api',
      cwd: '/opt/cronapp/apps/api',
      script: 'dist/main.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'cronapp-web',
      cwd: '/opt/cronapp/apps/web',
      // use the hoisted Next binary from the workspace root
      script: '../../node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'cronapp-worker',
      cwd: '/opt/cronapp/apps/worker',
      script: 'dist/main.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'cronapp-scheduler',
      cwd: '/opt/cronapp/apps/scheduler',
      script: 'dist/main.js',
      env: { NODE_ENV: 'production' },
    },
  ],
};
```

PM2 loads `.env` from each app's `cwd`; since there's a single root `.env`,
either symlink it into each app dir **or** start PM2 with the env loaded. The
simplest robust option is to load the root `.env` via `--env-file`‑style
preload. Easiest: symlink it so every `cwd` sees the same file:

```bash
cd /opt/cronapp
for a in api web worker scheduler; do ln -sf /opt/cronapp/.env apps/$a/.env; done
```

Then start everything:

```bash
cd /opt/cronapp
pm2 start ecosystem.config.js
pm2 status                 # all four should be "online"
pm2 logs --lines 50        # check for startup errors
```

Make PM2 resurrect on reboot:

```bash
pm2 save
pm2 startup systemd        # run the command it prints, then:
pm2 save
```

Quick local check before wiring the proxy:

```bash
curl -s http://127.0.0.1:3001/api/health || echo "api not responding"
curl -s -I http://127.0.0.1:3000 | head -n1   # Next.js should answer
```

---

## 9. Point the Plesk domain at the app (reverse proxy)

In Plesk, create the domain `cron.example.com` (**Websites & Domains → Add
Domain**) if it isn't there yet. We do **not** deploy files into its docroot —
Plesk only proxies to Node.

Two routes must be proxied:

- `/api/…`  → `http://127.0.0.1:3001`
- everything else → `http://127.0.0.1:3000` (Next.js)

Open **Websites & Domains → cron.example.com → Apache & nginx Settings**, and in
**Additional nginx directives** paste:

```nginx
# API -> NestJS on 3001 (keeps the /api prefix)
location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# Everything else -> Next.js on 3000
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        "upgrade";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Tick **"Proxy mode"** (Websites & Domains → Hosting Settings) so Plesk hands
dynamic requests to nginx rather than serving static files. Apply, and Plesk
reloads nginx.

> Prefer not to hand‑edit directives? Plesk's **Docker/Node proxy rules** or the
> "Reverse Proxy" options under the domain achieve the same `/ → :3000`,
> `/api → :3001` mapping through the UI.

---

## 10. Enable HTTPS (Let's Encrypt)

In Plesk: **cron.example.com → SSL/TLS Certificates → Install a free
certificate from Let's Encrypt**. Include `www` if you use it. Then enable
**"Redirect from http to https"** in Hosting Settings.

HTTPS is **required** for Web Push and service workers — the "Push to this
device" toggle only works once the site is served over https. (On iOS the user
must also "Add to Home Screen" and open the PWA before push can be enabled — an
Apple platform requirement, not a CronApp setting.)

---

## 11. Firewall

Expose only what's public. With Plesk Firewall (or ufw):

- **Allow:** 80, 443 (web), 22 (SSH), and Plesk's admin port 8443.
- **Block from the outside:** 3000, 3001, 5432, 6379 — they must stay
  loopback‑only. Our proxy reaches them via `127.0.0.1`, so nothing external
  should hit them.

---

## 12. Verify the deployment

1. Browse to `https://cron.example.com` — the SoftiCron console loads over HTTPS.
2. Log in as `admin@cronapp.local` / `admin1234` → **change the password now**.
3. Settings → confirm Branding (logo size, favicon), Notifications, and Message
   Templates panels render.
4. Create a test job that hits a URL; watch it run (scheduler claims it, worker
   executes it). A deliberately failing job should raise a CRITICAL notification.
5. Settings → **Push to this device → Enable push**, allow the browser prompt,
   then trigger a failure and confirm the push arrives.
6. `pm2 status` shows all four processes `online` with low restart counts.

---

## 13. Redeploying a new version

```bash
cd /opt/cronapp
# pull / copy the new code, then:
npm ci
npm run db:generate
npm run build
npm run db:migrate:deploy     # apply any new migrations
npm run db:rls                # re-apply RLS (safe to repeat)
pm2 reload ecosystem.config.js   # zero-ish-downtime restart of all four
pm2 save
```

> On Windows‑style file locks you'd have to stop processes before
> `prisma generate`; on Linux that isn't an issue, so the order above is fine.

---

## Troubleshooting quick reference

| Symptom | Likely cause / fix |
|---|---|
| Console loads but every API call 502/404 | nginx `/api/` proxy wrong or `cronapp-api` down (`pm2 logs cronapp-api`). |
| Login works but data is empty / cross‑tenant leaks | app connected as a superuser or `BYPASSRLS` role — recreate `cronapp` per Step 3. |
| `migrate deploy` fails on `CREATE ROLE` | app role lacks `CREATEROLE` — `ALTER ROLE cronapp CREATEROLE;` then retry. |
| Jobs never run | Redis down/unreachable (`redis-cli ping`), or `cronapp-scheduler`/`cronapp-worker` not online. |
| "Push to this device" greyed out / fails | site not on HTTPS, or `VAPID_*` missing/invalid in `.env` (restart after fixing). |
| Emails not sending | configure a mail provider in‑app (Settings → email delivery) — it's not in `.env`. |
| Processes die on reboot | `pm2 startup` command not run, or `pm2 save` not re‑run after changes. |
