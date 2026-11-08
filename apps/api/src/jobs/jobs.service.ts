import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@cronapp/database';
import { getHandler, validatePayload } from '@cronapp/handlers';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { AuditService } from '../audit/audit.service';
import { QuotaService } from '../quota/quota.service';
import { nextRun, validateCron } from '../common/cron';
import type { Principal } from '../rbac/principal.service';
import { CreateJobDto, UpdateJobDto } from './jobs.dto';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

/** Parse an optional ISO date field: undefined → leave unset, ''/null → clear, else a Date. */
function parseDateField(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v.trim() === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date in schedule window');
  return d;
}

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly quota: QuotaService,
  ) {}

  list(p: Principal) {
    return this.prisma.forTenant(p.tenantId, (tx) =>
      tx.job.findMany({ orderBy: { createdAt: 'desc' } }),
    );
  }

  async get(p: Principal, id: string) {
    const job = await this.prisma.forTenant(p.tenantId, (tx) => tx.job.findUnique({ where: { id } }));
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  async create(p: Principal, dto: CreateJobDto) {
    // Plan quota: reject before doing any work if the tenant is at its job cap.
    await this.quota.assertCanAdd(p.tenantId, 'maxJobs');

    const timezone = dto.timezone ?? 'Europe/Athens';
    const err = validateCron(dto.cronExpr, timezone);
    if (err) throw new BadRequestException(`Invalid cron expression: ${err}`);

    if (!getHandler(dto.handler)) throw new BadRequestException(`Unknown handler "${dto.handler}"`);
    const payloadErr = validatePayload(dto.handler, dto.payload);
    if (payloadErr) throw new BadRequestException(payloadErr);

    const startsAt = parseDateField(dto.startsAt) ?? null;
    const endsAt = parseDateField(dto.endsAt) ?? null;
    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new BadRequestException('Schedule window end must be after its start');
    }

    const { job, alertRuleId } = await this.prisma.forTenant(p.tenantId, async (tx) => {
      // If an alert channel was chosen, confirm it belongs to this tenant before
      // creating anything, so we never leave a job without its requested rule.
      if (dto.alertChannelId) {
        const channel = await tx.notificationChannel.findUnique({ where: { id: dto.alertChannelId } });
        if (!channel) throw new BadRequestException('Alert channel not found');
      }
      const created = await tx.job.create({
        data: {
          tenantId: p.tenantId,
          name: dto.name,
          slug: slugify(dto.name) + '-' + Date.now().toString(36),
          handler: dto.handler,
          cronExpr: dto.cronExpr,
          timezone,
          payload: (dto.payload ?? {}) as Prisma.InputJsonValue,
          tags: dto.tags ?? [],
          group: dto.group?.trim() || null,
          maxRetries: dto.maxRetries ?? 3,
          timeoutMs: dto.timeoutMs ?? 30000,
          concurrencyKey: dto.concurrencyKey,
          overlapPolicy: dto.overlapPolicy ?? 'ALLOW',
          enabled: dto.enabled ?? true,
          status: dto.enabled === false ? 'PAUSED' : 'ACTIVE',
          description: dto.description?.trim() || null,
          runbookUrl: dto.runbookUrl?.trim() || null,
          startsAt,
          endsAt,
          nextRunAt: nextRun(dto.cronExpr, timezone),
          createdBy: p.userId,
        },
      });
      let ruleId: string | null = null;
      if (dto.alertChannelId) {
        const rule = await tx.alertRule.create({
          data: { tenantId: p.tenantId, channelId: dto.alertChannelId, jobId: created.id },
        });
        ruleId = rule.id;
      }
      return { job: created, alertRuleId: ruleId };
    });

    await this.audit.record_for(p, 'job.created', job.id, {
      name: job.name,
      handler: job.handler,
      cronExpr: job.cronExpr,
    });
    if (alertRuleId) {
      await this.audit.record_for(p, 'alert.rule.created', alertRuleId, {
        channelId: dto.alertChannelId,
        jobId: job.id,
      });
    }
    return job;
  }

  async update(p: Principal, id: string, dto: UpdateJobDto) {
    const existing = await this.get(p, id);
    if (dto.cronExpr) {
      const tz = dto.timezone ?? existing.timezone;
      const err = validateCron(dto.cronExpr, tz);
      if (err) throw new BadRequestException(`Invalid cron expression: ${err}`);
    }
    // A changed payload must still satisfy the job's handler contract.
    if (dto.payload !== undefined) {
      const payloadErr = validatePayload(existing.handler, dto.payload);
      if (payloadErr) throw new BadRequestException(payloadErr);
    }
    // Window boundaries are parsed/normalised separately from the plain spread.
    const { startsAt: rawStart, endsAt: rawEnd, description, runbookUrl, ...rest } = dto;
    const startsAt = parseDateField(rawStart);
    const endsAt = parseDateField(rawEnd);
    const effStart = startsAt !== undefined ? startsAt : existing.startsAt;
    const effEnd = endsAt !== undefined ? endsAt : existing.endsAt;
    if (effStart && effEnd && effEnd <= effStart) {
      throw new BadRequestException('Schedule window end must be after its start');
    }

    const updated = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.job.update({
        where: { id },
        data: {
          ...rest,
          payload: dto.payload as Prisma.InputJsonValue | undefined,
          // Normalise blank group to null ("Ungrouped") while leaving it
          // untouched when the field wasn't part of this update.
          ...(dto.group !== undefined ? { group: dto.group.trim() || null } : {}),
          ...(description !== undefined ? { description: description.trim() || null } : {}),
          ...(runbookUrl !== undefined ? { runbookUrl: runbookUrl.trim() || null } : {}),
          ...(startsAt !== undefined ? { startsAt } : {}),
          ...(endsAt !== undefined ? { endsAt } : {}),
          ...(dto.cronExpr
            ? { nextRunAt: nextRun(dto.cronExpr, dto.timezone ?? 'Europe/Athens') }
            : {}),
        },
      }),
    );
    await this.audit.record_for(p, 'job.updated', id, {
      name: updated.name,
      changed: Object.keys(dto),
    });
    return updated;
  }

  async remove(p: Principal, id: string) {
    const job = await this.get(p, id);
    await this.prisma.forTenant(p.tenantId, (tx) => tx.job.delete({ where: { id } }));
    await this.audit.record_for(p, 'job.deleted', id, { name: job.name });
    return { ok: true };
  }

  async toggle(p: Principal, id: string) {
    const job = await this.get(p, id);
    const enabled = !job.enabled;
    const updated = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.job.update({
        where: { id },
        data: { enabled, status: enabled ? 'ACTIVE' : 'PAUSED' },
      }),
    );
    await this.audit.record_for(p, enabled ? 'job.enabled' : 'job.disabled', id, { name: job.name });
    return updated;
  }

  /** Create a QUEUED run now and push it to the execution queue. */
  async runNow(p: Principal, id: string) {
    const job = await this.get(p, id);
    const run = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.jobRun.create({
        data: { jobId: job.id, tenantId: p.tenantId, status: 'QUEUED', scheduledAt: new Date() },
      }),
    );
    await this.queue.enqueue(
      { runId: run.id, jobId: job.id, tenantId: p.tenantId, attempt: 1 },
      { perTenantKey: p.tenantId },
    );
    await this.audit.record_for(p, 'job.run', job.id, { name: job.name, runId: run.id });
    return run;
  }
}
