// Envelope encryption for tenant secrets. AES-256-GCM with a master key from
// the SECRETS_KEY env var (base64-encoded 32 bytes). The ciphertext, 12-byte IV
// and 16-byte auth tag are stored separately on the Secret row; plaintext never
// touches the database and is never returned by the API.
//
// Key rotation: re-encrypt all secrets under a new key via a maintenance script
// (tracked in ROADMAP). A versioned key id can be added to the blob when needed.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

function masterKey(): Buffer {
  const raw = process.env.SECRETS_KEY;
  if (!raw) {
    throw new Error('SECRETS_KEY is not set (base64-encoded 32 bytes required)');
  }
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) {
    throw new Error('SECRETS_KEY must decode to exactly 32 bytes');
  }
  return k;
}

export interface EncryptedBlob {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export function encryptSecret(plaintext: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

export function decryptSecret(blob: EncryptedBlob): string {
  const decipher = createDecipheriv(ALGO, masterKey(), blob.iv);
  decipher.setAuthTag(blob.authTag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]).toString('utf8');
}

/** A safe-to-display hint (never the full value). */
export function secretHint(plaintext: string): string {
  if (plaintext.length <= 4) return '••••';
  return `••••${plaintext.slice(-4)}`;
}
