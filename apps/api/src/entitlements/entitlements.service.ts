import { Injectable } from '@nestjs/common';
import {
  FEATURES,
  PLAN_FEATURES,
  PLAN_QUOTAS,
  QUOTA_LABELS,
  defaultFeaturesForPlan,
  quotaForPlan,
  type FeatureKey,
  type PlanQuota,
  type QuotaKey,
} from '@cronapp/rbac';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaService } from '../quota/quota.service';

const QUOTA_KEYS: QuotaKey[] = ['maxJobs', 'maxMembers', 'maxChannels', 'maxConcurrency'];

export interface EntitlementsView {
  plan: string;
  /** Effective limits in force (plan defaults with overrides applied). */
  quota: PlanQuota;
  /** The plan's own default limits, so the UI can show "default: N". */
  planDefaults: PlanQuota;
  /** Only the keys the tenant has explicitly overridden. */
  overrides: Partial<PlanQuota>;
  /** Features enabled for this tenant right now. */
  features: string[];
  /** The plan's own default feature set. */
  planFeatures: string[];
  /** Every feature that can be toggled, with a human label. */
  availableFeatures: { key: string; label: string }[];
  /** Labels for each quota key, for rendering. */
  quotaLabels: Record<string, string>;
}

const FEATURE_LABELS: Record<FeatureKey, string> = {
  'responses.export': 'Response export',
  'audit.log': 'Audit log',
  billing: 'Billing',
  'members.sso': 'SSO sign-in',
  'jobs.advanced': 'Advanced job controls',
};

export interface EntitlementsPatch {
  /** Partial overrides; a value of null clears that key back to the plan default. */
  quotas?: Record<string, number | null>;
  /** The full desired feature set (replaces the tenant's features list). */
  features?: string[];
}

@Injectable()
export class EntitlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
  ) {}

  async view(tenantId: string): Promise<EntitlementsView> {
    const t = await this.prisma.asSuperAdmin((tx) =>
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: { plan: true, features: true, settings: true },
      }),
    );
    const plan = t?.plan ?? 'STARTER';
    const settings = (t?.settings ?? {}) as Record<string, unknown>;
    const overrides = this.sanitizeOverrides(settings.quotas);
    const planDefaults = quotaForPlan(plan);
    return {
      plan,
      quota: { ...planDefaults, ...overrides },
      planDefaults,
      overrides,
      features: t?.features ?? [],
      planFeatures: defaultFeaturesForPlan(plan),
      availableFeatures: FEATURES.map((key) => ({ key, label: FEATURE_LABELS[key] ?? key })),
      quotaLabels: QUOTA_LABELS,
    };
  }

  /**
   * Apply overrides and/or a new feature set. Overrides are stored under
   * settings.quotas; passing null for a key removes that override (reverts to
   * the plan default). Features are validated against the catalog.
   */
  async update(tenantId: string, patch: EntitlementsPatch): Promise<EntitlementsView> {
    const current = await this.prisma.asSuperAdmin((tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { features: true, settings: true } }),
    );
    const settings = { ...((current?.settings ?? {}) as Record<string, unknown>) };

    if (patch.quotas) {
      const existing = this.sanitizeOverrides(settings.quotas);
      for (const key of QUOTA_KEYS) {
        if (!(key in patch.quotas)) continue;
        const v = patch.quotas[key];
        if (v === null) {
          delete existing[key];
        } else if (typeof v === 'number' && Number.isInteger(v) && v >= -1) {
          existing[key] = v;
        }
      }
      if (Object.keys(existing).length > 0) settings.quotas = existing;
      else delete settings.quotas;
    }

    const data: { settings: Record<string, unknown>; features?: string[] } = { settings };
    if (patch.features) {
      const valid = new Set<string>(FEATURES);
      data.features = [...new Set(patch.features.filter((f) => valid.has(f)))];
    }

    await this.prisma.asSuperAdmin((tx) =>
      tx.tenant.update({ where: { id: tenantId }, data: data as any }),
    );
    return this.view(tenantId);
  }

  private sanitizeOverrides(raw: unknown): Partial<PlanQuota> {
    if (!raw || typeof raw !== 'object') return {};
    const out: Partial<PlanQuota> = {};
    for (const key of QUOTA_KEYS) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === 'number' && Number.isInteger(v) && v >= -1) out[key] = v;
    }
    return out;
  }
}

// Re-export so the controller's DTO validation can reference plan names if needed.
export { PLAN_QUOTAS };
