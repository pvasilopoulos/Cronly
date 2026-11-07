#!/usr/bin/env bash
# Build + migrate + reload CronApp on the VPS. Run from the repo root:
#   ./deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."
echo "▶ CronApp deploy in $(pwd)"

if [ ! -f .env ]; then
  echo "✗ .env not found — copy .env.example and fill it in first." >&2
  exit 1
fi

echo "▶ Installing dependencies"
npm install

echo "▶ Generating Prisma client"
npm run db:generate

echo "▶ Building all workspaces"
npm run build

echo "▶ Applying database migrations (schema + RLS)"
npm run migrate:deploy -w @cronapp/database

if command -v pm2 >/dev/null 2>&1 && pm2 describe cronapp-api >/dev/null 2>&1; then
  echo "▶ Reloading PM2 processes (zero-downtime)"
  pm2 reload ecosystem.config.js
else
  echo "▶ Starting PM2 processes for the first time"
  pm2 start ecosystem.config.js
  pm2 save
  echo "  Run 'pm2 startup' once so PM2 restarts on reboot."
fi

echo "✓ Done. 'pm2 status' to check, 'pm2 logs' to watch."
