import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

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

    // The execution queue lives in the database (QUEUED JobRun rows), so a
    // healthy database is the whole readiness story — there is no Redis to probe.
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
  }
}
