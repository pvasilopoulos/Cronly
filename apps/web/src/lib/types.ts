export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
}

/** Instance-wide branding (GET /app-config), set by a platform super-admin. */
export interface AppConfig {
  name: string;
  icon: string;
  /** Optional custom logo as an image data: URL; null/absent → use the glyph. */
  logo?: string | null;
  /** Brand-mark display size (px) in the console shell. */
  logoScale?: number;
  /** Optional custom browser-tab favicon as an image data: URL. */
  favicon?: string | null;
  /** Ordered nav hrefs shown in the mobile/tablet footer bar. */
  mobileNav?: string[];
}

export interface Me {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  tenants: Tenant[];
}

export interface PermissionDef {
  key: string;
  resource: string;
  action: string;
  label: string;
  description: string;
  requiresFeature?: string;
}

export interface MyPermissions {
  tenantId: string;
  isSuperAdmin: boolean;
  keys: string[];
  permissions: { key: string; conditions?: Record<string, unknown> }[];
  catalog: PermissionDef[];
  features: string[];
}

export type JobStatus = 'ACTIVE' | 'PAUSED';
export type RunStatus =
  | 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'WARNING' | 'FAILED' | 'TIMEOUT' | 'DEAD_LETTER';

export interface Job {
  id: string;
  name: string;
  slug: string;
  handler: string;
  cronExpr: string;
  timezone: string;
  tags: string[];
  group: string | null;
  status: JobStatus;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  maxRetries: number;
  timeoutMs: number;
  description?: string | null;
  runbookUrl?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  heartbeatEnabled?: boolean;
  heartbeatState?: HeartbeatState;
}

export type OverlapPolicy = 'ALLOW' | 'SKIP' | 'QUEUE';

/** Full job row from GET /jobs/:id — includes the handler payload for editing. */
export interface JobDetail extends Job {
  payload: Record<string, unknown>;
  concurrencyKey: string | null;
  overlapPolicy: OverlapPolicy;
  createdBy?: string | null;
}

export type HeartbeatState = 'OK' | 'MISSING';

export interface Heartbeat {
  enabled: boolean;
  token: string | null;
  pingUrl: string | null;
  intervalSec: number | null;
  graceSec: number;
  lastPingAt: string | null;
  state: HeartbeatState;
  alertedAt: string | null;
}

export interface Run {
  id: string;
  jobId: string;
  status: RunStatus;
  attempt: number;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  contentType: string | null;
  responseSize: number | null;
  preview: string | null;
  truncated: boolean;
  error: string | null;
  job?: { name: string };
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: { permission: string }[];
  _count?: { members: number };
}

export interface Member {
  id: string;
  status: string;
  user: { id: string; name: string; email: string; status: string } | null;
  roles: { id: string; name: string; key: string }[];
  overrides: { permission: string; effect: 'GRANT' | 'DENY'; conditions?: unknown }[];
}

