// The permission catalog: the single source of truth for every action a
// principal can be granted in CronApp. The UI builds its permission matrix from
// this list, roles store subsets of these keys, and the CASL ability is built
// from the keys a principal effectively holds.
//
// Key format: "<resource>:<action>".

export type PermissionKey = `${string}:${string}`;

export interface PermissionDef {
  key: PermissionKey;
  resource: string;
  action: string;
  label: string;
  description: string;
  /** When set, the permission only takes effect if the tenant's plan enables
   *  this feature. Lets a plan downgrade hide capabilities instantly. */
  requiresFeature?: FeatureKey;
}

export const RESOURCES = [
  'jobs',
  'runs',
  'responses',
  'secrets',
  'alerts',
  'members',
  'roles',
  'settings',
  'apikeys',
  'billing',
  'audit',
  'entitlements',
] as const;
export type Resource = (typeof RESOURCES)[number];

export const PERMISSIONS: PermissionDef[] = [
  // Jobs
  { key: 'jobs:read',    resource: 'jobs', action: 'read',    label: 'View jobs',        description: 'See cron jobs and their schedules' },
  { key: 'jobs:create',  resource: 'jobs', action: 'create',  label: 'Create jobs',      description: 'Add new cron jobs' },
  { key: 'jobs:update',  resource: 'jobs', action: 'update',  label: 'Edit jobs',        description: 'Change schedule, payload, settings' },
  { key: 'jobs:delete',  resource: 'jobs', action: 'delete',  label: 'Delete jobs',      description: 'Permanently remove a job' },
  { key: 'jobs:run',     resource: 'jobs', action: 'run',     label: 'Run now',          description: 'Trigger an ad-hoc execution' },
  { key: 'jobs:toggle',  resource: 'jobs', action: 'toggle',  label: 'Pause / resume',   description: 'Enable or disable a job' },

  // Runs & responses
  { key: 'runs:read',           resource: 'runs',      action: 'read',     label: 'View executions',   description: 'See run history and status' },
  { key: 'responses:read',      resource: 'responses', action: 'read',     label: 'View responses',    description: 'Open the body returned by a run' },
  { key: 'responses:download',  resource: 'responses', action: 'download', label: 'Download responses', description: 'Export full response payloads', requiresFeature: 'responses.export' },

  // Secrets (encrypted credentials referenced from job payloads)
  { key: 'secrets:read',   resource: 'secrets', action: 'read',   label: 'View secrets',   description: 'See secret names (never values)' },
  { key: 'secrets:manage', resource: 'secrets', action: 'manage', label: 'Manage secrets', description: 'Create, rotate and delete secrets' },

  // Alerting (notification channels + rules)
  { key: 'alerts:read',   resource: 'alerts', action: 'read',   label: 'View alerts',   description: 'See notification channels and rules' },
  { key: 'alerts:manage', resource: 'alerts', action: 'manage', label: 'Manage alerts', description: 'Create and edit channels and alert rules' },

  // Members
  { key: 'members:read',   resource: 'members', action: 'read',   label: 'View members',   description: 'See who has access' },
  { key: 'members:invite', resource: 'members', action: 'invite', label: 'Invite members', description: 'Add people to the tenant' },
  { key: 'members:update', resource: 'members', action: 'update', label: 'Edit members',   description: 'Change a member’s roles and overrides' },
  { key: 'members:remove', resource: 'members', action: 'remove', label: 'Remove members', description: 'Revoke someone’s access' },

  // Roles
  { key: 'roles:read',   resource: 'roles', action: 'read',   label: 'View roles',   description: 'See roles and their permissions' },
  { key: 'roles:manage', resource: 'roles', action: 'manage', label: 'Manage roles', description: 'Create, edit and delete roles' },

  // Settings
  { key: 'settings:read',   resource: 'settings', action: 'read',   label: 'View settings',   description: 'See tenant configuration' },
  { key: 'settings:manage', resource: 'settings', action: 'manage', label: 'Manage settings', description: 'Change retention, concurrency, timezone' },

  // API keys (programmatic access to the public REST API)
  { key: 'apikeys:read',   resource: 'apikeys', action: 'read',   label: 'View API keys',   description: 'See API keys and their scopes (never the secret)' },
  { key: 'apikeys:manage', resource: 'apikeys', action: 'manage', label: 'Manage API keys', description: 'Create, scope and revoke API keys' },

  // Billing — intentionally NOT feature-gated: self-serve billing must stay
  // reachable on every plan (including STARTER/PRO) so an owner can always view
  // usage and upgrade. The `billing` feature flag remains in the catalog for
  // historical tenant data but no longer gates these permissions.
  { key: 'billing:read',   resource: 'billing', action: 'read',   label: 'View billing',   description: 'See plan, usage and invoices' },
  { key: 'billing:manage', resource: 'billing', action: 'manage', label: 'Manage billing', description: 'Change plan and payment method' },

  // Audit
  { key: 'audit:read', resource: 'audit', action: 'read', label: 'View audit log', description: 'See who changed what', requiresFeature: 'audit.log' },

  // Entitlements — per-tenant plan limits (quota overrides) and enabled features.
  { key: 'entitlements:read',   resource: 'entitlements', action: 'read',   label: 'View entitlements', description: 'See plan limits and enabled features' },
  { key: 'entitlements:manage', resource: 'entitlements', action: 'manage', label: 'Manage entitlements', description: 'Override plan limits and toggle features for this workspace' },
];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

