import { Module } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service';
import { HeartbeatController } from './heartbeat.controller';
import { PingController } from './ping.controller';

@Module({
  controllers: [HeartbeatController, PingController],
  providers: [HeartbeatService],
})
export class HeartbeatModule {}
