import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { SettingsService } from './settings.service';
import { UpdateDigestDto } from './settings.dto';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('digest')
  @RequirePermissions('settings:read')
  getDigest(@CurrentPrincipal() p: Principal) {
    return this.settings.getDigest(p);
  }

  @Put('digest')
  @RequirePermissions('settings:manage')
  updateDigest(@CurrentPrincipal() p: Principal, @Body() dto: UpdateDigestDto) {
    return this.settings.updateDigest(p, dto);
  }
}
