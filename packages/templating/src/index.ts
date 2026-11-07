// @cronapp/templating — a tiny, dependency-free message templating engine shared
// by the API (validation + live preview) and the worker (rendering outbound
// messages). Templates use {{ variable }} placeholders with an optional
// `|| "fallback"`, e.g. {{ run.error || "no error" }}. The variable catalog,
// per-channel defaults and a sample context all live here so the editor and the
// renderer never drift.

export type TemplateChannel = 'INAPP' | 'EMAIL' | 'SLACK' | 'WEBHOOK';
export type TemplateEvent = 'job.failed' | 'job.timeout' | 'job.dead_letter' | 'heartbeat.missed';

export const TEMPLATE_EVENTS: { key: TemplateEvent; label: string; severity: string }[] = [
  { key: 'job.failed', label: 'Job failed', severity: 'CRITICAL' },
  { key: 'job.timeout', label: 'Job timed out', severity: 'CRITICAL' },
  { key: 'job.dead_letter', label: 'Job dead-lettered', severity: 'CRITICAL' },
  { key: 'heartbeat.missed', label: 'Heartbeat missed', severity: 'WARNING' },
];

export const TEMPLATE_CHANNELS: { key: TemplateChannel; label: string; hasSubject: boolean; json: boolean; note: string }[] = [
  { key: 'INAPP', label: 'In-app & push', hasSubject: true, json: false, note: 'Subject is the notification title; body is the message. Also used for mobile push.' },
  { key: 'EMAIL', label: 'Email', hasSubject: true, json: false, note: 'Subject is the email subject line; body is the plain-text message.' },
  { key: 'SLACK', label: 'Slack', hasSubject: false, json: false, note: 'Body is the text posted to the Slack channel.' },
  { key: 'WEBHOOK', label: 'Webhook', hasSubject: false, json: true, note: 'Body is a JSON template; variables are JSON-escaped. Must be valid JSON once rendered.' },
];

export interface TemplateVariable {
  key: string;
  label: string;
  /** Which events this variable is meaningful for ('all' = every event). */
  scope: 'all' | 'failure' | 'heartbeat';
  sample: string;
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  { key: 'job.name', label: 'Job name', scope: 'all', sample: 'Nightly export' },
  { key: 'job.id', label: 'Job ID', scope: 'all', sample: 'job_abc123' },
  { key: 'job.handler', label: 'Handler', scope: 'all', sample: 'http.request' },
  { key: 'job.runbookUrl', label: 'Runbook URL', scope: 'all', sample: 'https://wiki.example.com/runbooks/export' },
  { key: 'job.description', label: 'Job description', scope: 'all', sample: 'Exports yesterday’s orders to the warehouse' },
  { key: 'event', label: 'Event key', scope: 'all', sample: 'job.failed' },
  { key: 'severity', label: 'Severity', scope: 'all', sample: 'CRITICAL' },
  { key: 'tenant.name', label: 'Workspace name', scope: 'all', sample: 'Acme Retail' },
  { key: 'time', label: 'Timestamp (ISO)', scope: 'all', sample: '2026-01-15T03:00:12.000Z' },
  { key: 'run.id', label: 'Run ID', scope: 'failure', sample: 'run_def456' },
  { key: 'run.status', label: 'Run status', scope: 'failure', sample: 'DEAD_LETTER' },
  { key: 'run.error', label: 'Error message', scope: 'failure', sample: 'connect ECONNREFUSED 10.0.0.5:443' },
  { key: 'run.attempt', label: 'Attempt #', scope: 'failure', sample: '3' },
  { key: 'run.durationMs', label: 'Duration (ms)', scope: 'failure', sample: '1200' },
  { key: 'consecutive', label: 'Consecutive failures', scope: 'failure', sample: '3' },
  { key: 'heartbeat.overdueSec', label: 'Overdue seconds', scope: 'heartbeat', sample: '360' },
  { key: 'heartbeat.lastPingAt', label: 'Last ping (ISO)', scope: 'heartbeat', sample: '2026-01-15T02:54:00.000Z' },
];

export interface TemplateFields {
  subject?: string | null;
  body: string;
}

// ─── Built-in defaults (used when a tenant has no override) ───
const DEFAULTS: Record<string, TemplateFields> = {};
function def(event: TemplateEvent, channel: TemplateChannel, fields: TemplateFields): void {
  DEFAULTS[`${event}:${channel}`] = fields;
}

// job.failed / job.timeout / job.dead_letter share one shape; {{ run.status }}
// carries the difference, so the same copy reads correctly for all three.
for (const ev of ['job.failed', 'job.timeout', 'job.dead_letter'] as TemplateEvent[]) {
  def(ev, 'INAPP', {
    subject: 'Job "{{ job.name }}" {{ run.status }}',
    body: 'Run {{ run.id }} ended {{ run.status }} ({{ consecutive }} consecutive).',
  });
  def(ev, 'EMAIL', {
    subject: '🔴 {{ job.name }} {{ run.status }}',
    body: 'Job "{{ job.name }}" ended {{ run.status }} after {{ consecutive }} consecutive failure(s).\n\nRun: {{ run.id }}\nError: {{ run.error || "—" }}\nRunbook: {{ job.runbookUrl || "—" }}\n\n— {{ tenant.name }} · CronApp',
  });
  def(ev, 'SLACK', {
    body: '🔴 CronApp: job "{{ job.name }}" {{ run.status }} ({{ consecutive }} consecutive) — run {{ run.id }}',
  });
  def(ev, 'WEBHOOK', {
    body: '{\n  "event": "{{ event }}",\n  "job": "{{ job.name }}",\n  "jobId": "{{ job.id }}",\n  "runId": "{{ run.id }}",\n  "status": "{{ run.status }}",\n  "consecutive": {{ consecutive }}\n}',
  });
}

