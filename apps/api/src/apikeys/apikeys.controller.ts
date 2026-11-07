import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { ApiKeysService } from './apikeys.service';
import { CreateApiKeyDto } from './apikeys.dto';

@ApiTags('API keys')
@ApiBearerAuth('api-key')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @RequirePermissions('apikeys:read')
  list(@CurrentPrincipal() p: Principal) {
    return this.apiKeys.list(p);
  }

  @Post()
  @RequirePermissions('apikeys:manage')
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreateApiKeyDto) {
    return this.apiKeys.create(p, dto);
  }

  @Post(':id/revoke')
  @RequirePermissions('apikeys:manage')
  revoke(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.apiKeys.revoke(p, id);
  }

  @Delete(':id')
  @RequirePermissions('apikeys:manage')
  remove(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.apiKeys.remove(p, id);
  }
}
