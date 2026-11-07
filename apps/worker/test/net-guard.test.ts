import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, assertSafeUrl, BlockedUrlError } from '../src/net-guard';

test('blocks loopback, private, link-local and CGNAT IPv4', () => {
  for (const ip of [
    '127.0.0.1',
    '127.1.2.3',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',      // CGNAT
    '0.0.0.0',
    '224.0.0.1',       // multicast
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test('allows public IPv4', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1']) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test('blocks loopback, ULA and link-local IPv6', () => {
  for (const ip of ['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test('allows public IPv6', () => {
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
  assert.equal(isBlockedIp('2001:4860:4860::8888'), false);
});

test('assertSafeUrl rejects non-http schemes', async () => {
  await assert.rejects(() => assertSafeUrl('ftp://example.com'), BlockedUrlError);
  await assert.rejects(() => assertSafeUrl('file:///etc/passwd'), BlockedUrlError);
  await assert.rejects(() => assertSafeUrl('gopher://example.com'), BlockedUrlError);
});

test('assertSafeUrl rejects IP-literal targets at private/metadata addresses', async () => {
  await assert.rejects(() => assertSafeUrl('http://169.254.169.254/latest/meta-data'), BlockedUrlError);
  await assert.rejects(() => assertSafeUrl('http://127.0.0.1:5432/'), BlockedUrlError);
  await assert.rejects(() => assertSafeUrl('http://[::1]/'), BlockedUrlError);
  await assert.rejects(() => assertSafeUrl('http://192.168.0.5/admin'), BlockedUrlError);
});

test('assertSafeUrl allows a public IP literal', async () => {
  const url = await assertSafeUrl('http://1.1.1.1/');
  assert.equal(url.hostname, '1.1.1.1');
});
