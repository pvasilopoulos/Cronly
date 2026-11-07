import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { SecretsService } from './secrets.service';
import { CreateSecretDto } from './secrets.dto';

@Controller('secrets')
export class SecretsController {
  constructor(private readonly secrets: SecretsService) {}

  @Get()
  @RequirePermissions('secrets:read')
  list(@CurrentPrincipal() p: Principal) {
    return this.secrets.list(p);
  }

  @Post()
  @RequirePermissions('secrets:manage')
  upsert(@CurrentPrincipal() p: Principal, @Body() dto: CreateSecretDto) {
    return this.secrets.upsert(p, dto);
  }

  @Delete(':name')
  @RequirePermissions('secrets:manage')
  remove(@CurrentPrincipal() p: Principal, @Param('name') name: string) {
    return this.secrets.remove(p, name);
  }
}
