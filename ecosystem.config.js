/**
 * PM2 process manifest for CronApp on a Plesk VPS (no Docker).
 *
 * Runs the four Node processes as long-lived daemons that survive reboots and
 * crashes (pair with `pm2 startup` + `pm2 save`). PostgreSQL and Redis run
 * natively as their own systemd services — they are NOT managed here.
 *
 *   pm2 start ecosystem.config.js      # boot everything
 *   pm2 reload ecosystem.config.js     # zero-downtime reload after a deploy
 *   pm2 scale cronapp-worker 4         # run 4 worker processes
 *   pm2 logs cronapp-api               # tail one app
 *
 * Secrets come from the untracked root `.env` (parsed below, no dependency), so
 * nothing sensitive lives in this committed file.
 */
const fs = require('fs');
const path = require('path');

/** Minimal .env reader — avoids a dotenv dependency. Missing file is fine:
 *  values then come from the shell environment PM2 was started in. */
function loadEnv(file) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const root = __dirname;
const env = { NODE_ENV: 'production', ...loadEnv(path.join(root, '.env')) };

const common = {
  env,
  autorestart: true,
  max_restarts: 10,
  restart_delay: 3000,
  time: true, // timestamp log lines
};

module.exports = {
  apps: [
    {
      // REST API (NestJS) — serves /api behind nginx on port API_PORT (3001).
      ...common,
      name: 'cronapp-api',
      cwd: path.join(root, 'apps/api'),
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
    },
    {
      // Scheduler — the ONE trusted process that claims due jobs. Never scale
      // this beyond a single instance: "FOR UPDATE SKIP LOCKED" makes a single
      // claimer correct and simple.
      ...common,
      name: 'cronapp-scheduler',
      cwd: path.join(root, 'apps/scheduler'),
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '300M',
    },
    {
      // Workers — execute jobs off the BullMQ queue. Horizontally scalable:
      // `pm2 scale cronapp-worker N`. Each process also runs WORKER_CONCURRENCY
      // jobs in parallel internally.
      ...common,
      name: 'cronapp-worker',
      cwd: path.join(root, 'apps/worker'),
      script: 'dist/main.js',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '500M',
    },
    {
      // Web dashboard (Next.js) — `next start` on port 3000 behind nginx.
      // `next` is hoisted to the repo-root node_modules by npm workspaces.
      ...common,
      name: 'cronapp-web',
      cwd: path.join(root, 'apps/web'),
      script: path.join(root, 'node_modules/next/dist/bin/next'),
      args: 'start -p 3000',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '500M',
      env: { ...env, PORT: '3000' },
    },
  ],
};
