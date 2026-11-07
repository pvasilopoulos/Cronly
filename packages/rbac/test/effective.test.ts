import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEffectivePermissions,
  effectiveKeys,
} from '../src/effective';
import { ALL_PERMISSION_KEYS, getRoleTemplate } from '../src/permissions';

const PRO = ['responses.export', 'audit.log']; // PRO plan features
const NONE: string[] = [];

test('role permissions are unioned across roles', () => {
  const keys = effectiveKeys({
    rolePermissions: [{ permission: 'jobs:read' }, { permission: 'runs:read' }, { permission: 'jobs:read' }],
    tenantFeatures: NONE,
  });
  assert.deepEqual([...keys].sort(), ['jobs:read', 'runs:read']);
});

test('GRANT override adds a permission the roles lack', () => {
  const keys = effectiveKeys({
    rolePermissions: [{ permission: 'jobs:read' }],
    overrides: [{ permission: 'jobs:run', effect: 'GRANT' }],
    tenantFeatures: NONE,
  });
  assert.ok(keys.has('jobs:run'));
});

test('DENY override wins over both roles and GRANTs', () => {
  const keys = effectiveKeys({
    rolePermissions: [{ permission: 'responses:read' }],
    overrides: [
      { permission: 'responses:read', effect: 'GRANT' }, // even an explicit grant...
      { permission: 'responses:read', effect: 'DENY' },  // ...is beaten by DENY
    ],
    tenantFeatures: NONE,
  });
  assert.ok(!keys.has('responses:read'), 'DENY must remove the permission');
});

test('feature gating hides a permission when the plan lacks the feature', () => {
  // responses:download requires feature "responses.export"
  const withoutFeature = effectiveKeys({
    rolePermissions: [{ permission: 'responses:download' }],
    tenantFeatures: NONE,
  });
  assert.ok(!withoutFeature.has('responses:download'), 'gated off on a plan without the feature');

  const withFeature = effectiveKeys({
    rolePermissions: [{ permission: 'responses:download' }],
    tenantFeatures: PRO,
  });
  assert.ok(withFeature.has('responses:download'), 'granted once the plan enables it');
});

test('a plan downgrade instantly hides gated capabilities regardless of role', () => {
  // The Owner template holds every key, but billing/audit are feature-gated.
  const owner = getRoleTemplate('owner')!;
  const starter = effectiveKeys({
    rolePermissions: owner.permissions.map((permission) => ({ permission })),
    tenantFeatures: NONE, // STARTER
  });
  assert.ok(!starter.has('billing:manage'), 'billing gated off on STARTER');
  assert.ok(!starter.has('audit:read'), 'audit gated off on STARTER');
  assert.ok(starter.has('jobs:update'), 'ungated permissions remain');
});

test('super-admin short-circuits to every permission, unconditional', () => {
  const perms = computeEffectivePermissions({
    rolePermissions: [],
    tenantFeatures: NONE,
    isSuperAdmin: true,
  });
  assert.equal(perms.length, ALL_PERMISSION_KEYS.length);
  assert.ok(perms.every((p) => p.conditions === undefined));
});

test('a single condition is preserved on the effective permission', () => {
  const perms = computeEffectivePermissions({
    rolePermissions: [{ permission: 'jobs:read', conditions: { tags: { $in: ['billing'] } } }],
    tenantFeatures: NONE,
  });
  const jobsRead = perms.find((p) => p.key === 'jobs:read')!;
  assert.deepEqual(jobsRead.conditions, { tags: { $in: ['billing'] } });
});

test('two conditional grants for the same key merge into an $or', () => {
  const perms = computeEffectivePermissions({
    rolePermissions: [
      { permission: 'jobs:read', conditions: { tags: { $in: ['billing'] } } },
      { permission: 'jobs:read', conditions: { tags: { $in: ['ops'] } } },
    ],
    tenantFeatures: NONE,
  });
  const jobsRead = perms.find((p) => p.key === 'jobs:read')!;
  assert.deepEqual(jobsRead.conditions, {
    $or: [{ tags: { $in: ['billing'] } }, { tags: { $in: ['ops'] } }],
  });
});

test('an unconditional grant overrides a conditional one (full access wins)', () => {
  const perms = computeEffectivePermissions({
    rolePermissions: [
      { permission: 'jobs:read', conditions: { tags: { $in: ['billing'] } } },
      { permission: 'jobs:read' }, // unconditional from another role
    ],
    tenantFeatures: NONE,
  });
  const jobsRead = perms.find((p) => p.key === 'jobs:read')!;
  assert.equal(jobsRead.conditions, undefined, 'unconditional access is not narrowed');
});

test('unknown permission keys are ignored', () => {
  const keys = effectiveKeys({
    rolePermissions: [{ permission: 'jobs:read' }, { permission: 'ghost:action' }],
    tenantFeatures: NONE,
  });
  assert.ok(keys.has('jobs:read'));
  assert.ok(!keys.has('ghost:action'));
});

test('role templates: operator can run jobs but cannot manage billing or roles', () => {
  const operator = getRoleTemplate('operator')!;
  const keys = new Set(operator.permissions);
  assert.ok(keys.has('jobs:run'));
  assert.ok(!keys.has('billing:manage'));
  assert.ok(!keys.has('roles:manage'));
});

test('role templates: read-only viewer holds only read keys', () => {
  const viewer = getRoleTemplate('viewer')!;
  assert.deepEqual([...viewer.permissions].sort(), ['jobs:read', 'runs:read']);
});