const PERMISSION_BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));
export function getPermission(key: PermissionKey): PermissionDef | undefined {
  return PERMISSION_BY_KEY.get(key);
}

// ───────────────────── Feature gating (per plan) ─────────────────────

export const FEATURES = [
  'responses.export',
  'audit.log',
  'billing',
  'members.sso',
  'jobs.advanced', // concurrency keys, custom retries, long timeouts
] as const;
export type FeatureKey = (typeof FEATURES)[number];

export const PLAN_FEATURES: Record<string, FeatureKey[]> = {
  STARTER:    [],
  PRO:        ['responses.export', 'audit.log'],
  SCALE:      ['responses.export', 'audit.log', 'jobs.advanced', 'billing'],
  ENTERPRISE: ['responses.export', 'audit.log', 'jobs.advanced', 'billing', 'members.sso'],
};

export function defaultFeaturesForPlan(plan: string): FeatureKey[] {
  return PLAN_FEATURES[plan] ?? [];
}

// ───────────────────── Plan quotas (hard limits per plan) ─────────────────────
//
// Features gate *which capabilities exist*; quotas cap *how much* of a resource a
// tenant may consume. This is the single source of truth — the API enforces the
// creation caps, the worker enforces per-tenant concurrency, and the web console
// renders usage bars from the same numbers. Use UNLIMITED (-1) for no cap.

export const UNLIMITED = -1;
export function isUnlimited(limit: number): boolean {
  return limit < 0;
}

export type QuotaKey = 'maxJobs' | 'maxMembers' | 'maxChannels' | 'maxConcurrency';

export interface PlanQuota {
  /** Maximum cron jobs that may exist in the tenant. */
  maxJobs: number;
  /** Maximum seats (memberships, including pending invites). */
  maxMembers: number;
  /** Maximum notification channels. */
  maxChannels: number;
  /** Maximum simultaneously-RUNNING job executions for the tenant. */
  maxConcurrency: number;
}

export const QUOTA_LABELS: Record<QuotaKey, string> = {
  maxJobs: 'jobs',
  maxMembers: 'members',
  maxChannels: 'notification channels',
  maxConcurrency: 'concurrent runs',
};

export const PLAN_QUOTAS: Record<string, PlanQuota> = {
  STARTER:    { maxJobs: 5,   maxMembers: 2,  maxChannels: 1,  maxConcurrency: 1 },
  PRO:        { maxJobs: 50,  maxMembers: 10, maxChannels: 10, maxConcurrency: 5 },
  SCALE:      { maxJobs: 500, maxMembers: 50, maxChannels: 50, maxConcurrency: 20 },
  ENTERPRISE: { maxJobs: UNLIMITED, maxMembers: UNLIMITED, maxChannels: UNLIMITED, maxConcurrency: UNLIMITED },
};

export function quotaForPlan(plan: string): PlanQuota {
  return PLAN_QUOTAS[plan] ?? PLAN_QUOTAS.STARTER;
}

// ───────────────────── Role templates (seeded per tenant) ─────────────────────

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  permissions: PermissionKey[];
}

const ALL = ALL_PERMISSION_KEYS;

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control, including billing and roles.',
    permissions: ALL,
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Manage jobs, members and settings — everything except billing.',
    permissions: ALL.filter((k) => !k.startsWith('billing:')),
  },
  {
    key: 'operator',
    name: 'Operator',
    description: 'Run and manage jobs and view their responses.',
    permissions: [
      'jobs:read', 'jobs:create', 'jobs:update', 'jobs:run', 'jobs:toggle',
      'runs:read', 'responses:read', 'responses:download',
      'secrets:read', 'secrets:manage', 'alerts:read', 'alerts:manage',
      'members:read', 'roles:read', 'settings:read',
    ],
  },
  {
    key: 'analyst',
    name: 'Analyst',
    description: 'Read-only access to jobs, runs and responses.',
    permissions: ['jobs:read', 'runs:read', 'responses:read', 'members:read'],
  },
  {
    key: 'viewer',
    name: 'Read-only',
    description: 'See jobs and run status, nothing more.',
    permissions: ['jobs:read', 'runs:read'],
  },
];

export function getRoleTemplate(key: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((r) => r.key === key);
}
