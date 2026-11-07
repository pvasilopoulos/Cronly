import {
  PLAN_FEATURES,
  PLAN_QUOTAS,
  FEATURES,
  type FeatureKey,
  type PlanQuota,
} from '@cronapp/rbac';

export const PLAN_ORDER = ['STARTER', 'PRO', 'SCALE', 'ENTERPRISE'] as const;
export type PlanKey = (typeof PLAN_ORDER)[number];

/** Human-facing metadata that isn't part of the entitlement model. */
interface PlanMeta {
  label: string;
  blurb: string;
  /** Monthly price in euro cents; null = custom / contact sales. */
  priceCents: number | null;
}

const PLAN_META: Record<PlanKey, PlanMeta> = {
  STARTER: { label: 'Starter', blurb: 'For trying things out and small personal schedules.', priceCents: 0 },
  PRO: { label: 'Pro', blurb: 'For growing teams that need audit history and exports.', priceCents: 2900 },
  SCALE: { label: 'Scale', blurb: 'For production workloads with advanced job controls.', priceCents: 9900 },
  ENTERPRISE: { label: 'Enterprise', blurb: 'SSO, unlimited scale and a support SLA.', priceCents: null },
};

/** Short labels for the feature keys, so the pricing table reads nicely. */
const FEATURE_LABELS: Record<FeatureKey, string> = {
  'responses.export': 'Response exports',
  'audit.log': 'Audit log',
  billing: 'Self-serve billing',
  'members.sso': 'SSO / SAML',
  'jobs.advanced': 'Advanced job controls',
};

export interface PlanCatalogEntry {
  key: PlanKey;
  label: string;
  blurb: string;
  priceCents: number | null;
  rank: number;
  features: FeatureKey[];
  featureLabels: string[];
  quota: PlanQuota;
}

export function planRank(plan: string): number {
  const i = PLAN_ORDER.indexOf(plan as PlanKey);
  return i < 0 ? 0 : i;
}

export function isKnownPlan(plan: string): plan is PlanKey {
  return (PLAN_ORDER as readonly string[]).includes(plan);
}

export function featureLabel(key: string): string {
  return FEATURE_LABELS[key as FeatureKey] ?? key;
}

/** The whole plan catalog the pricing page renders. */
export function planCatalog(): PlanCatalogEntry[] {
  return PLAN_ORDER.map((key, rank) => {
    const features = PLAN_FEATURES[key] ?? [];
    return {
      key,
      label: PLAN_META[key].label,
      blurb: PLAN_META[key].blurb,
      priceCents: PLAN_META[key].priceCents,
      rank,
      features,
      featureLabels: features.map(featureLabel),
      quota: PLAN_QUOTAS[key],
    };
  });
}

export const ALL_FEATURE_LABELS = FEATURES.map((f) => ({ key: f, label: featureLabel(f) }));
