import { AbilityBuilder, createMongoAbility, MongoAbility } from '@casl/ability';
import { EffectivePermission } from './effective';
import { getPermission, PermissionKey } from './permissions';

// CASL action + subject. Subjects are our resource names ("jobs", "runs", …).
export type AppAbility = MongoAbility<[string, string]>;

/**
 * Build a CASL ability from a principal's effective permissions. Each
 * "resource:action" key becomes `can(action, resource, conditions?)`, so the
 * same object answers both "may this user do X?" and "which rows may they see?"
 * (via accessibleBy / condition matching).
 */
export function buildAbility(permissions: EffectivePermission[]): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  for (const perm of permissions) {
    const def = getPermission(perm.key);
    if (!def) continue;
    if (perm.conditions) {
      // Conditions are opaque Mongo-style queries; CASL's generic subject type
      // can't narrow them, so pass through as-is.
      can(def.action, def.resource, perm.conditions as never);
    } else {
      can(def.action, def.resource);
    }
  }

  return build();
}

/** Does a flat key set allow this permission? Cheap check for guards. */
export function hasPermission(keys: Set<string>, key: PermissionKey): boolean {
  return keys.has(key);
}
