import {
  ALL_PERMISSION_KEYS,
  getPermission,
  PermissionKey,
} from './permissions';

export interface GrantInput {
  permission: string;
  conditions?: Record<string, unknown> | null;
}

export interface OverrideInput {
  permission: string;
  effect: 'GRANT' | 'DENY';
  conditions?: Record<string, unknown> | null;
}

export interface EffectivePermission {
  key: PermissionKey;
  /** CASL conditions narrowing which rows the holder may act on. Undefined = all. */
  conditions?: Record<string, unknown>;
}

export interface EffectiveInput {
  /** Flattened permissions from every role the membership holds. */
  rolePermissions: GrantInput[];
  /** Per-user GRANT/DENY tweaks. */
  overrides?: OverrideInput[];
  /** Features the tenant's plan enables. */
  tenantFeatures: string[];
  isSuperAdmin?: boolean;
}

/**
 * Resolve the final permission set for a principal inside one tenant.
 *
 * Precedence, lowest to highest:
 *   1. role permissions (unioned; conditions combined with $or)
 *   2. GRANT overrides (add)
 *   3. DENY overrides   (remove — always wins)
 *   4. tenant feature gating (a permission needing a disabled feature is dropped)
 * Super-admins short-circuit to every permission, unconditional.
 */
export function computeEffectivePermissions(input: EffectiveInput): EffectivePermission[] {
  if (input.isSuperAdmin) {
    return ALL_PERMISSION_KEYS.map((key) => ({ key }));
  }

  const grants = new Map<string, { unconditional: boolean; conditions: Record<string, unknown>[] }>();

  const add = (permission: string, conditions?: Record<string, unknown> | null) => {
    const entry = grants.get(permission) ?? { unconditional: false, conditions: [] };
    if (!conditions || Object.keys(conditions).length === 0) {
      entry.unconditional = true;
    } else {
      entry.conditions.push(conditions);
    }
    grants.set(permission, entry);
  };

  for (const rp of input.rolePermissions) add(rp.permission, rp.conditions);

  for (const ov of input.overrides ?? []) {
    if (ov.effect === 'GRANT') add(ov.permission, ov.conditions);
  }
  // DENY wins over everything.
  for (const ov of input.overrides ?? []) {
    if (ov.effect === 'DENY') grants.delete(ov.permission);
  }

  const features = new Set(input.tenantFeatures);
  const result: EffectivePermission[] = [];

  for (const [key, entry] of grants) {
    const def = getPermission(key as PermissionKey);
    if (!def) continue; // unknown key (e.g. removed from catalog) — ignore
    if (def.requiresFeature && !features.has(def.requiresFeature)) continue; // gated off

    if (entry.unconditional || entry.conditions.length === 0) {
      result.push({ key: key as PermissionKey });
    } else if (entry.conditions.length === 1) {
      result.push({ key: key as PermissionKey, conditions: entry.conditions[0] });
    } else {
      result.push({ key: key as PermissionKey, conditions: { $or: entry.conditions } });
    }
  }

  return result;
}

/** Convenience: the plain set of permission keys the principal holds. */
export function effectiveKeys(input: EffectiveInput): Set<string> {
  return new Set(computeEffectivePermissions(input).map((p) => p.key));
}
