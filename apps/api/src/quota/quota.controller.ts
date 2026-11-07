import { BadRequestException, Controller, Get, Headers } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrincipalService } from '../rbac/principal.service';
import { QuotaService } from './quota.service';

/**
 * Plan usage for the active tenant. Not gated behind a specific permission: any
 * active member may see how much of their plan is consumed. Membership is still
 * verified by resolving the principal (throws if the caller is not a member).
 */
@ApiTags('Usage')
@ApiBearerAuth('api-key')
@Controller('usage')
export class QuotaController {
  constructor(
    private readonly principals: PrincipalService,
    private readonly quota: QuotaService,
  ) {}

  @Get()
  async usage(@CurrentUser() user: AuthUser, @Headers('x-tenant-id') tenantId?: string) {
    if (!tenantId) throw new BadRequestException('Missing x-tenant-id header');
    await this.principals.load(user, tenantId); // verifies active membership
    return this.quota.usage(tenantId);
  }
}
