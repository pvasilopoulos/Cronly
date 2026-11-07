import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpNow,
  verifyTotp,
  otpauthUri,
  generateBackupCodes,
} from '../src/auth/totp';

test('base32 round-trips arbitrary bytes', () => {
  for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', '12345678901234567890']) {
    const buf = Buffer.from(s);
    assert.deepEqual(base32Decode(base32Encode(buf)), buf, `round-trip failed for "${s}"`);
  }
});

test('base32Decode rejects characters outside the alphabet', () => {
  assert.throws(() => base32Decode('01890!'), /Invalid base32/);
});

test('generateTotpSecret is a 32-char base32 string (160 bits)', () => {
  const secret = generateTotpSecret();
  assert.equal(secret.length, 32);
  assert.match(secret, /^[A-Z2-7]+$/);
});

test('matches the RFC 6238 test vector (truncated to 6 digits)', () => {
  // RFC 6238 uses ASCII secret "12345678901234567890" with SHA-1. At T=59s the
  // 8-digit code is 94287082; truncated to 6 digits that is 287082.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpNow(secret, 59_000), '287082');
});

test('a freshly generated code verifies at the same instant', () => {
  const secret = generateTotpSecret();
  const at = 1_700_000_000_000;
  assert.equal(verifyTotp(secret, totpNow(secret, at), 1, at), true);
});

test('verifyTotp tolerates ±1 period of clock drift but not more', () => {
  const secret = generateTotpSecret();
  const at = 1_700_000_000_000;
  const prev = totpNow(secret, at - 30_000);
  const next = totpNow(secret, at + 30_000);
  assert.equal(verifyTotp(secret, prev, 1, at), true, 'previous period accepted');
  assert.equal(verifyTotp(secret, next, 1, at), true, 'next period accepted');
  // Two periods away must be rejected with the default window of 1.
  const far = totpNow(secret, at + 60_000);
  assert.equal(verifyTotp(secret, far, 1, at), false, 'two periods away rejected');
});

test('verifyTotp rejects malformed and wrong codes', () => {
  const secret = generateTotpSecret();
  const at = 1_700_000_000_000;
  assert.equal(verifyTotp(secret, '', 1, at), false);
  assert.equal(verifyTotp(secret, 'abcdef', 1, at), false);
  assert.equal(verifyTotp(secret, '12345', 1, at), false); // too short
  const wrong = totpNow(secret, at) === '000000' ? '000001' : '000000';
  assert.equal(verifyTotp(secret, wrong, 1, at), false);
});

test('otpauthUri encodes issuer, account and parameters', () => {
  const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'petros@acme.gr');
  // The label is URL-encoded as a whole, so the issuer:account separator is %3A.
  assert.match(uri, /^otpauth:\/\/totp\/CronApp%3Apetros%40acme\.gr\?/);
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
  assert.match(uri, /issuer=CronApp/);
  assert.match(uri, /algorithm=SHA1/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
});

test('generateBackupCodes returns the requested count in xxxx-xxxx form', () => {
  const codes = generateBackupCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10, 'codes are unique');
  for (const c of codes) assert.match(c, /^[0-9a-f]{4}-[0-9a-f]{4}$/);
});
