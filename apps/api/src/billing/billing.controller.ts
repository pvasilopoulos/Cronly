import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { BillingService } from './billing.service';
import { PLAN_ORDER } from './plans.catalog';

class ChangePlanDto {
  @IsString() @IsIn(PLAN_ORDER as unknown as string[]) plan!: string;
  @IsOptional() @IsString() returnUrl?: string;
}

/**
 * Self-serve billing for the active tenant. Reading plan/usage needs
 * `billing:read`; changing the plan needs `billing:manage` — by default only the
 * owner role holds billing permissions (admins are explicitly excluded).
 */
@ApiTags('Billing')
@ApiBearerAuth('api-key')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @RequirePermissions('billing:read')
  overview(@CurrentPrincipal() p: Principal) {
    return this.billing.overview(p.tenantId);
  }

  @Post('change-plan')
  @RequirePermissions('billing:manage')
  changePlan(@CurrentPrincipal() p: Principal, @Body() dto: ChangePlanDto) {
    return this.billing.changePlan(p, dto.plan, dto.returnUrl);
  }
}
