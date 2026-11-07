import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { TemplatesService } from './templates.service';
import { PreviewTemplateDto, UpsertTemplateDto } from './templates.dto';

/**
 * Per-workspace message templates: the editable TEXT of outbound notifications
 * (in-app, email, Slack, webhook) with {{ variable }} placeholders. Gated by
 * `alerts:manage` — the same admins who own notification channels and rules.
 */
@ApiTags('Message templates')
@Controller('templates')
export class TemplatesController {
  constructor(private readonly svc: TemplatesService) {}

  @Get()
  @RequirePermissions('alerts:manage')
  list(@CurrentPrincipal() p: Principal) {
    return this.svc.list(p);
  }

  @Put()
  @RequirePermissions('alerts:manage')
  upsert(@CurrentPrincipal() p: Principal, @Body() dto: UpsertTemplateDto) {
    return this.svc.upsert(p, dto);
  }

  @Post('preview')
  @RequirePermissions('alerts:manage')
  preview(@CurrentPrincipal() _p: Principal, @Body() dto: PreviewTemplateDto) {
    return this.svc.preview(dto);
  }

  @Delete(':event/:channel')
  @RequirePermissions('alerts:manage')
  reset(@CurrentPrincipal() p: Principal, @Param('event') event: string, @Param('channel') channel: string) {
    return this.svc.reset(p, event, channel);
  }
}
