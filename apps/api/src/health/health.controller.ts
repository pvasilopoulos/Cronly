import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import IORedis from 'ioredis';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { env } from '../config/env';

/**
 * Liveness & readiness probes for load balancers / PM2 / orchestration.
 * Both are @Public and excluded from the /api prefix (served at /health, /ready).
 */
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  @Public()
  @Get('ready')
  async ready(@Res() res: Response) {
    const checks: Record<string, 'up' | 'down'> = {};
    let ok = true;

    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      checks.database = 'down';
      ok = false;
    }

    const redis = new IORedis({
      host: env.redis.host,
      port: env.redis.port,
      password: env.redis.password,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    try {
      await redis.connect();
      checks.redis = (await redis.ping()) === 'PONG' ? 'up' : 'down';
      if (checks.redis === 'down') ok = false;
    } catch {
      checks.redis = 'down';
      ok = false;
    } finally {
      redis.disconnect();
    }

    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
  }
}
