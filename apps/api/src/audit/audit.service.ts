import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@cronapp/database';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../rbac/principal.service';

export interface AuditInput {
  tenantId: string;
  actorUserId?: string | null;
  action: string;
  target?: string | null;
  meta?: Record<string, unknown>;
}

export interface AuditFilters {
  action?: string;
  actorUserId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write one audit row. Trusted internal write (explicit tenantId, RLS
   * bypassed) and deliberately fire-and-forget: auditing must NEVER break the
   * operation it records, so a failure here is logged and swallowed.
   */
  async record(input: AuditInput): Promise<void> {
    try {
      await this.prisma.asSuperAdmin((tx) =>
        tx.auditLog.create({
          data: {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId ?? null,
            action: input.action,
            target: input.target ?? null,
            meta: (input.meta ?? {}) as Prisma.InputJsonValue,
          },
        }),
      );
    } catch (err) {
      this.log.error(`Failed to record audit "${input.action}": ${String(err)}`);
    }
  }

  /**
   * Record an action attributed to the current principal. API-key principals
   * carry a synthetic `apikey:<id>` userId that is not a real User row, so we
   * store a null actor and note the key in meta to avoid an FK violation.
   */
  record_for(
    p: Principal,
    action: string,
    target?: string | null,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const viaApiKey = p.userId.startsWith('apikey:');
    return this.record({
      tenantId: p.tenantId,
      actorUserId: viaApiKey ? null : p.userId,
      action,
      target: target ?? null,
      meta: viaApiKey ? { ...(meta ?? {}), via: p.userId } : meta,
    });
  }

  /** Filterable audit history for a tenant, newest first, with actor identity resolved. */
  async list(p: Principal, f: AuditFilters = {}) {
    const where: Prisma.AuditLogWhereInput = {};
    if (f.action) where.action = { startsWith: f.action };
    if (f.actorUserId) where.actorUserId = f.actorUserId;
    if (f.from || f.to) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (f.from) createdAt.gte = f.from;
      if (f.to) createdAt.lte = f.to;
      where.createdAt = createdAt;
    }

    const rows = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(f.limit ?? 100, 500),
      }),
    );

    // User identity lives outside RLS — resolve actor names/emails in one pass.
    const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
    const users = actorIds.length
      ? await this.prisma.asSuperAdmin((tx) =>
          tx.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true, email: true },
          }),
        )
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      target: r.target,
      meta: r.meta,
      createdAt: r.createdAt,
      actor: r.actorUserId ? (byId.get(r.actorUserId) ?? { id: r.actorUserId, name: null, email: null }) : null,
    }));
  }
}
