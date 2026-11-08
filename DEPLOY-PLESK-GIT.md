# Deploying CronApp via Plesk Git — step‑by‑step

You've connected Plesk's **Git** feature to `github.com/pvasilopoulos/Cronly`.
With this flow Plesk pulls the branch into a directory on the server, and after
each pull runs a **deployment action** that builds the app and reloads PM2. Your
repo already ships everything needed for this:

- `deploy/deploy.sh` — install → generate Prisma → build → migrate → `pm2 reload`
- `deploy/nginx-cronapp.conf` — the reverse‑proxy directives to paste into Plesk
- `ecosystem.config.js` — PM2 manifest (path‑independent; reads the untracked
  root `.env`)

The whole thing splits into **A) one‑time server setup** (you do this once over
SSH) and **B) the Plesk Git wiring** (pull + deploy action). After that, every
`git push` → deploy is one click (or automatic).

> Replace `cron.example.com` with your domain. The subscription's system user is
> written as `cronly_sys` below — use whatever Plesk shows under
> **Websites & Domains → Hosting Settings → System user / FTP**.

---

## Part A — one‑time server setup (SSH as root)

These can't be done from the Git panel; do them once.

### A1. Runtimes: Node 20, PM2

MySQL/MariaDB is already provided and managed by Plesk — **no Redis, no separate
database server to install**. Tenant isolation is enforced in the application
layer (a Prisma client extension), so there is no Row‑Level Security and no
special database role to configure.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs build-essential
npm install -g pm2
```

> On Plesk, Node is usually already installed under `/opt/plesk/node/<ver>/bin`;
> `deploy/plesk-deploy.sh` auto‑detects it, so the NodeSource install above is
> only needed if you want a system‑wide `node`.

### A2. Database — create it in the Plesk UI (no SSH)

**Websites & Domains → Databases → Add Database**:

- **Database:** `cronapp` (MySQL/MariaDB)
- **Database user:** `cronapp` with a strong password, access from `127.0.0.1`

That's it — a plain user with full rights on its own database is all the app
needs. No `CREATEROLE`, no RLS role, no superuser step.

### A3. Let the system user run Node tooling + PM2

Plesk runs deployment actions **as the subscription's system user**, not root,
often with a bare PATH. Make sure that user can reach `node`, `npm`, and `pm2`:

```bash
# confirm where they are (NodeSource installs to /usr/bin)
which node npm pm2
```

If `pm2` isn't on the system user's PATH, either install it for that user or
reference it by full path in the deploy action. Simplest: keep the global PM2
and make sure `/usr/bin` and `/usr/local/bin` are on the user's PATH (add to
`~cronly_sys/.bash_profile` if needed).

---

## Part B — Plesk Git panel

### B1. Confirm the repository settings

**Websites & Domains → cron.example.com → Git**:

- **Remote Git repository:** `https://github.com/pvasilopoulos/Cronly.git`
- **Branch to track:** `main`
- **Deployment mode:** start with **Manual** (switch to *Automatic on push* once
  a deploy succeeds — Plesk registers a GitHub webhook for you).
- **Deployment path:** a dedicated folder, **not** `httpdocs` — we don't serve
  files from disk, we proxy to Node. Something like
  `/var/www/vhosts/cron.example.com/cronly`. Note this path — call it `$APP`.

Click **Pull** once so `$APP` is populated with the repo (you'll see `apps/`,
`packages/`, `deploy/`, `ecosystem.config.js`, `.env.example`, …).

### B2. Create the production `.env` in the deployment path (once)

`.env` is **git‑ignored**, so it's not in the repo and Plesk never overwrites or
deletes it on pulls — create it once at `$APP/.env`:

```bash
cd $APP          # e.g. /var/www/vhosts/cron.example.com/cronly
cp .env.example .env

# secrets (run as the system user, in $APP so web-push is resolvable after build)
node -e "console.log('SECRETS_KEY='+require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('JWT_ACCESS_SECRET='+require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log('JWT_REFRESH_SECRET='+require('crypto').randomBytes(48).toString('base64'))"
# VAPID — run after the first build, or: npx web-push generate-vapid-keys
```

Edit `$APP/.env` (the important production values):

```ini
DATABASE_URL="mysql://cronapp:STRONG_DB_PASSWORD@127.0.0.1:3306/cronapp"
SECRETS_KEY="<from above>"
JWT_ACCESS_SECRET="<from above>"
JWT_REFRESH_SECRET="<from above>"
JWT_ACCESS_TTL="900"
JWT_REFRESH_TTL="2592000"
JWT_MFA_TTL="300"
PASSWORD_RESET_TTL="1800"
APP_URL="https://cron.example.com"
CORS_ORIGIN="https://cron.example.com"
API_PORT="3001"
STORAGE_DRIVER="local"
STORAGE_LOCAL_PATH="./storage"
STORAGE_INLINE_MAX_BYTES="8192"
SCHEDULER_TICK_MS="15000"
WORKER_CONCURRENCY="10"
RESPONSE_RETENTION_DAYS="30"
VAPID_PUBLIC_KEY="<from web-push>"
VAPID_PRIVATE_KEY="<from web-push>"
VAPID_SUBJECT="mailto:admin@cron.example.com"
```

