import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { env } from '../config/env';
import type { Principal } from '../rbac/principal.service';
import { ConfigureHeartbeatDto } from './heartbeat.dto';

// Fields safe to return to clients. The token is secret-ish (it grants the
// ability to reset the heartbeat), so it is only returned to users who can
// already manage the job — never in general job listings.
const HB_SELECT = {
  id: true,
  heartbeatEnabled: true,
  heartbeatToken: true,
  heartbeatIntervalSec: true,
  heartbeatGraceSec: true,
  lastPingAt: true,
  heartbeatState: true,
  heartbeatAlertedAt: true,
} as const;

function newToken(): string {
  return 'hb_' + randomBytes(24).toString('base64url');
}

@Injectable()
export class HeartbeatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private shape(job: {
    id: string;
    heartbeatEnabled: boolean;
    heartbeatToken: string | null;
    heartbeatIntervalSec: number | null;
    heartbeatGraceSec: number;
    lastPingAt: Date | null;
    heartbeatState: string;
    heartbeatAlertedAt: Date | null;
  }) {
    return {
      enabled: job.heartbeatEnabled,
      token: job.heartbeatToken,
      pingUrl: job.heartbeatToken ? `${env.publicUrl}/ping/${job.heartbeatToken}` : null,
      intervalSec: job.heartbeatIntervalSec,
      graceSec: job.heartbeatGraceSec,
      lastPingAt: job.lastPingAt,
      state: job.heartbeatState,
      alertedAt: job.heartbeatAlertedAt,
    };
  }

  async get(p: Principal, jobId: string) {
    const job = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.job.findUnique({ where: { id: jobId }, select: HB_SELECT }),
    );
    if (!job) throw new NotFoundException('Job not found');
    return this.shape(job);
  }

  /** Enable or update the heartbeat for a job; (re)starts the clock from now. */
  async configure(p: Principal, jobId: string, dto: ConfigureHeartbeatDto) {
    const existing = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.job.findUnique({ where: { id: jobId }, select: { id: true, heartbeatToken: true } }),
    );
    if (!existing) throw new NotFoundException('Job not found');

    const job = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.job.update({
        where: { id: jobId },
        data: {
          heartbeatEnabled: true,
          heartbeatToken: existing.heartbeatToken ?? newToken(),
          heartbeatIntervalSec: dto.intervalSec,
          heartbeatGraceSec: dto.graceSec ?? 60,
          // Start/restart the window now and clear any prior miss.
          lastPingAt: new Date(),
          heartbeatState: 'OK',
          heartbeatAlertedAt: null,
        },
        select: HB_SELECT,
      }),
    );
    await this.audit.record_for(p, 'job.heartbeat.configured', jobId, {
      intervalSec: dto.intervalSec,
      graceSec: dto.graceSec ?? 60,
    });
    return this.shape(job);
  }

  /** Turn the heartbeat off (keeps the token so re-enabling reuses the same URL). */
  async disable(p: Principal, jobId: string) {
    const existing = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.job.findUnique({ where: { id: jobId }, select: { id: true } }),
    );
    if (!existing) throw new NotFoundException('Job not found');
    const job = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.job.update({
        where: { id: jobId },
        data: { heartbeatEnabled: false, heartbeatState: 'OK', heartbeatAlertedAt: null },
        select: HB_SELECT,
      }),
    );
    await this.audit.record_for(p, 'job.heartbeat.disabled', jobId);
    return this.shape(job);
  }

  /** Issue a fresh ping token, invalidating the old URL. */
  async rotate(p: Principal, jobId: string) {
    const existing = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.job.findUnique({ where: { id: jobId }, select: { id: true } }),
    );
    if (!existing) throw new NotFoundException('Job not found');
    const job = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.job.update({
        where: { id: jobId },
        data: { heartbeatToken: newToken() },
        select: HB_SELECT,
      }),
    );
    await this.audit.record_for(p, 'job.heartbeat.rotated', jobId);
    return this.shape(job);
  }

  /**
   * Record an inbound ping. Public (no auth) — the token IS the credential, so
   * the lookup runs RLS-bypassed before any tenant context exists. Resets the
   * heartbeat window and clears a prior miss. Unknown/disabled tokens 404 so a
   * scanner cannot tell a real token from a stale one by the response body.
   */
  async ping(token: string): Promise<{ ok: true }> {
    if (!token.startsWith('hb_')) throw new NotFoundException('Unknown heartbeat token');
    const res = await this.prisma.asSuperAdmin((tx) =>
      tx.job.updateMany({
        where: { heartbeatToken: token, heartbeatEnabled: true },
        data: { lastPingAt: new Date(), heartbeatState: 'OK', heartbeatAlertedAt: null },
      }),
    );
    if (res.count === 0) throw new NotFoundException('Unknown heartbeat token');
    return { ok: true };
  }
}
