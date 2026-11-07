#!/usr/bin/env bash
#
# One-shot CronApp deploy for Plesk Git.
#
# Plesk's "additional deployment actions" field does NOT run a multi-line script
# as one bash process (it loses `export`/functions between lines and ignores a
# leading `exec` redirect). So keep the Plesk action to a SINGLE line:
#
#     bash ./deploy/plesk-deploy.sh
#
# Everything real happens here, in one bash process, with all output captured to
# deploy.log in the repo root (open it from Plesk File Manager).

# Run from the repo root (this file lives in deploy/).
cd "$(dirname "$0")/.." || exit 1
exec > deploy.log 2>&1
set -x

echo "=== CronApp deploy @ $(date) ==="
echo "Deploying in: $(pwd)"

# ── Locate the Node runtime installed by the Plesk Node.js extension ──────────
# Plesk installs each Node version under /opt/plesk/node/<N>/bin. Pick the
# highest available and put it on PATH so node/npm/npx resolve.
NODE_BIN="$(ls -d /opt/plesk/node/*/bin 2>/dev/null | sort -V | tail -1)"
if [ -n "$NODE_BIN" ]; then export PATH="$NODE_BIN:$PATH"; fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found. In Plesk > Websites & Domains > Node.js, enable Node.js 20 for this domain, then redeploy."
  exit 1
fi
echo "Using node: $(command -v node) ($(node -v)), npm $(npm -v)"

set -e

# ── .env must exist (created once via File Manager) ───────────────────────────
if [ ! -f .env ]; then
  echo "ERROR: .env missing in $(pwd). Create it via File Manager (DATABASE_URL + APP_URL/CORS_ORIGIN at minimum)."
  exit 1
fi

# ── Fill in any missing secrets (idempotent; written into .env once) ──────────
add_secret() {
  if ! grep -q "^$1=.\+" .env; then
    echo "$1=$2" >> .env
    echo "generated $1"
  fi
}
add_secret SECRETS_KEY        "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
add_secret JWT_ACCESS_SECRET  "$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"
add_secret JWT_REFRESH_SECRET "$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"

# ── Install, generate Prisma client, build all workspaces ─────────────────────
npm ci
npm run db:generate
npm run build

# ── VAPID keypair for Web Push (web-push is available after install) ──────────
if ! grep -q '^VAPID_PUBLIC_KEY=.\+' .env; then
  NODE_PATH="$(pwd)/node_modules:$(pwd)/apps/worker/node_modules" \
    node -e "const k=require('web-push').generateVAPIDKeys();require('fs').appendFileSync('.env','\nVAPID_PUBLIC_KEY='+k.publicKey+'\nVAPID_PRIVATE_KEY='+k.privateKey+'\n')"
  echo "generated VAPID keys"
fi

# ── Database migrations (schema + RLS policies) ───────────────────────────────
npm run db:migrate:deploy

# ── Start / reload the four processes under PM2 (no global install needed) ────
npx pm2 reload ecosystem.config.js --update-env || npx pm2 start ecosystem.config.js
npx pm2 save

echo "=== DEPLOY OK ==="
