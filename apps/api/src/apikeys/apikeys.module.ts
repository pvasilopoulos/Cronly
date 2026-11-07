import { Module } from '@nestjs/common';
import { ApiKeysController } from './apikeys.controller';
import { ApiKeysService } from './apikeys.service';

@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  // Exported so JwtAuthGuard (registered in AppModule) can authenticate
  // `Authorization: Bearer cak_…` requests.
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
