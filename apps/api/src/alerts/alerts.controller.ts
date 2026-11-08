import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { AlertsService } from './alerts.service';
import { CreateChannelDto, CreateRuleDto, UpdateRuleDto } from './alerts.dto';

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get('channels')
  @RequirePermissions('alerts:read')
  listChannels(@CurrentPrincipal() p: Principal) {
    return this.alerts.listChannels(p);
  }

  @Post('channels')
  @RequirePermissions('alerts:manage')
  createChannel(@CurrentPrincipal() p: Principal, @Body() dto: CreateChannelDto) {
    return this.alerts.createChannel(p, dto);
  }

  @Delete('channels/:id')
  @RequirePermissions('alerts:manage')
  removeChannel(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.alerts.removeChannel(p, id);
  }

  @Post('channels/:id/test')
  @RequirePermissions('alerts:manage')
  testChannel(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.alerts.testChannel(p, id);
  }

  @Get('rules')
  @RequirePermissions('alerts:read')
  listRules(@CurrentPrincipal() p: Principal) {
    return this.alerts.listRules(p);
  }

  @Post('rules')
  @RequirePermissions('alerts:manage')
  createRule(@CurrentPrincipal() p: Principal, @Body() dto: CreateRuleDto) {
    return this.alerts.createRule(p, dto);
  }

  @Put('rules/:id')
  @RequirePermissions('alerts:manage')
  updateRule(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() dto: UpdateRuleDto) {
    return this.alerts.updateRule(p, id, dto);
  }

  @Delete('rules/:id')
  @RequirePermissions('alerts:manage')
  removeRule(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.alerts.removeRule(p, id);
  }

  @Post('rules/:id/test')
  @RequirePermissions('alerts:manage')
  testRule(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.alerts.testRule(p, id);
  }
}
