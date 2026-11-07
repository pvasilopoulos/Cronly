import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { HeartbeatService } from './heartbeat.service';

/**
 * Public inbound heartbeat endpoint. Lives at the root (`/ping/:token`, excluded
 * from the `/api` prefix) so it is a short, stable URL to curl from a cron line.
 * Both GET and POST are accepted — `curl` defaults to GET, most monitors POST.
 */
@ApiExcludeController()
@Public()
@Controller('ping')
export class PingController {
  constructor(private readonly heartbeat: HeartbeatService) {}

  @Get(':token')
  pingGet(@Param('token') token: string) {
    return this.heartbeat.ping(token);
  }

  @Post(':token')
  pingPost(@Param('token') token: string) {
    return this.heartbeat.ping(token);
  }
}
