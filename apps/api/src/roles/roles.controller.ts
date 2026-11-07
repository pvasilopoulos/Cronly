import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsOptional, IsString, MinLength } from 'class-validator';
import { ALL_PERMISSION_KEYS } from '@cronapp/rbac';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

class UpsertRoleDto {
  @IsString() @MinLength(2) name!: string;
  @IsOptional() @IsString() description?: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) permissions!: string[];
}

function validatePerms(perms: string[]) {
  const valid = new Set(ALL_PERMISSION_KEYS);
  const bad = perms.filter((p) => !valid.has(p as any));
  if (bad.length) throw new BadRequestException(`Unknown permission(s): ${bad.join(', ')}`);
}

function roleKey(name: string) {
  return 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36);
}

@Controller('roles')
export class RolesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('roles:read')
  list(@CurrentPrincipal() p: Principal) {
    return this.prisma.forTenant(p.tenantId, (tx) =>
      tx.role.findMany({ include: { permissions: true, _count: { select: { members: true } } }, orderBy: { createdAt: 'asc' } }),
    );
  }

  @Post()
  @RequirePermissions('roles:manage')
  async create(@CurrentPrincipal() p: Principal, @Body() dto: UpsertRoleDto) {
    validatePerms(dto.permissions);
    const role = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.role.create({
        data: {
          tenantId: p.tenantId,
          key: roleKey(dto.name),
          name: dto.name,
          description: dto.description,
          isSystem: false,
          permissions: { create: dto.permissions.map((permission) => ({ permission })) },
        },
        include: { permissions: true },
      }),
    );
    await this.audit.record_for(p, 'role.created', role.id, {
      name: role.name,
      permissions: dto.permissions,
    });
    return role;
  }

  @Patch(':id')
  @RequirePermissions('roles:manage')
  async update(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() dto: UpsertRoleDto) {
    validatePerms(dto.permissions);
    const updated = await this.prisma.forTenant(p.tenantId, async (tx) => {
      const role = await tx.role.findUnique({ where: { id } });
      if (!role) throw new NotFoundException('Role not found');
      if (role.isSystem) throw new ForbiddenException('System roles cannot be edited');
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      return tx.role.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          permissions: { create: dto.permissions.map((permission) => ({ permission })) },
        },
        include: { permissions: true },
      });
    });
    await this.audit.record_for(p, 'role.updated', id, {
      name: updated.name,
      permissions: dto.permissions,
    });
    return updated;
  }

  @Delete(':id')
  @RequirePermissions('roles:manage')
  async remove(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    const name = await this.prisma.forTenant(p.tenantId, async (tx) => {
      const role = await tx.role.findUnique({ where: { id }, include: { _count: { select: { members: true } } } });
      if (!role) throw new NotFoundException('Role not found');
      if (role.isSystem) throw new ForbiddenException('System roles cannot be deleted');
      if (role._count.members > 0) throw new BadRequestException('Role still assigned to members');
      await tx.role.delete({ where: { id } });
      return role.name;
    });
    await this.audit.record_for(p, 'role.deleted', id, { name });
    return { ok: true };
  }
}
