import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { MaintenanceService } from './maintenance.service';
import { CreateMaintenanceWindowDto } from './maintenance.dto';

@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get('windows')
  @RequirePermissions('jobs:read')
  list(@CurrentPrincipal() p: Principal) {
    return this.maintenance.list(p);
  }

  @Post('windows')
  @RequirePermissions('jobs:toggle')
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreateMaintenanceWindowDto) {
    return this.maintenance.create(p, dto);
  }

  @Delete('windows/:id')
  @RequirePermissions('jobs:toggle')
  remove(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.maintenance.remove(p, id);
  }
}
