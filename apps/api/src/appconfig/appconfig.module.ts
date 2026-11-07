import { Module } from '@nestjs/common';
import { AppConfigController } from './appconfig.controller';
import { AppConfigService } from './appconfig.service';

/** Global branding (app name + icon). Relies on the global PrismaModule. */
@Module({
  controllers: [AppConfigController],
  providers: [AppConfigService],
})
export class AppConfigModule {}
