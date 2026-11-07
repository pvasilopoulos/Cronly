import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/jwt.strategy';
import { AdminService } from './admin.service';
import { SuperAdminGuard } from './super-admin.guard';

const PLANS = ['STARTER', 'PRO', 'SCALE', 'ENTERPRISE'] as const;
const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED', 'TRIAL'] as const;
const USER_STATUSES = ['ACTIVE', 'INVITED', 'DISABLED'] as const;

class CreateTenantDto {
  @IsString() @MinLength(2) @MaxLength(60) name!: string;
  @IsOptional() @IsString() @MaxLength(40) slug?: string;
  @IsOptional() @IsIn(PLANS as unknown as string[]) plan?: (typeof PLANS)[number];
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
}
class UpdateTenantDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsIn(PLANS as unknown as string[]) plan?: (typeof PLANS)[number];
  @IsOptional() @IsIn(TENANT_STATUSES as unknown as string[]) status?: (typeof TENANT_STATUSES)[number];
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) features?: string[];
}

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsString() @MinLength(8) @MaxLength(200) password!: string;
  @IsOptional() @IsBoolean() isSuperAdmin?: boolean;
}
class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsIn(USER_STATUSES as unknown as string[]) status?: (typeof USER_STATUSES)[number];
  @IsOptional() @IsBoolean() isSuperAdmin?: boolean;
  @IsOptional() @IsString() @MinLength(8) @MaxLength(200) password?: string;
}

class AddMemberDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) roleIds!: string[];
}
class SetMemberRolesDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) roleIds!: string[];
}

/**
 * Platform console — super-admin only. The guard is applied at the class level
 * so every route is gated; handlers read the acting super-admin from the JWT
 * for audit attribution and self-protection checks.
 */
@ApiTags('Admin')
@UseGuards(SuperAdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  // ─── Tenants ───
  @Get('tenants')
  listTenants() {
    return this.svc.listTenants();
  }

  @Post('tenants')
  createTenant(@CurrentUser() u: AuthUser, @Body() dto: CreateTenantDto) {
    return this.svc.createTenant(u.userId, dto);
  }

  @Patch('tenants/:id')
  updateTenant(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateTenantDto) {
    return this.svc.updateTenant(u.userId, id, dto);
  }

  @Delete('tenants/:id')
  deleteTenant(@Param('id') id: string) {
    return this.svc.deleteTenant(id);
  }

  // ─── Tenant members & roles ───
  @Get('tenants/:id/members')
  listTenantMembers(@Param('id') id: string) {
    return this.svc.listTenantMembers(id);
  }

  @Post('tenants/:id/members')
  addMember(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AddMemberDto) {
    return this.svc.addMember(u.userId, id, dto);
  }

  @Patch('tenants/:id/members/:membershipId/roles')
  setMemberRoles(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Param('membershipId') membershipId: string,
    @Body() dto: SetMemberRolesDto,
  ) {
    return this.svc.setMemberRoles(u.userId, id, membershipId, dto.roleIds);
  }

  @Delete('tenants/:id/members/:membershipId')
  removeMember(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Param('membershipId') membershipId: string,
  ) {
    return this.svc.removeMember(u.userId, id, membershipId);
  }

  // ─── Users ───
  @Get('users')
  listUsers() {
    return this.svc.listUsers();
  }

  @Post('users')
  createUser(@Body() dto: CreateUserDto) {
    return this.svc.createUser(dto);
  }

  @Patch('users/:id')
  updateUser(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.svc.updateUser(u.userId, id, dto);
  }

  @Delete('users/:id')
  deleteUser(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.deleteUser(u.userId, id);
  }
}
