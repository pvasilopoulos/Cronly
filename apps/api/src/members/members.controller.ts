import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsEmail, IsIn, IsObject, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ALL_PERMISSION_KEYS } from '@cronapp/rbac';
import { Prisma } from '@cronapp/database';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { QuotaService } from '../quota/quota.service';
import { hashPassword } from '../auth/password';
import { randomBytes } from 'node:crypto';

class SetRolesDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) roleIds!: string[];
}

class OverrideDto {
  @IsString() permission!: string;
  @IsIn(['GRANT', 'DENY']) effect!: 'GRANT' | 'DENY';
  @IsOptional() @IsObject() conditions?: Record<string, unknown>;
}
class SetOverridesDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => OverrideDto) overrides!: OverrideDto[];
}

class InviteDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(2) name!: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) roleIds!: string[];
}

@Controller('members')
export class MembersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly quota: QuotaService,
  ) {}

  @Get()
  @RequirePermissions('members:read')
  async list(@CurrentPrincipal() p: Principal) {
    return this.prisma.forTenant(p.tenantId, async (tx) => {
      const members = await tx.membership.findMany({
        include: { roles: { include: { role: { select: { id: true, name: true, key: true } } } }, overrides: true },
      });
      // User identity lives outside RLS; fetch names/emails separately.
      const userIds = members.map((m) => m.userId);
      const users = await this.prisma.asSuperAdmin((t2) =>
        t2.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true, status: true } }),
      );
      const byId = new Map(users.map((u) => [u.id, u]));
      return members.map((m) => ({
        id: m.id,
        status: m.status,
        user: byId.get(m.userId) ?? null,
        roles: m.roles.map((r) => r.role),
        overrides: m.overrides.map((o) => ({ permission: o.permission, effect: o.effect, conditions: o.conditions })),
      }));
    });
  }

  @Patch(':id/roles')
  @RequirePermissions('members:update')
  async setRoles(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() dto: SetRolesDto) {
    await this.prisma.forTenant(p.tenantId, async (tx) => {
      const m = await tx.membership.findUnique({ where: { id } });
      if (!m) throw new NotFoundException('Member not found');
      // Ensure the roles belong to this tenant (RLS already scopes, double-check count).
      const count = await tx.role.count({ where: { id: { in: dto.roleIds } } });
      if (count !== dto.roleIds.length) throw new BadRequestException('Unknown role in set');
      await tx.membershipRole.deleteMany({ where: { membershipId: id } });
      await tx.membershipRole.createMany({ data: dto.roleIds.map((roleId) => ({ membershipId: id, roleId })) });
    });
    await this.audit.record_for(p, 'member.roles.updated', id, { roleIds: dto.roleIds });
    return { ok: true };
  }

  @Patch(':id/overrides')
  @RequirePermissions('members:update')
  async setOverrides(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() dto: SetOverridesDto) {
    const valid = new Set(ALL_PERMISSION_KEYS);
    const bad = dto.overrides.filter((o) => !valid.has(o.permission as any));
    if (bad.length) throw new BadRequestException(`Unknown permission(s): ${bad.map((b) => b.permission).join(', ')}`);
    await this.prisma.forTenant(p.tenantId, async (tx) => {
      const m = await tx.membership.findUnique({ where: { id } });
      if (!m) throw new NotFoundException('Member not found');
      await tx.permissionOverride.deleteMany({ where: { membershipId: id } });
      for (const o of dto.overrides) {
        await tx.permissionOverride.create({
          data: {
            membershipId: id,
            permission: o.permission,
            effect: o.effect,
            conditions: (o.conditions ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        });
      }
    });
    await this.audit.record_for(p, 'member.overrides.updated', id, {
      overrides: dto.overrides.map((o) => `${o.effect} ${o.permission}`),
    });
    return { ok: true };
  }

  @Post('invite')
  @RequirePermissions('members:invite')
  async invite(@CurrentPrincipal() p: Principal, @Body() dto: InviteDto) {
    // Plan quota: a seat is consumed by every membership, pending invites too.
    await this.quota.assertCanAdd(p.tenantId, 'maxMembers');

    // Global identity: reuse an existing user or create an invited one.
    const user = await this.prisma.asSuperAdmin(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: dto.email.toLowerCase() } });
      if (existing) return existing;
      return tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          name: dto.name,
          status: 'INVITED',
          passwordHash: hashPassword(randomBytes(24).toString('hex')),
        },
      });
    });

    const result = await this.prisma.forTenant(p.tenantId, async (tx) => {
      const existing = await tx.membership.findFirst({ where: { userId: user.id, tenantId: p.tenantId } });
      if (existing) throw new BadRequestException('User is already a member');
      const count = await tx.role.count({ where: { id: { in: dto.roleIds } } });
      if (count !== dto.roleIds.length) throw new BadRequestException('Unknown role in set');
      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          tenantId: p.tenantId,
          status: 'INVITED',
          roles: { create: dto.roleIds.map((roleId) => ({ roleId })) },
        },
      });
      return { membershipId: membership.id, userId: user.id };
    });
    await this.audit.record_for(p, 'member.invited', result.membershipId, {
      email: dto.email.toLowerCase(),
      roleIds: dto.roleIds,
    });
    return result;
  }

  @Delete(':id')
  @RequirePermissions('members:remove')
  async remove(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    const userId = await this.prisma.forTenant(p.tenantId, async (tx) => {
      const m = await tx.membership.findUnique({ where: { id } });
      if (!m) throw new NotFoundException('Member not found');
      await tx.membership.delete({ where: { id } });
      return m.userId;
    });
    await this.audit.record_for(p, 'member.removed', id, { userId });
    return { ok: true };
  }
}
