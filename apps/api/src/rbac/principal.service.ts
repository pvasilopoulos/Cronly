import { ForbiddenException, Injectable } from '@nestjs/common';
import { jsonArray } from '@cronapp/database';
import {
  buildAbility,
  computeEffectivePermissions,
  EffectivePermission,
  type AppAbility,
} from '@cronapp/rbac';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/jwt.strategy';

export interface Principal {
  userId: string;
  tenantId: string;
  isSuperAdmin: boolean;
  membershipId?: string;
  permissions: EffectivePermission[];
  keys: Set<string>;
  ability: AppAbility;
}

@Injectable()
export class PrincipalService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve a user's effective access inside one tenant. Combines the roles the
   * membership holds, its per-user overrides, and the tenant's enabled features,
   * then builds a CASL ability. Throws if the user is not a member.
   */
  async load(user: AuthUser, tenantId: string): Promise<Principal> {
    if (user.isSuperAdmin) {
      const tenant = await this.prisma.asSuperAdmin((tx) =>
        tx.tenant.findUnique({ where: { id: tenantId } }),
      );
      if (!tenant) throw new ForbiddenException('Unknown tenant');
      const permissions = computeEffectivePermissions({
        rolePermissions: [],
        tenantFeatures: jsonArray(tenant.features),
        isSuperAdmin: true,
      });
      return {
        userId: user.userId,
        tenantId,
        isSuperAdmin: true,
        permissions,
        keys: new Set(permissions.map((p) => p.key)),
        ability: buildAbility(permissions),
      };
    }

    const data = await this.prisma.forTenant(tenantId, async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { userId: user.userId, tenantId, status: 'ACTIVE' },
        include: { roles: { include: { role: { include: { permissions: true } } } }, overrides: true },
      });
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      return { membership, tenant };
    });

    if (!data.membership || !data.tenant) {
      throw new ForbiddenException('Not a member of this tenant');
    }

    const rolePermissions = data.membership.roles.flatMap((mr) =>
      mr.role.permissions.map((p) => ({
        permission: p.permission,
        conditions: (p.conditions as Record<string, unknown> | null) ?? null,
      })),
    );
    const overrides = data.membership.overrides.map((o) => ({
      permission: o.permission,
      effect: o.effect as 'GRANT' | 'DENY',
      conditions: (o.conditions as Record<string, unknown> | null) ?? null,
    }));

    const permissions = computeEffectivePermissions({
      rolePermissions,
      overrides,
      tenantFeatures: jsonArray(data.tenant.features),
    });

    return {
      userId: user.userId,
      tenantId,
      isSuperAdmin: false,
      membershipId: data.membership.id,
      permissions,
      keys: new Set(permissions.map((p) => p.key)),
      ability: buildAbility(permissions),
    };
  }

  /**
   * Build a principal for an API-key request. The key already pins a tenant and
   * carries a fixed scope list; those scopes are still intersected with the
   * tenant's plan features (a disabled feature's permission is dropped), so a key
   * can never outlive a plan downgrade.
   */
  async loadFromScopes(userId: string, tenantId: string, scopes: string[]): Promise<Principal> {
    const tenant = await this.prisma.asSuperAdmin((tx) =>
      tx.tenant.findUnique({ where: { id: tenantId } }),
    );
    if (!tenant) throw new ForbiddenException('Unknown tenant');

    const permissions = computeEffectivePermissions({
      rolePermissions: scopes.map((s) => ({ permission: s, conditions: null })),
      tenantFeatures: jsonArray(tenant.features),
    });

    return {
      userId,
      tenantId,
      isSuperAdmin: false,
      permissions,
      keys: new Set(permissions.map((p) => p.key)),
      ability: buildAbility(permissions),
    };
  }
}