export interface Secret {
  id: string;
  name: string;
  hint: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChannelType = 'EMAIL' | 'SLACK' | 'WEBHOOK' | 'TELEGRAM';
export type AlertStatus = 'FAILED' | 'TIMEOUT' | 'DEAD_LETTER' | 'WARNING' | 'SUCCESS';

export interface NotificationChannel {
  id: string;
  type: ChannelType;
  name: string;
  target: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Returned only by POST /api-keys — the plaintext token, shown exactly once.
export interface ApiKeyCreated extends ApiKey {
  token: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  target: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  actor: { id: string; name: string | null; email: string | null } | null;
}

export interface UsageItem {
  key: 'maxJobs' | 'maxMembers' | 'maxChannels' | 'maxConcurrency';
  label: string;
  used: number | null;
  limit: number; // -1 = unlimited
}

export interface TenantUsage {
  plan: string;
  limits: Record<string, number>;
  items: UsageItem[];
}

export interface Entitlements {
  plan: string;
  quota: Record<string, number>;
  planDefaults: Record<string, number>;
  overrides: Record<string, number>;
  features: string[];
  planFeatures: string[];
  availableFeatures: { key: string; label: string }[];
  quotaLabels: Record<string, string>;
}

// ─── Platform console (super-admin only) ───
export interface AdminTenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'TRIAL';
  timezone: string;
  features: string[];
  createdAt: string;
  counts: { members: number; jobs: number; roles: number };
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  status: 'ACTIVE' | 'INVITED' | 'DISABLED';
  isSuperAdmin: boolean;
  createdAt: string;
  memberships: number;
}

export interface AdminTenantMembers {
  tenant: { id: string; name: string; slug: string; plan: string };
  roles: { id: string; name: string; key: string; isSystem: boolean }[];
  members: {
    id: string;
    status: string;
    user: { id: string; name: string; email: string; status: string; isSuperAdmin: boolean } | null;
    roles: { id: string; name: string; key: string }[];
  }[];
}

// ─── Email delivery settings (super-admin) ───
export type MailProvider = 'smtp' | 'microsoft365' | 'gmail';

export interface SmtpSettings {
  enabled: boolean;
  provider: MailProvider;
  // SMTP
  host: string | null;
  port: number;
  secure: boolean;
  username: string | null;
  fromAddr: string | null;
  hasPassword: boolean;
  // Microsoft 365
  msTenantId: string | null;
  msClientId: string | null;
  hasMsSecret: boolean;
  // Gmail
  gmailClientEmail: string | null;
  hasGmailKey: boolean;
  // Status
  envFallback: boolean;
  effectiveConfigured: boolean;
}

// ─── Billing (#15) ───
export interface BillingPlan {
  key: string;
  label: string;
  blurb: string;
  priceCents: number | null;
  rank: number;
  features: string[];
  featureLabels: string[];
  quota: { maxJobs: number; maxMembers: number; maxChannels: number; maxConcurrency: number };
}

export interface BillingOverview {
  driver: { kind: 'local' | 'stripe'; label: string; immediate: boolean };
  plan: string;
  planRank: number;
  features: string[];
  allFeatures: { key: string; label: string }[];
  plans: BillingPlan[];
  usage: {
    runsThisMonth: number;
    periodStart: string;
    quota: UsageItem[];
  };
}

export interface ChangePlanResult {
  applied: boolean;
  plan: string;
  features?: string[];
  checkoutUrl?: string;
  direction?: 'upgrade' | 'downgrade';
}

// ─── Live notifications + per-user policy ───
export interface Notification {
  id: string;
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  body: string | null;
  jobId: string | null;
  runId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: Notification[];
  unread: number;
}

export interface NotificationPrefs {
  events: string[];
  browser: boolean;
  quietStart: string | null;
  quietEnd: string | null;
  quietTz: string;
  catalog: { key: string; label: string; severity: string }[];
}

// ─── Message templates (per-workspace outbound copy with variables) ───
export interface TemplateCatalogEvent {
  key: string;
  label: string;
  severity: string;
}
export interface TemplateCatalogChannel {
  key: string;
  label: string;
  hasSubject: boolean;
  json: boolean;
  note: string;
}
export interface TemplateVariable {
  key: string;
  label: string;
  scope: 'all' | 'failure' | 'heartbeat';
  sample: string;
}
export interface EffectiveTemplate {
  event: string;
  channel: string;
  subject: string | null;
  body: string;
  enabled: boolean;
  isCustom: boolean;
}
export interface TemplatesPayload {
  events: TemplateCatalogEvent[];
  channels: TemplateCatalogChannel[];
  variables: TemplateVariable[];
  templates: EffectiveTemplate[];
}

export interface AlertRule {
  id: string;
  channelId: string;
  jobId: string | null;
  threshold: number;
  onStatuses: AlertStatus[];
  subject: string | null;
  body: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  channel?: { id: string; name: string; type: ChannelType };
}
