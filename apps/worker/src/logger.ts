/** Structured (JSON-lines) logging for the worker, so run events can be
 *  correlated by runId/jobId in a log aggregator. */
export function logJson(fields: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'worker', ...fields }) + '\n');
  } catch {
    /* logging must never throw */
  }
}
