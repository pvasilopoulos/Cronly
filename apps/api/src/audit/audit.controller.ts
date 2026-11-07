import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { AuditService } from './audit.service';

function parseDate(raw?: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

@ApiTags('Audit log')
@ApiBearerAuth('api-key')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit:read')
  list(
    @CurrentPrincipal() p: Principal,
    @Query('action') action?: string,
    @Query('actor') actor?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.audit.list(p, {
      action: action?.trim() || undefined,
      actorUserId: actor?.trim() || undefined,
      from: parseDate(from),
      to: parseDate(to),
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
