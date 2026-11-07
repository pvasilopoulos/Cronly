import { Injectable } from '@nestjs/common';
import { isUnlimited, quotaForPlan, type PlanQuota, type QuotaKey } from '@cronapp/rbac';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaExceededException } from './quota.exception';

const QUOTA_KEYS: QuotaKey[] = ['maxJobs', 'maxMembers', 'maxChannels', 'maxConcurrency'];

/**
 * Keep only recognised quota keys whose value is an integer >= -1 (-1 =
 * unlimited). Anything else in the stored overrides blob is ignored, so a
 * malformed settings.quotas can never widen or corrupt a tenant's limits.
 */
function sanitizeOverrides(raw: unknown): Partial<PlanQuota> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<PlanQuota> = {};
  for (const key of QUOTA_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= -1) out[key] = v;
  }
  return out;
}

export interface UsageItem {
  key: QuotaKey;
  label: string;
  used: number | null; // null = not counted here (e.g. live concurrency)
  limit: number; // -1 = unlimited
}

export interface TenantUsage {
  plan: string;
  limits: PlanQuota;
  items: UsageItem[];
}

/**
 * Enforces and reports per-plan quotas (see PLAN_QUOTAS in @cronapp/rbac).
 *
 * Creation caps (jobs, members, channels) are checked here before a resource is
 * created; per-tenant concurrency is enforced in the worker. All counts run
 * inside the tenant's RLS scope so they can never leak across tenants, while the
 * plan itself lives outside RLS and is read as super-admin.
 */
@Injectable()
export class QuotaService {
  constructor(private readonly prisma: PrismaService) {}

  /** The tenant's plan name, defaulting to STARTER if somehow unset. */
  async planOf(tenantId: string): Promise<string> {
    const t = await this.prisma.asSuperAdmin((tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }),
    );
    return t?.plan ?? 'STARTER';
  }

  /**
   * The quota actually in force for a tenant: the plan's defaults with any
   * per-tenant overrides (stored under settings.quotas) laid on top. Overrides
   * let an operator raise or lower a single limit without changing plan.
   */
  async effectiveQuota(tenantId: string): Promise<{ plan: string; quota: PlanQuota }> {
    const t = await this.prisma.asSuperAdmin((tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { plan: true, settings: true } }),
    );
    const plan = t?.plan ?? 'STARTER';
    const base = quotaForPlan(plan);
    const settings = (t?.settings ?? {}) as Record<string, unknown>;
    const overrides = sanitizeOverrides(settings.quotas);
    return { plan, quota: { ...base, ...overrides } };
  }

  private count(tenantId: string, key: Exclude<QuotaKey, 'maxConcurrency'>): Promise<number> {
    return this.prisma.forTenant(tenantId, (tx) => {
      switch (key) {
        case 'maxJobs':
          return tx.job.count();
        case 'maxMembers':
          return tx.membership.count();
        case 'maxChannels':
          return tx.notificationChannel.count();
      }
    });
  }

  /**
   * Throw QuotaExceededException if creating one more `key` resource would put
   * the tenant at or over its plan limit. No-op for unlimited plans.
   */
  async assertCanAdd(tenantId: string, key: Exclude<QuotaKey, 'maxConcurrency'>): Promise<void> {
    const { plan, quota } = await this.effectiveQuota(tenantId);
    const limit = quota[key];
    if (isUnlimited(limit)) return;
    const used = await this.count(tenantId, key);
    if (used >= limit) throw new QuotaExceededException(key, plan, limit, used);
  }

  /** Current usage vs. limits for every quota — drives the web usage view. */
  async usage(tenantId: string): Promise<TenantUsage> {
    const { plan, quota: limits } = await this.effectiveQuota(tenantId);
    const counts = await this.prisma.forTenant(tenantId, async (tx) => {
      const [jobs, members, channels, running] = await Promise.all([
        tx.job.count(),
        tx.membership.count(),
        tx.notificationChannel.count(),
        tx.jobRun.count({ where: { status: 'RUNNING' } }),
      ]);
      return { jobs, members, channels, running };
    });
    return {
      plan,
      limits,
      items: [
        { key: 'maxJobs', label: 'Jobs', used: counts.jobs, limit: limits.maxJobs },
        { key: 'maxMembers', label: 'Members', used: counts.members, limit: limits.maxMembers },
        { key: 'maxChannels', label: 'Notification channels', used: counts.channels, limit: limits.maxChannels },
        { key: 'maxConcurrency', label: 'Concurrent runs', used: counts.running, limit: limits.maxConcurrency },
      ],
    };
  }
}
