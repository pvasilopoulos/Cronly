import { BadRequestException, Controller, Get, Headers } from '@nestjs/common';
import { PERMISSIONS, FEATURES } from '@cronapp/rbac';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { PrincipalService } from '../rbac/principal.service';

@Controller('me')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principals: PrincipalService,
  ) {}

  /** Profile + the tenants this user may act in. Tenant-agnostic. */
  @Get()
  async me(@CurrentUser() user: AuthUser) {
    const u = await this.prisma.asSuperAdmin((tx) =>
      tx.user.findUnique({
        where: { id: user.userId },
        include: {
          memberships: {
            where: { status: 'ACTIVE' },
            include: { tenant: { select: { id: true, name: true, slug: true, plan: true } } },
          },
        },
      }),
    );
    if (!u) throw new BadRequestException('User not found');
    const memberTenants = u.memberships.map((m) => m.tenant);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      isSuperAdmin: u.isSuperAdmin,
      // Platform super-admins can act in any workspace, so surface them all
      // (their own memberships first); regular users see only their memberships.
      tenants: await this.tenantsFor(u.isSuperAdmin, memberTenants),
    };
  }

  /** Membership tenants, plus every tenant when the user is a super-admin. */
  private async tenantsFor(
    isSuperAdmin: boolean,
    memberTenants: { id: string; name: string; slug: string; plan: string }[],
  ) {
    if (!isSuperAdmin) return memberTenants;
    const all = await this.prisma.asSuperAdmin((tx) =>
      tx.tenant.findMany({
        select: { id: true, name: true, slug: true, plan: true },
        orderBy: { name: 'asc' },
      }),
    );
    const seen = new Set(memberTenants.map((t) => t.id));
    return [...memberTenants, ...all.filter((t) => !seen.has(t.id))];
  }

  /**
   * What this user can do and see in the active tenant. The frontend uses
   * `keys` to show/hide controls and `permissions[].conditions` to scope lists,
   * and `catalog` to render the permission matrix.
   */
  @Get('permissions')
  async permissions(@CurrentUser() user: AuthUser, @Headers('x-tenant-id') tenantId?: string) {
    if (!tenantId) throw new BadRequestException('Missing x-tenant-id header');
    const p = await this.principals.load(user, tenantId);
    return {
      tenantId,
      isSuperAdmin: p.isSuperAdmin,
      keys: [...p.keys],
      permissions: p.permissions,
      catalog: PERMISSIONS,
      features: FEATURES,
    };
  }
}
