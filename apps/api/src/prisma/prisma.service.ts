import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { getPrisma, withTenant, asSuperAdmin, Prisma, PrismaClient } from '@cronapp/database';

/**
 * Thin wrapper over the shared Prisma client. Prefer `forTenant` for all
 * tenant-scoped work — it opens an RLS-fenced transaction so a missing filter
 * can never cross tenants.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  get client(): PrismaClient {
    return getPrisma();
  }

  forTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return withTenant(tenantId, fn);
  }

  asSuperAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return asSuperAdmin(fn);
  }

  async onModuleDestroy() {
    await getPrisma().$disconnect();
  }
}