```bash
chmod 600 $APP/.env
mkdir -p $APP/storage
```

`APP_URL`/`CORS_ORIGIN` **must** be your HTTPS domain. Email is configured
in‑app (Settings → email delivery), not here.

### B3. First build, migrate, seed (once, over SSH as the system user)

The first time, run the steps manually so you can watch for errors and seed the
admin account:

```bash
cd $APP
npm ci
npm run db:generate
npm run build
npm run db:migrate:deploy      # applies all migrations (schema)
npm run db:seed                # creates the super-admin (first time only)
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd            # run the command it prints (as root), then:
pm2 save
pm2 status                     # cronapp-api / -web / -worker / -scheduler = online
```

Seed login: **`admin@cronapp.local` / `admin1234` — change it on first login.**

> `db:seed` is deliberately **not** in `deploy/deploy.sh` — it must run only once,
> not on every deploy.

### B4. Wire the Plesk deployment action

In the Git panel, open **Enable additional deployment actions** and paste:

```bash
cd /var/www/vhosts/cron.example.com/cronly
export PATH=/usr/local/bin:/usr/bin:$PATH
./deploy/deploy.sh
```

That script (already in your repo) does, on every deploy:
`npm install` → `npm run db:generate` → `npm run build` →
`prisma migrate deploy` → `pm2 reload ecosystem.config.js` (or first‑time
`pm2 start` + `pm2 save`).

> If PM2 lives somewhere unusual for the system user, add its dir to the `export
> PATH=...` line, or edit the last block of `deploy/deploy.sh` to call pm2 by
> full path. The `cd` + explicit PATH are the two things that most often trip up
> Plesk deployment actions.

---

## Part C — nginx reverse proxy + HTTPS

### C1. Proxy directives

**Websites & Domains → cron.example.com → Apache & nginx Settings:**

1. **UNCHECK "Proxy mode"** (so nginx serves the `location /` block directly
   instead of handing `/` to Apache — otherwise the proxy is ignored).
2. Paste the contents of **`deploy/nginx-cronapp.conf`** into
   **Additional nginx directives**.
3. **Apply** — Plesk validates and reloads nginx.

That config routes `/api/ → 127.0.0.1:3001`, everything else → `:3000`, with
no‑buffering + long timeouts for large run responses, and long‑cache for
`/_next/static/`.

### C2. SSL (Let's Encrypt)

**SSL/TLS Certificates → install a free Let's Encrypt cert**, then enable
**Redirect HTTP → HTTPS** in Hosting Settings. HTTPS is **required** for Web
Push / service workers — the "Push to this device" toggle only works over https
(and on iOS the user must "Add to Home Screen" first).

### C3. Firewall

Allow 80/443/22 (and Plesk 8443). Keep **3000, 3001, 3306 closed to the
outside** — the proxy reaches them on `127.0.0.1`.

---

## Part D — deploy, now and later

- **Deploy now:** Git panel → **Pull & Deploy** (Manual mode), or just push to
  `main` once you've switched to *Automatic*. Plesk pulls, then runs the action,
  which builds and `pm2 reload`s — near‑zero downtime.
- **Watch it:** `pm2 status`, `pm2 logs`, and the Git panel's deployment log.
- **New DB migration in a release?** It's handled automatically —
  `deploy/deploy.sh` runs `prisma migrate deploy` every time.

---

## Verify

1. `https://cron.example.com` loads the SoftiCron console over HTTPS.
2. Log in → change the admin password.
3. Create a test job; a deliberately failing one raises a CRITICAL notification.
4. Settings → **Enable push** → allow prompt → trigger a failure → push arrives.
5. `pm2 status` → all four online, low restart counts.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy action fails `command not found` | Add the right dirs to `export PATH=...` in the action; confirm `which node npm pm2` as the system user. |
| Deploy runs but site unchanged | `pm2 reload` didn't run / pm2 is a different user — check `pm2 status` **as the system user** (`su - cronly_sys -c 'pm2 status'`). |
| API calls 502 | `cronapp-api` down, or "Proxy mode" still checked. |
| Jobs never run | the worker polls the DB for QUEUED runs — check `cronapp-worker` is online and `DATABASE_URL` is reachable. |
| Push toggle greyed out | not on HTTPS, or `VAPID_*` missing in `$APP/.env` (reload after fixing). |
| `.env` vanished after a pull | it shouldn't — it's git‑ignored; confirm you created it in the **deployment path**, not elsewhere. |
