import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { QuotaService } from '../quota/quota.service';
import type { Principal } from '../rbac/principal.service';
import { CreateChannelDto, CreateRuleDto } from './alerts.dto';

// The signing secret is write-only; it is never returned to clients.
const CHANNEL_SELECT = {
  id: true,
  type: true,
  name: true,
  target: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly quota: QuotaService,
  ) {}

  // ── Channels ──
  listChannels(p: Principal) {
    return this.prisma.forTenant(p.tenantId, (tx) =>
      tx.notificationChannel.findMany({ orderBy: { createdAt: 'desc' }, select: CHANNEL_SELECT }),
    );
  }

  async createChannel(p: Principal, dto: CreateChannelDto) {
    // Plan quota: cap the number of notification channels per tenant.
    await this.quota.assertCanAdd(p.tenantId, 'maxChannels');

    const channel = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.notificationChannel.create({
        data: {
          tenantId: p.tenantId,
          type: dto.type,
          name: dto.name,
          target: dto.target,
          signingSecret: dto.signingSecret,
          enabled: dto.enabled ?? true,
        },
        select: CHANNEL_SELECT,
      }),
    );
    await this.audit.record_for(p, 'alert.channel.created', channel.id, {
      name: channel.name,
      type: channel.type,
    });
    return channel;
  }

  async removeChannel(p: Principal, id: string) {
    await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.notificationChannel.deleteMany({ where: { id } }),
    );
    await this.audit.record_for(p, 'alert.channel.deleted', id);
    return { ok: true };
  }

  // ── Rules ──
  listRules(p: Principal) {
    return this.prisma.forTenant(p.tenantId, (tx) =>
      tx.alertRule.findMany({
        orderBy: { createdAt: 'desc' },
        include: { channel: { select: { id: true, name: true, type: true } } },
      }),
    );
  }

  async createRule(p: Principal, dto: CreateRuleDto) {
    const rule = await this.prisma.forTenant(p.tenantId, async (tx) => {
      const channel = await tx.notificationChannel.findUnique({ where: { id: dto.channelId } });
      if (!channel) throw new NotFoundException('Channel not found');
      return tx.alertRule.create({
        data: {
          tenantId: p.tenantId,
          channelId: dto.channelId,
          jobId: dto.jobId ?? null,
          threshold: dto.threshold ?? 1,
          ...(dto.onStatuses ? { onStatuses: dto.onStatuses } : {}),
          enabled: dto.enabled ?? true,
        },
      });
    });
    await this.audit.record_for(p, 'alert.rule.created', rule.id, {
      channelId: dto.channelId,
      jobId: dto.jobId ?? null,
      threshold: rule.threshold,
    });
    return rule;
  }

  async removeRule(p: Principal, id: string) {
    await this.prisma.forTenant(p.tenantId, (tx) => tx.alertRule.deleteMany({ where: { id } }));
    await this.audit.record_for(p, 'alert.rule.deleted', id);
    return { ok: true };
  }
}
