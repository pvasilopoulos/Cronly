import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { HeartbeatService } from './heartbeat.service';
import { ConfigureHeartbeatDto } from './heartbeat.dto';

// Heartbeat configuration lives under the job it belongs to. Managing it is a
// job mutation, so it requires jobs:update; reading it only needs jobs:read.
@ApiTags('Heartbeat')
@ApiBearerAuth('api-key')
@Controller('jobs/:jobId/heartbeat')
export class HeartbeatController {
  constructor(private readonly heartbeat: HeartbeatService) {}

  @Get()
  @RequirePermissions('jobs:read')
  get(@CurrentPrincipal() p: Principal, @Param('jobId') jobId: string) {
    return this.heartbeat.get(p, jobId);
  }

  @Post()
  @RequirePermissions('jobs:update')
  configure(
    @CurrentPrincipal() p: Principal,
    @Param('jobId') jobId: string,
    @Body() dto: ConfigureHeartbeatDto,
  ) {
    return this.heartbeat.configure(p, jobId, dto);
  }

  @Post('rotate')
  @RequirePermissions('jobs:update')
  rotate(@CurrentPrincipal() p: Principal, @Param('jobId') jobId: string) {
    return this.heartbeat.rotate(p, jobId);
  }

  @Delete()
  @RequirePermissions('jobs:update')
  disable(@CurrentPrincipal() p: Principal, @Param('jobId') jobId: string) {
    return this.heartbeat.disable(p, jobId);
  }
}
