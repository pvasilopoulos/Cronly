import { PrismaClient, Prisma } from '@prisma/client';

export * from '@prisma/client';
export * from './crypto';

let _prisma: PrismaClient | undefined;

/**
 * Force every DB session to UTC. Prisma stores `DateTime` values UTC-naive, but
 * raw-SQL `now()` / interval math is evaluated in the session's timezone — which
 * defaults to the server's OS zone. On a non-UTC box that skews every
 * `column < now() - interval` comparison (scheduler claims, reaper sweeps,
 * heartbeat monitor), making jobs fire every tick. Pinning the session to UTC
 * makes those comparisons match the stored values. See ROADMAP #4.
 */
function utcDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  if (/[?&]options=/.test(raw) || /timezone/i.test(raw)) return raw; // caller set it
  return raw + (raw.includes('?') ? '&' : '?') + 'options=-c%20timezone%3DUTC';
}

/** Singleton PrismaClient (one connection pool per process). */
export function getPrisma(): PrismaClient {
  if (!_prisma) {
    const url = utcDatabaseUrl();
    _prisma = new PrismaClient({
      ...(url ? { datasources: { db: { url } } } : {}),
      log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
    });
  }
  return _prisma;
}

/**
 * Run `fn` inside a transaction scoped to a single tenant. The session variable
 * `app.current_tenant` is set first, so PostgreSQL RLS fences every query to
 * that tenant regardless of what `fn` does. This is the ONLY sanctioned way for
 * the app to touch tenant data.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const prisma = getPrisma();
  return prisma.$transaction(
    async (tx) => {
      // set_config(key, value, is_local=true) → scoped to this transaction only.
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return fn(tx);
    },
    { timeout: opts?.timeoutMs ?? 15000 },
  );
}

/**
 * Super-admin / platform escape hatch. Disables RLS for the transaction. Call
 * ONLY after verifying the principal is a platform super-admin — never from
 * user-controlled input.
 */
export async function asSuperAdmin<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return fn(tx);
  });
}
