import {
  defaultTemplate,
  renderFields,
  type TemplateChannel,
  type TemplateContext,
} from '@cronapp/templating';

// Worker-side template resolution. The tenant's MessageTemplate overrides are
// fetched once per alert flow (see alerts.ts / heartbeat.ts) and passed in here
// as rows; this stays a pure function so rendering never hits the database.

export interface TemplateRow {
  event: string;
  channel: string;
  subject: string | null;
  body: string;
  enabled: boolean;
}

export type { TemplateContext };

/**
 * Render one event×channel message. Uses the tenant's enabled override when one
 * exists, otherwise the built-in default copy, then substitutes {{ variables }}.
 */
export function renderFromRows(
  rows: TemplateRow[],
  event: string,
  channel: TemplateChannel,
  ctx: TemplateContext,
): { subject: string | null; body: string } {
  const override = rows.find((r) => r.event === event && r.channel === channel && r.enabled);
  const fields = override ? { subject: override.subject, body: override.body } : defaultTemplate(event, channel);
  if (!fields) return { subject: null, body: '' };
  const out = renderFields(fields, ctx, channel);
  return { subject: out.subject ?? null, body: out.body };
}
