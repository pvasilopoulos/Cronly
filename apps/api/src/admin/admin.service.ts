import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  ROLE_TEMPLATES,
  defaultFeaturesForPlan,
  type PermissionKey,
} from '@cronapp/rbac';
import { Prisma } from '@cronapp/database';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { hashPassword } from '../auth/password';

const PLANS = ['STARTER', 'PRO', 'SCALE', 'ENTERPRISE'] as const;
type Plan = (typeof PLANS)[number];
const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED', 'TRIAL'] as const;
const USER_STATUSES = ['ACTIVE', 'INVITED', 'DISABLED'] as const;

function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export interface CreateTenantInput {
  name: string;
  slug?: string;
  plan?: Plan;
  timezone?: string;
}
export interface UpdateTenantInput {
  name?: string;
  plan?: Plan;
  status?: (typeof TENANT_STATUSES)[number];
  timezone?: string;
  features?: string[];
}
export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  isSuperAdmin?: boolean;
}
export interface UpdateUserInput {
  name?: string;
  status?: (typeof USER_STATUSES)[number];
  isSuperAdmin?: boolean;
  password?: string;
}

/**
 * Platform console backend. Every method runs with RLS bypassed
 * (`asSuperAdmin`) because the console is explicitly cross-tenant; the
 * controller's SuperAdminGuard is the only thing standing between these methods
 * and the outside world, so it must never be bypassed.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── Tenants ─────────────────────────────

  listTenants() {
    return this.prisma.asSuperAdmin(async (tx) => {
      const tenants = await tx.tenant.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          _count: { select: { memberships: true, jobs: true, roles: true } },
        },
      });
      return tenants.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        plan: t.plan,
        status: t.status,
        timezone: t.timezone,
        features: t.features,
        createdAt: t.createdAt,
        counts: {
          members: t._count.memberships,
          jobs: t._count.jobs,
          roles: t._count.roles,
        },
      }));
    });
  }

  async createTenant(actorUserId: string, input: CreateTenantInput) {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Name is required');
    const slug = normalizeSlug(input.slug || name);
    if (!slug) throw new BadRequestException('Could not derive a valid slug');
    const plan: Plan = input.plan && PLANS.includes(input.plan) ? input.plan : 'STARTER';

    const tenant = await this.prisma.asSuperAdmin(async (tx) => {
      const clash = await tx.tenant.findUnique({ where: { slug } });
      if (clash) throw new ConflictException(`A workspace with slug "${slug}" already exists`);

      const created = await tx.tenant.create({
        data: {
          name,
          slug,
          plan,
          status: 'ACTIVE',
          timezone: input.timezone?.trim() || 'Europe/Athens',
          features: defaultFeaturesForPlan(plan),
        },
      });
      // Seed the standard role set so the workspace is usable immediately.
      for (const tpl of ROLE_TEMPLATES) {
        await tx.role.create({
          data: {
            tenantId: created.id,
            key: tpl.key,
            name: tpl.name,
            description: tpl.description,
            isSystem: true,
            permissions: { create: tpl.permissions.map((permission: PermissionKey) => ({ permission })) },
          },
        });
      }
      return created;
    });

    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'tenant.created',
      target: tenant.id,
      meta: { name: tenant.name, slug: tenant.slug, plan: tenant.plan },
    });
    return tenant;
  }

  async updateTenant(actorUserId: string, id: string, input: UpdateTenantInput) {
    if (input.plan && !PLANS.includes(input.plan)) throw new BadRequestException('Unknown plan');
    if (input.status && !TENANT_STATUSES.includes(input.status)) throw new BadRequestException('Unknown status');

    const updated = await this.prisma.asSuperAdmin(async (tx) => {
      const existing = await tx.tenant.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Workspace not found');
      const data: Prisma.TenantUpdateInput = {};
      if (input.name !== undefined) data.name = input.name.trim();
      if (input.timezone !== undefined) data.timezone = input.timezone.trim();
      if (input.status !== undefined) data.status = input.status;
      if (input.plan !== undefined) {
        data.plan = input.plan;
        // A plan change resets feature gating to that plan's defaults unless the
        // caller is explicitly overriding features in the same request.
        if (input.features === undefined) data.features = defaultFeaturesForPlan(input.plan);
      }
      if (input.features !== undefined) data.features = input.features;
      return tx.tenant.update({ where: { id }, data });
    });

    await this.audit.record({
      tenantId: id,
      actorUserId,
      action: 'tenant.updated',
      target: id,
      meta: {
        ...(input.name !== undefined ? { name: updated.name } : {}),
        ...(input.plan !== undefined ? { plan: updated.plan } : {}),
        ...(input.status !== undefined ? { status: updated.status } : {}),
      },
    });
    return updated;
  }

  async deleteTenant(id: string) {
    await this.prisma.asSuperAdmin(async (tx) => {
      const existing = await tx.tenant.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Workspace not found');
      // Cascades remove memberships, roles, jobs, runs, audit logs, etc.
      await tx.tenant.delete({ where: { id } });
    });
    return { ok: true };
  }

  // ────────────────────────────── Users ──────────────────────────────

  listUsers() {
    return this.prisma.asSuperAdmin(async (tx) => {
      const users = await tx.user.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          email: true,
          name: true,
          status: true,
          isSuperAdmin: true,
          createdAt: true,
          _count: { select: { memberships: true } },
        },
      });
      return users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        status: u.status,
        isSuperAdmin: u.isSuperAdmin,
        createdAt: u.createdAt,
        memberships: u._count.memberships,
      }));
    });
  }

  async createUser(input: CreateUserInput) {
    const email = input.email?.trim().toLowerCase();
    if (!email) throw new BadRequestException('Email is required');
    if (!input.name?.trim()) throw new BadRequestException('Name is required');
    if (!input.password || input.password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    const user = await this.prisma.asSuperAdmin(async (tx) => {
      const clash = await tx.user.findUnique({ where: { email } });
      if (clash) throw new ConflictException('A user with that email already exists');
      return tx.user.create({
        data: {
          email,
          name: input.name.trim(),
          passwordHash: hashPassword(input.password),
          status: 'ACTIVE',
          isSuperAdmin: !!input.isSuperAdmin,
        },
        select: { id: true, email: true, name: true, status: true, isSuperAdmin: true, createdAt: true },
      });
    });
    return user;
  }

  async updateUser(actorUserId: string, id: string, input: UpdateUserInput) {
    if (input.status && !USER_STATUSES.includes(input.status)) throw new BadRequestException('Unknown status');
    if (input.password !== undefined && input.password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    return this.prisma.asSuperAdmin(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('User not found');
      // Never let an admin strip their own super-admin flag or lock themselves
      // out — that is a reliable way to brick the platform console.
      if (id === actorUserId && input.isSuperAdmin === false) {
        throw new BadRequestException('You cannot remove your own super-admin access');
      }
      if (id === actorUserId && input.status && input.status !== 'ACTIVE') {
        throw new BadRequestException('You cannot disable your own account');
      }
      const data: Prisma.UserUpdateInput = {};
      if (input.name !== undefined) data.name = input.name.trim();
      if (input.status !== undefined) data.status = input.status;
      if (input.isSuperAdmin !== undefined) data.isSuperAdmin = input.isSuperAdmin;
      if (input.password !== undefined) data.passwordHash = hashPassword(input.password);
      return tx.user.update({
        where: { id },
        data,
        select: { id: true, email: true, name: true, status: true, isSuperAdmin: true, createdAt: true },
      });
    });
  }

  async deleteUser(actorUserId: string, id: string) {
    if (id === actorUserId) throw new BadRequestException('You cannot delete your own account');
    await this.prisma.asSuperAdmin(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('User not found');
      // Cascades remove this user's memberships (and their role links).
      await tx.user.delete({ where: { id } });
    });
    return { ok: true };
  }

  // ──────────────────────── Memberships & roles ───────────────────────

  listTenantMembers(tenantId: string) {
    return this.prisma.asSuperAdmin(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new NotFoundException('Workspace not found');
      const members = await tx.membership.findMany({
        where: { tenantId },
        include: {
          user: { select: { id: true, name: true, email: true, status: true, isSuperAdmin: true } },
          roles: { include: { role: { select: { id: true, name: true, key: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      });
      const roles = await tx.role.findMany({
        where: { tenantId },
        select: { id: true, name: true, key: true, isSystem: true },
        orderBy: { createdAt: 'asc' },
      });
      return {
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan },
        roles,
        members: members.map((m) => ({
          id: m.id,
          status: m.status,
          user: m.user,
          roles: m.roles.map((r) => r.role),
        })),
      };
    });
  }

  async addMember(
    actorUserId: string,
    tenantId: string,
    input: { userId?: string; email?: string; name?: string; roleIds: string[] },
  ) {
    if (!input.roleIds?.length) throw new BadRequestException('At least one role is required');

    const result = await this.prisma.asSuperAdmin(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new NotFoundException('Workspace not found');

      // Resolve (or create) the user by id or email.
      let user;
      if (input.userId) {
        user = await tx.user.findUnique({ where: { id: input.userId } });
        if (!user) throw new NotFoundException('User not found');
      } else {
        const email = input.email?.trim().toLowerCase();
        if (!email) throw new BadRequestException('A user id or email is required');
        user = await tx.user.findUnique({ where: { email } });
        if (!user) {
          user = await tx.user.create({
            data: {
              email,
              name: input.name?.trim() || email.split('@')[0],
              status: 'INVITED',
              passwordHash: hashPassword(randomBytes(24).toString('hex')),
            },
          });
        }
      }

      const existing = await tx.membership.findFirst({ where: { userId: user.id, tenantId } });
      if (existing) throw new ConflictException('User is already a member of this workspace');

      const roleCount = await tx.role.count({ where: { id: { in: input.roleIds }, tenantId } });
      if (roleCount !== input.roleIds.length) throw new BadRequestException('Unknown role for this workspace');

      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          tenantId,
          status: 'ACTIVE',
          roles: { create: input.roleIds.map((roleId) => ({ roleId })) },
        },
      });
      return { membershipId: membership.id, userId: user.id, email: user.email };
    });

    await this.audit.record({
      tenantId,
      actorUserId,
      action: 'member.added',
      target: result.membershipId,
      meta: { email: result.email, roleIds: input.roleIds },
    });
    return result;
  }

  async setMemberRoles(actorUserId: string, tenantId: string, membershipId: string, roleIds: string[]) {
    if (!roleIds?.length) throw new BadRequestException('At least one role is required');
    await this.prisma.asSuperAdmin(async (tx) => {
      const m = await tx.membership.findFirst({ where: { id: membershipId, tenantId } });
      if (!m) throw new NotFoundException('Member not found');
      const roleCount = await tx.role.count({ where: { id: { in: roleIds }, tenantId } });
      if (roleCount !== roleIds.length) throw new BadRequestException('Unknown role for this workspace');
      await tx.membershipRole.deleteMany({ where: { membershipId } });
      await tx.membershipRole.createMany({ data: roleIds.map((roleId) => ({ membershipId, roleId })) });
    });
    await this.audit.record({
      tenantId,
      actorUserId,
      action: 'member.roles.updated',
      target: membershipId,
      meta: { roleIds },
    });
    return { ok: true };
  }

  async removeMember(actorUserId: string, tenantId: string, membershipId: string) {
    const userId = await this.prisma.asSuperAdmin(async (tx) => {
      const m = await tx.membership.findFirst({ where: { id: membershipId, tenantId } });
      if (!m) throw new NotFoundException('Member not found');
      await tx.membership.delete({ where: { id: membershipId } });
      return m.userId;
    });
    await this.audit.record({
      tenantId,
      actorUserId,
      action: 'member.removed',
      target: membershipId,
      meta: { userId },
    });
    return { ok: true };
  }
}