def('heartbeat.missed', 'INAPP', {
  subject: 'Job "{{ job.name }}" missed its heartbeat',
  body: 'No ping or successful run in over {{ heartbeat.overdueSec }}s.',
});
def('heartbeat.missed', 'EMAIL', {
  subject: '🟠 {{ job.name }} missed its heartbeat',
  body: 'Job "{{ job.name }}" has not pinged or run successfully in over {{ heartbeat.overdueSec }}s.\n\nLast ping: {{ heartbeat.lastPingAt || "never" }}\nRunbook: {{ job.runbookUrl || "—" }}\n\n— {{ tenant.name }} · CronApp',
});
def('heartbeat.missed', 'SLACK', {
  body: '🟠 CronApp: job "{{ job.name }}" missed its heartbeat — no ping or successful run in over {{ heartbeat.overdueSec }}s',
});
def('heartbeat.missed', 'WEBHOOK', {
  body: '{\n  "event": "heartbeat.missed",\n  "job": "{{ job.name }}",\n  "jobId": "{{ job.id }}",\n  "overdueSec": {{ heartbeat.overdueSec }}\n}',
});

export function defaultTemplate(event: string, channel: string): TemplateFields | null {
  return DEFAULTS[`${event}:${channel}`] ?? null;
}

// ─── Context + rendering ───

export interface TemplateContext {
  event: string;
  severity: string;
  job: { name: string; id: string; handler?: string; runbookUrl?: string | null; description?: string | null };
  run?: { id?: string; status?: string; error?: string | null; attempt?: number; durationMs?: number | null };
  consecutive?: number;
  tenant?: { name?: string };
  heartbeat?: { overdueSec?: number; lastPingAt?: string | null };
  time?: string;
}

function lookup(ctx: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o != null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ctx);
}

function jsonEscape(s: string): string {
  const j = JSON.stringify(s);
  return j.slice(1, j.length - 1);
}

/**
 * Render a template string against a context. `mode: 'json'` JSON-escapes every
 * substituted value so a WEBHOOK body stays valid JSON. Supports
 * `{{ path }}` and `{{ path || "fallback" }}`; an unknown or empty value yields
 * the fallback, or an empty string when none is given.
 */
export function renderTemplate(tpl: string, ctx: TemplateContext, mode: 'text' | 'json' = 'text'): string {
  if (!tpl) return '';
  return tpl.replace(/{{\s*([^}]+?)\s*}}/g, (_m, expr: string) => {
    let path = expr.trim();
    let fallback = '';
    const orIdx = path.indexOf('||');
    if (orIdx >= 0) {
      fallback = path.slice(orIdx + 2).trim().replace(/^["']|["']$/g, '');
      path = path.slice(0, orIdx).trim();
    }
    const v = lookup(ctx, path);
    let out: string;
    if (v === undefined || v === null || v === '') out = fallback;
    else out = String(v);
    return mode === 'json' ? jsonEscape(out) : out;
  });
}

export function renderFields(fields: TemplateFields, ctx: TemplateContext, channel: TemplateChannel): TemplateFields {
  const mode = channel === 'WEBHOOK' ? 'json' : 'text';
  return {
    subject: fields.subject != null ? renderTemplate(fields.subject, ctx, mode) : null,
    body: renderTemplate(fields.body, ctx, mode),
  };
}

/** Deterministic sample context for the editor's live preview. */
export function sampleContext(event: string): TemplateContext {
  const base: TemplateContext = {
    event,
    severity: TEMPLATE_EVENTS.find((e) => e.key === event)?.severity ?? 'WARNING',
    job: {
      name: 'Nightly export',
      id: 'job_abc123',
      handler: 'http.request',
      runbookUrl: 'https://wiki.example.com/runbooks/export',
      description: 'Exports yesterday’s orders to the warehouse',
    },
    tenant: { name: 'Acme Retail' },
    time: '2026-01-15T03:00:12.000Z',
  };
  if (event === 'heartbeat.missed') {
    base.heartbeat = { overdueSec: 360, lastPingAt: '2026-01-15T02:54:00.000Z' };
  } else {
    base.run = { id: 'run_def456', status: event === 'job.timeout' ? 'TIMEOUT' : event === 'job.dead_letter' ? 'DEAD_LETTER' : 'FAILED', error: 'connect ECONNREFUSED 10.0.0.5:443', attempt: 3, durationMs: 1200 };
    base.consecutive = 3;
  }
  return base;
}

/** Validate a WEBHOOK body renders to valid JSON under the sample context. */
export function validateTemplate(event: string, channel: TemplateChannel, fields: TemplateFields): string | null {
  try {
    const rendered = renderFields(fields, sampleContext(event), channel);
    if (channel === 'WEBHOOK') JSON.parse(rendered.body);
    return null;
  } catch (e) {
    return channel === 'WEBHOOK' ? 'Webhook body must render to valid JSON' : (e as Error).message;
  }
}
