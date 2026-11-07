import { getPrisma, decryptSecret } from '@cronapp/database';

// Resolve {{secret:NAME}} placeholders in a job payload at execution time.
// Secrets are decrypted only here, in the trusted worker, and the resolved
// payload is passed to the handler and never persisted.

const SECRET_RE = /\{\{\s*secret:([A-Za-z0-9_.\-]+)\s*\}\}/g;

export async function resolvePayloadSecrets(tenantId: string, payload: unknown): Promise<unknown> {
  const json = JSON.stringify(payload ?? {});
  const names = new Set<string>();
  for (const m of json.matchAll(SECRET_RE)) names.add(m[1]);
  if (names.size === 0) return payload;

  const prisma = getPrisma();
  const rows = await prisma.secret.findMany({
    where: { tenantId, name: { in: [...names] } },
  });

  const values = new Map<string, string>();
  for (const s of rows) {
    values.set(
      s.name,
      decryptSecret({
        ciphertext: Buffer.from(s.ciphertext as Uint8Array),
        iv: Buffer.from(s.iv as Uint8Array),
        authTag: Buffer.from(s.authTag as Uint8Array),
      }),
    );
  }
  for (const n of names) {
    if (!values.has(n)) throw new Error(`secret "${n}" is not defined for this tenant`);
  }

  // Substitute within the JSON text; JSON.stringify(value).slice(1,-1) yields a
  // correctly-escaped fragment safe to drop inside an existing JSON string.
  const resolved = json.replace(SECRET_RE, (_all, name: string) =>
    JSON.stringify(values.get(name)!).slice(1, -1),
  );
  return JSON.parse(resolved);
}
