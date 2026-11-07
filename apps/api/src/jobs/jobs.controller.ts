import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { JobsService } from './jobs.service';
import { CreateJobDto, UpdateJobDto } from './jobs.dto';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  @RequirePermissions('jobs:read')
  list(@CurrentPrincipal() p: Principal) {
    return this.jobs.list(p);
  }

  @Get(':id')
  @RequirePermissions('jobs:read')
  get(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.jobs.get(p, id);
  }

  @Post()
  @RequirePermissions('jobs:create')
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreateJobDto) {
    return this.jobs.create(p, dto);
  }

  @Patch(':id')
  @RequirePermissions('jobs:update')
  update(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() dto: UpdateJobDto) {
    return this.jobs.update(p, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('jobs:delete')
  remove(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.jobs.remove(p, id);
  }

  @Post(':id/toggle')
  @RequirePermissions('jobs:toggle')
  toggle(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.jobs.toggle(p, id);
  }

  @Post(':id/run')
  @RequirePermissions('jobs:run')
  runNow(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.jobs.runNow(p, id);
  }
}
