import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@cronapp/database';
import { deliverToChannel } from '@cronapp/notify';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { QuotaService } from '../quota/quota.service';
import type { Principal } from '../rbac/principal.service';
import { CreateChannelDto, CreateRuleDto, UpdateRuleDto } from './alerts.dto';

// A rule's custom message is stored NULL (not blank) when unused, so the worker
// can cheaply test `rule.body` to decide whether to render an override.
const norm = (v?: string): string | null => (v && v.trim() ? v : null);

// Rule reads expose the channel's id/name/type but never its signing secret.
const RULE_INCLUDE = { channel: { select: { id: true, name: true, type: true } } } as const;

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
      tx.alertRule.findMany({ orderBy: { createdAt: 'desc' }, include: RULE_INCLUDE }),
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
          muteSec: dto.muteSec ?? 0,
          subject: norm(dto.subject),
          body: norm(dto.body),
          enabled: dto.enabled ?? true,
        },
        include: RULE_INCLUDE,
      });
    });
    await this.audit.record_for(p, 'alert.rule.created', rule.id, {
      channelId: dto.channelId,
      jobId: dto.jobId ?? null,
      threshold: rule.threshold,
    });
    return rule;
  }

  async updateRule(p: Principal, id: string, dto: UpdateRuleDto) {
    const data: Prisma.AlertRuleUncheckedUpdateInput = {};
    if (dto.channelId !== undefined) data.channelId = dto.channelId;
    if (dto.threshold !== undefined) data.threshold = dto.threshold;
    if (dto.onStatuses !== undefined) data.onStatuses = dto.onStatuses;
    if (dto.muteSec !== undefined) data.muteSec = dto.muteSec;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.subject !== undefined) data.subject = norm(dto.subject);
    if (dto.body !== undefined) data.body = norm(dto.body);

    const rule = await this.prisma.forTenant(p.tenantId, async (tx) => {
      if (dto.channelId) {
        const channel = await tx.notificationChannel.findUnique({ where: { id: dto.channelId } });
        if (!channel) throw new NotFoundException('Channel not found');
      }
      // updateMany keeps the tenant fence; a cross-tenant id simply matches nothing.
      const res = await tx.alertRule.updateMany({ where: { id }, data });
      if (res.count === 0) throw new NotFoundException('Rule not found');
      return tx.alertRule.findFirst({ where: { id }, include: RULE_INCLUDE });
    });
    await this.audit.record_for(p, 'alert.rule.updated', id, { fields: Object.keys(data) });
    return rule;
  }

  async removeRule(p: Principal, id: string) {
    await this.prisma.forTenant(p.tenantId, (tx) => tx.alertRule.deleteMany({ where: { id } }));
    await this.audit.record_for(p, 'alert.rule.deleted', id);
    return { ok: true };
  }

  // ── Send test ──
  // Deliver a fixed test message to a channel, right now, and report the result
  // so an admin can verify a Telegram chat id / bot token (or any destination)
  // without digging through worker logs. Uses the SAME delivery path as real
  // alerts (@cronapp/notify), so a success here means real alerts will arrive.
  async testChannel(p: Principal, id: string) {
    const channel = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.notificationChannel.findUnique({ where: { id } }),
    );
    if (!channel) throw new NotFoundException('Channel not found');
    return this.runTest(p, channel);
  }

  async testRule(p: Principal, id: string) {
    const rule = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.alertRule.findFirst({ where: { id }, include: { channel: true } }),
    );
    if (!rule?.channel) throw new NotFoundException('Rule not found');
    return this.runTest(p, rule.channel);
  }

  private async runTest(
    p: Principal,
    channel: { id: string; type: string; name: string; target: string; signingSecret: string | null },
  ): Promise<{ ok: boolean; info?: string | null; error?: string }> {
    // Webhooks must receive valid JSON; everyone else gets a plain line.
    const body =
      channel.type === 'WEBHOOK'
        ? JSON.stringify({ event: 'test', message: 'CronApp test notification', channel: channel.name })
        : `🔔 CronApp test — your "${channel.name}" ${channel.type.toLowerCase()} destination is configured correctly.`;
    try {
      const res = await deliverToChannel(
        { type: channel.type, target: channel.target, signingSecret: channel.signingSecret },
        { subject: 'CronApp test notification', body },
      );
      await this.audit.record_for(p, 'alert.channel.tested', channel.id, { ok: true });
      return { ok: true, info: res.info ?? null };
    } catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 400);
      await this.audit.record_for(p, 'alert.channel.tested', channel.id, { ok: false, error });
      return { ok: false, error };
    }
  }
}
