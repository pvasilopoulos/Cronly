// The job-handler catalog: the single source of truth for which handlers exist,
// what payload each needs, and how to validate it. Dependency-free so the web
// console (form rendering + client validation), the API (server validation +
// `GET /api/handlers` docs) and the worker (defensive validation) all share it.
//
// The worker holds the actual *implementations*; this package only describes the
// contract.

export type FieldType = 'url' | 'string' | 'text' | 'select' | 'int' | 'keyval' | 'sql';

export interface HandlerField {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** Value may embed `{{secret:NAME}}` references resolved by the worker. */
  secret?: boolean;
  /** For `select`. */
  options?: string[];
  default?: string | number;
}

export interface HandlerDef {
  key: string;
  label: string;
  description: string;
  fields: HandlerField[];
}

export const HANDLER_CATALOG: HandlerDef[] = [
  {
    key: 'http.request',
    label: 'HTTP Request',
    description: 'Call any HTTP(S) URL. Blocked from internal/metadata addresses (SSRF-safe).',
    fields: [
      { name: 'url', label: 'URL', type: 'url', required: true, placeholder: 'https://api.example.com/run' },
      { name: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], default: 'GET' },
      { name: 'headers', label: 'Headers', type: 'keyval', secret: true, help: 'Values may use {{secret:NAME}}.' },
      { name: 'body', label: 'Body (JSON)', type: 'text', secret: true, placeholder: '{ "hello": "world" }' },
    ],
  },
  {
    key: 'webhook',
    label: 'Signed Webhook',
    description: 'POST a JSON body to a URL with an HMAC-SHA256 signature header (x-cronapp-signature).',
    fields: [
      { name: 'url', label: 'URL', type: 'url', required: true, placeholder: 'https://hooks.example.com/ingest' },
      { name: 'secret', label: 'Signing secret', type: 'string', secret: true, required: true, placeholder: '{{secret:WEBHOOK_SIGNING_KEY}}', help: 'Used to HMAC-sign the body. Use a {{secret:NAME}} reference.' },
      { name: 'body', label: 'Payload (JSON)', type: 'text', secret: true, placeholder: '{ "event": "nightly" }' },
    ],
  },
  {
    key: 'email',
    label: 'Email',
    description: 'Send an email via SMTP. In dev (no SMTP configured) the composed message is recorded instead of sent.',
    fields: [
      { name: 'to', label: 'To', type: 'string', required: true, placeholder: 'ops@example.com' },
      { name: 'subject', label: 'Subject', type: 'string', required: true, placeholder: 'Nightly report ready' },
      { name: 'text', label: 'Body (text)', type: 'text', placeholder: 'The nightly job finished.' },
      { name: 'html', label: 'Body (HTML)', type: 'text', help: 'Optional. Takes precedence over the text body when set.' },
    ],
  },
  {
    key: 'db.query',
    label: 'Database Query',
    description: 'Run a read-only SQL SELECT over your own data (fenced to your tenant, restricted to Job & JobRun).',
    fields: [
      { name: 'sql', label: 'SQL (SELECT only)', type: 'sql', required: true, placeholder: 'SELECT status, count(*) FROM "JobRun" GROUP BY status' },
    ],
  },
];

export const HANDLER_KEYS = HANDLER_CATALOG.map((h) => h.key);

export function getHandler(key: string): HandlerDef | undefined {
  return HANDLER_CATALOG.find((h) => h.key === key);
}

function looksLikeUrl(v: unknown): boolean {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim());
}

/**
 * Validate a payload against its handler's schema. Returns an error message, or
 * null when the payload is acceptable. Deliberately lightweight — deep checks
 * (SSRF, SQL read-only enforcement) happen in the worker at run time.
 */
export function validatePayload(handlerKey: string, payload: unknown): string | null {
  const def = getHandler(handlerKey);
  if (!def) return `Unknown handler "${handlerKey}"`;
  const p = (payload ?? {}) as Record<string, unknown>;

  for (const f of def.fields) {
    const v = p[f.name];
    const present = v !== undefined && v !== null && v !== '';
    if (f.required && !present) return `${def.label}: "${f.label}" is required`;
    if (!present) continue;

    switch (f.type) {
      case 'url':
        if (!looksLikeUrl(v)) return `${def.label}: "${f.label}" must be an http(s) URL`;
        break;
      case 'int':
        if (!Number.isInteger(typeof v === 'string' ? Number(v) : v)) return `${def.label}: "${f.label}" must be a whole number`;
        break;
      case 'keyval':
        if (typeof v !== 'object' || Array.isArray(v)) return `${def.label}: "${f.label}" must be an object of key/value pairs`;
        break;
      case 'select':
        if (f.options && !f.options.includes(String(v))) return `${def.label}: "${f.label}" must be one of ${f.options.join(', ')}`;
        break;
      case 'string':
      case 'text':
      case 'sql':
        if (typeof v !== 'string') return `${def.label}: "${f.label}" must be text`;
        break;
    }
  }
  return null;
}
