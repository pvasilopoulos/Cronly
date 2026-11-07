/** Structured (JSON-lines) logging for the scheduler. */
export function logJson(fields: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'scheduler', ...fields }) + '\n');
  } catch {
    /* logging must never throw */
  }
}
