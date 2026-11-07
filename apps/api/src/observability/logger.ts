/** Minimal structured (JSON-lines) logger — one object per line to stdout, so a
 *  log shipper (Loki, CloudWatch, Datadog) can parse fields without a regex. */
export function logJson(fields: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n');
  } catch {
    /* logging must never throw */
  }
}
