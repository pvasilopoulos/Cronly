import { Body, Controller, Get, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import type { Principal } from '../rbac/principal.service';
import { RunsService, RUN_STATUSES, type RunStatusKey } from './runs.service';
import { ReplayManyDto } from './runs.dto';

function parseStatuses(raw?: string): RunStatusKey[] | undefined {
  if (!raw) return undefined;
  const valid = new Set<string>(RUN_STATUSES);
  const picked = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => valid.has(s)) as RunStatusKey[];
  return picked.length > 0 ? picked : undefined;
}

@Controller()
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get('runs')
  @RequirePermissions('runs:read')
  listRecent(
    @CurrentPrincipal() p: Principal,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.runs.listRecent(p, limit ? parseInt(limit, 10) : 50, parseStatuses(status));
  }

  // Replaying re-triggers an execution, so it needs the same permission as "run now".
  @Post('runs/:id/replay')
  @RequirePermissions('jobs:run')
  replay(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.runs.replay(p, id);
  }

  @Post('runs/replay')
  @RequirePermissions('jobs:run')
  replayMany(@CurrentPrincipal() p: Principal, @Body() dto: ReplayManyDto) {
    return this.runs.replayMany(p, dto.runIds);
  }

  @Get('jobs/:jobId/runs')
  @RequirePermissions('runs:read')
  listForJob(@CurrentPrincipal() p: Principal, @Param('jobId') jobId: string) {
    return this.runs.listForJob(p, jobId);
  }

  @Get('runs/:id')
  @RequirePermissions('runs:read')
  get(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.runs.get(p, id);
  }

  // Viewing the body needs responses:read; the frontend virtualizes large ones.
  @Get('runs/:id/response')
  @RequirePermissions('responses:read')
  async response(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { contentType, body } = await this.runs.getResponseBody(p, id);
    res.setHeader('Content-Type', contentType);
    return new StreamableFile(Readable.from(body));
  }
}
