import { PrismaClient, Prisma } from '@prisma/client';

export * from '@prisma/client';
export * from './crypto';
export * from './json';

let _prisma: PrismaClient | undefined;

/** Singleton PrismaClient (one connection pool per process). */
export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      log: ['warn', 'error'],
    });
  }
  return _prisma;
}

/**
 * Tenant-scoped models — those carrying a `tenantId` column. `Tenant` itself is
 * fenced on its own `id`. These are exactly the tables that were protected by
 * PostgreSQL Row-Level Security before the move to MariaDB. Child tables
 * (RolePermission, MembershipRole, PermissionOverride) carry no tenantId and are
 * only ever reached through their parent row, so they inherit isolation the same
 * way they did under RLS. User / RefreshToken / PasswordResetToken /
 * PushSubscription / AppConfig / SmtpConfig are identity- or instance-scoped and
 * are intentionally NOT fenced (the API scopes them by userId where relevant).
 */
const TENANT_ID_MODELS = new Set<string>([
  'Membership',
  'Role',
  'Job',
  'JobRun',
  'AuditLog',
  'Secret',
  'NotificationChannel',
  'AlertRule',
  'ApiKey',
  'Notification',
  'NotificationPref',
  'MessageTemplate',
]);

/** The column a given model is fenced on, or null if the model is not fenced. */
function fenceField(model: string | undefined): 'id' | 'tenantId' | null {
  if (model === 'Tenant') return 'id';
  if (model && TENANT_ID_MODELS.has(model)) return 'tenantId';
  return null;
}

/**
 * Application-layer tenant isolation.
 *
 * MariaDB/MySQL has no row-level security, so isolation is enforced HERE: a
 * Prisma client extension injects the tenant predicate into every query against
 * a tenant-scoped model and stamps `tenantId` onto every insert. A service query
 * that forgets a tenant filter still cannot read or write another tenant's rows —
 * an attempt to update/delete a row that belongs to another tenant simply matches
 * nothing (P2025), exactly as RLS would have blocked it.
 *
 * NOTE: this fences Prisma MODEL operations only. Raw SQL ($queryRaw /
 * $executeRaw) is NOT auto-scoped, so any raw query run inside withTenant() must
 * carry its own `tenantId = ...` predicate.
 */
function tenantGuard(tenantId: string) {
  return Prisma.defineExtension({
    name: 'tenant-guard',
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        $allOperations({ model, operation, args, query }: any) {
          const field = fenceField(model);
          if (!field) return query(args);

          const a = (args ?? {}) as Record<string, any>;
          const stamp = (d: any) => ({ ...(d ?? {}), [field]: tenantId });
          const fenceWhere = () => {
            a.where = { ...(a.where ?? {}), [field]: tenantId };
          };

          switch (operation) {
            case 'create':
              if (field === 'tenantId') a.data = stamp(a.data);
              break;
            case 'createMany':
            case 'createManyAndReturn':
              if (field === 'tenantId') {
                a.data = Array.isArray(a.data) ? a.data.map(stamp) : stamp(a.data);
              }
              break;
            case 'upsert':
              fenceWhere();
              if (field === 'tenantId') a.create = stamp(a.create);
              break;
            default:
              // find* / update* / delete* / count / aggregate / groupBy — all
              // take a `where`, which we fence to this tenant.
              fenceWhere();
          }
          return query(a);
        },
      },
    },
  });
}

/**
 * Run `fn` inside a transaction scoped to a single tenant. Every query `fn` makes
 * through the provided client is automatically fenced to `tenantId` by the
 * extension above — this is the ONLY sanctioned way for the app to touch tenant
 * data.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const scoped = getPrisma().$extends(tenantGuard(tenantId));
  return scoped.$transaction((tx) => fn(tx as unknown as Prisma.TransactionClient), {
    timeout: opts?.timeoutMs ?? 15000,
  });
}

/**
 * Super-admin / platform escape hatch. Runs `fn` with NO tenant fencing. Call
 * ONLY after verifying the principal is a platform super-admin — never from
 * user-controlled input.
 */
export async function asSuperAdmin<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return getPrisma().$transaction((tx) => fn(tx));
}
