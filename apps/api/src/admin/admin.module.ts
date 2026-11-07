import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * Platform super-admin console. Relies on the global PrismaModule and the
 * global AuditModule (tenant/member lifecycle actions are recorded).
 */
@Module({
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
