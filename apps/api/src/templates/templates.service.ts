import { BadRequestException, Injectable } from '@nestjs/common';
import {
  TEMPLATE_EVENTS,
  TEMPLATE_CHANNELS,
  TEMPLATE_VARIABLES,
  defaultTemplate,
  renderFields,
  sampleContext,
  validateTemplate,
  type TemplateChannel,
} from '@cronapp/templating';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../rbac/principal.service';
import type { UpsertTemplateDto, PreviewTemplateDto } from './templates.dto';

interface EffectiveTemplate {
  event: string;
  channel: string;
  subject: string | null;
  body: string;
  enabled: boolean;
  /** true when the tenant has saved an override; false = showing the built-in default. */
  isCustom: boolean;
}

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  /** The editor payload: catalogs + the effective template for every event×channel. */
  async list(p: Principal) {
    const overrides = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.messageTemplate.findMany({ where: {} }),
    );
    const byKey = new Map(overrides.map((o) => [`${o.event}:${o.channel}`, o]));

    const templates: EffectiveTemplate[] = [];
    for (const ev of TEMPLATE_EVENTS) {
      for (const ch of TEMPLATE_CHANNELS) {
        const key = `${ev.key}:${ch.key}`;
        const override = byKey.get(key);
        const def = defaultTemplate(ev.key, ch.key);
        if (override) {
          templates.push({
            event: ev.key,
            channel: ch.key,
            subject: ch.hasSubject ? (override.subject ?? '') : null,
            body: override.body,
            enabled: override.enabled,
            isCustom: true,
          });
        } else {
          templates.push({
            event: ev.key,
            channel: ch.key,
            subject: ch.hasSubject ? (def?.subject ?? '') : null,
            body: def?.body ?? '',
            enabled: true,
            isCustom: false,
          });
        }
      }
    }

    return {
      events: TEMPLATE_EVENTS,
      channels: TEMPLATE_CHANNELS,
      variables: TEMPLATE_VARIABLES,
      templates,
    };
  }

  /** Save (or update) a tenant override for one event×channel. */
  async upsert(p: Principal, dto: UpsertTemplateDto) {
    const ch = TEMPLATE_CHANNELS.find((c) => c.key === dto.channel) as { key: TemplateChannel; hasSubject: boolean } | undefined;
    if (!ch) throw new BadRequestException('Unknown channel');
    const subject = ch.hasSubject ? (dto.subject ?? '') : null;

    const err = validateTemplate(dto.event, ch.key, { subject, body: dto.body });
    if (err) throw new BadRequestException(err);

    const row = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.messageTemplate.upsert({
        where: { tenantId_event_channel: { tenantId: p.tenantId, event: dto.event, channel: dto.channel } },
        update: { subject, body: dto.body, enabled: dto.enabled ?? true },
        create: {
          tenantId: p.tenantId,
          event: dto.event,
          channel: dto.channel,
          subject,
          body: dto.body,
          enabled: dto.enabled ?? true,
        },
      }),
    );
    return {
      event: row.event,
      channel: row.channel,
      subject: ch.hasSubject ? (row.subject ?? '') : null,
      body: row.body,
      enabled: row.enabled,
      isCustom: true,
    } satisfies EffectiveTemplate;
  }

  /** Delete a tenant override → the channel reverts to the built-in default. */
  async reset(p: Principal, event: string, channel: string) {
    await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.messageTemplate.deleteMany({ where: { event, channel } }),
    );
    const def = defaultTemplate(event, channel);
    const ch = TEMPLATE_CHANNELS.find((c) => c.key === channel);
    return {
      event,
      channel,
      subject: ch?.hasSubject ? (def?.subject ?? '') : null,
      body: def?.body ?? '',
      enabled: true,
      isCustom: false,
    } satisfies EffectiveTemplate;
  }

  /** Render a draft against sample data for the live editor preview. */
  preview(dto: PreviewTemplateDto) {
    const ch = TEMPLATE_CHANNELS.find((c) => c.key === dto.channel) as { key: TemplateChannel; hasSubject: boolean } | undefined;
    if (!ch) throw new BadRequestException('Unknown channel');
    const subject = ch.hasSubject ? (dto.subject ?? '') : null;
    const rendered = renderFields({ subject, body: dto.body }, sampleContext(dto.event), ch.key);
    const warn = validateTemplate(dto.event, ch.key, { subject, body: dto.body });
    return { subject: rendered.subject, body: rendered.body, warning: warn };
  }
}
