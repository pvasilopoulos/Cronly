import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAbility } from '../src/ability';
import { computeEffectivePermissions } from '../src/effective';

test('ability allows granted actions and forbids the rest', () => {
  const ability = buildAbility(
    computeEffectivePermissions({
      rolePermissions: [{ permission: 'jobs:read' }, { permission: 'jobs:run' }],
      tenantFeatures: [],
    }),
  );
  assert.ok(ability.can('read', 'jobs'));
  assert.ok(ability.can('run', 'jobs'));
  assert.ok(ability.cannot('delete', 'jobs'));
  assert.ok(ability.cannot('read', 'billing'));
});

test('conditional grant narrows which rows the ability permits', () => {
  const ability = buildAbility(
    computeEffectivePermissions({
      rolePermissions: [{ permission: 'jobs:read', conditions: { tag: 'billing' } }],
      tenantFeatures: [],
    }),
  );
  // The rule for read/jobs carries the narrowing condition, so the ability
  // answers "which rows?" and not just "may they read jobs at all?".
  const rule = ability.relevantRuleFor('read', 'jobs');
  assert.ok(rule, 'a rule exists for read jobs');
  assert.deepEqual(rule?.conditions, { tag: 'billing' });
});

test('super-admin ability can do everything', () => {
  const ability = buildAbility(
    computeEffectivePermissions({ rolePermissions: [], tenantFeatures: [], isSuperAdmin: true }),
  );
  assert.ok(ability.can('manage', 'billing'));
  assert.ok(ability.can('delete', 'jobs'));
  assert.ok(ability.can('manage', 'roles'));
});
