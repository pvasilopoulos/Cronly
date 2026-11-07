import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_QUOTAS,
  QUOTA_LABELS,
  quotaForPlan,
  isUnlimited,
  UNLIMITED,
  defaultFeaturesForPlan,
  PLAN_FEATURES,
  ALL_PERMISSION_KEYS,
  getPermission,
} from '../src/index';

test('every known plan has a complete quota with the four keys', () => {
  for (const plan of ['STARTER', 'PRO', 'SCALE', 'ENTERPRISE']) {
    const q = PLAN_QUOTAS[plan];
    assert.ok(q, `missing quota for ${plan}`);
    for (const key of ['maxJobs', 'maxMembers', 'maxChannels', 'maxConcurrency'] as const) {
      assert.equal(typeof q[key], 'number', `${plan}.${key} should be a number`);
    }
  }
});

test('quotas scale up by tier and ENTERPRISE is unlimited', () => {
  assert.ok(PLAN_QUOTAS.STARTER.maxJobs < PLAN_QUOTAS.PRO.maxJobs);
  assert.ok(PLAN_QUOTAS.PRO.maxJobs < PLAN_QUOTAS.SCALE.maxJobs);
  assert.equal(PLAN_QUOTAS.ENTERPRISE.maxJobs, UNLIMITED);
  assert.ok(isUnlimited(PLAN_QUOTAS.ENTERPRISE.maxConcurrency));
});

test('quotaForPlan falls back to STARTER for an unknown plan', () => {
  assert.deepEqual(quotaForPlan('MYSTERY'), PLAN_QUOTAS.STARTER);
  assert.deepEqual(quotaForPlan('SCALE'), PLAN_QUOTAS.SCALE);
});

test('isUnlimited is true only for negative caps', () => {
  assert.equal(isUnlimited(-1), true);
  assert.equal(isUnlimited(0), false);
  assert.equal(isUnlimited(5), false);
});

test('every quota key has a human label', () => {
  for (const key of ['maxJobs', 'maxMembers', 'maxChannels', 'maxConcurrency'] as const) {
    assert.ok(QUOTA_LABELS[key] && QUOTA_LABELS[key].length > 0);
  }
});

test('feature sets are additive from STARTER up to ENTERPRISE', () => {
  assert.deepEqual(defaultFeaturesForPlan('STARTER'), []);
  // Each higher tier includes everything the tier below it has.
  const chain = ['STARTER', 'PRO', 'SCALE', 'ENTERPRISE'];
  for (let i = 1; i < chain.length; i++) {
    const lower = new Set(PLAN_FEATURES[chain[i - 1]]);
    const higher = new Set(PLAN_FEATURES[chain[i]]);
    for (const f of lower) assert.ok(higher.has(f), `${chain[i]} should include ${f}`);
  }
});

test('the entitlements permissions exist in the catalog', () => {
  assert.ok(ALL_PERMISSION_KEYS.includes('entitlements:read'));
  assert.ok(ALL_PERMISSION_KEYS.includes('entitlements:manage'));
  const manage = getPermission('entitlements:manage');
  assert.equal(manage?.resource, 'entitlements');
  assert.equal(manage?.action, 'manage');
});
