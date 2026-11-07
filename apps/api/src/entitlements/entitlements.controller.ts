import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from './entitlements.service';

class UpdateEntitlementsDto {
  /** Map of quota key → integer >= -1 (-1 = unlimited), or null to clear the override. */
  @IsOptional()
  @IsObject()
  quotas?: Record<string, number | null>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];
}

/**
 * Per-tenant entitlements: plan-limit overrides and enabled features. Reading is
 * gated by entitlements:read, changing by entitlements:manage. Owners hold both
 * by default (the owner role grants every permission).
 */
@ApiTags('Entitlements')
@ApiBearerAuth('api-key')
@Controller('entitlements')
export class EntitlementsController {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('entitlements:read')
  view(@CurrentPrincipal() p: Principal) {
    return this.entitlements.view(p.tenantId);
  }

  @Patch()
  @RequirePermissions('entitlements:manage')
  async update(@CurrentPrincipal() p: Principal, @Body() dto: UpdateEntitlementsDto) {
    const result = await this.entitlements.update(p.tenantId, {
      quotas: dto.quotas,
      features: dto.features,
    });
    await this.audit.record_for(p, 'entitlements.updated', p.tenantId, {
      overrides: result.overrides,
      features: result.features,
    });
    return result;
  }
}
