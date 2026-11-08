import { randomBytes, scryptSync } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { ROLE_TEMPLATES, defaultFeaturesForPlan } from '../../rbac/src';

const prisma = new PrismaClient();

// Password hashing — scrypt, no native deps. Format: "salt_hex:hash_hex".
// The API's AuthService uses the exact same format (see apps/api auth).
function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function seedRoles(tx: Prisma.TransactionClient, tenantId: string) {
  const byKey: Record<string, string> = {};
  for (const tpl of ROLE_TEMPLATES) {
    const role = await tx.role.create({
      data: {
        tenantId,
        key: tpl.key,
        name: tpl.name,
        description: tpl.description,
        isSystem: true,
        permissions: {
          create: tpl.permissions.map((permission) => ({ permission })),
        },
      },
    });
    byKey[tpl.key] = role.id;
  }
  return byKey;
}

async function main() {
  await prisma.$transaction(
    async (tx) => {
      // Platform super-admin (your staff) — not a customer.
      await tx.user.upsert({
        where: { email: 'admin@cronapp.local' },
        update: {},
        create: {
          email: 'admin@cronapp.local',
          name: 'Platform Admin',
          passwordHash: hashPassword('admin1234'),
          isSuperAdmin: true,
        },
      });

      // ── Tenant: Acme Retail (SCALE) ──
      const acme = await tx.tenant.create({
        data: {
          name: 'Acme Retail',
          slug: 'acme',
          plan: 'SCALE',
          status: 'ACTIVE',
          timezone: 'Europe/Athens',
          features: defaultFeaturesForPlan('SCALE'),
          settings: { retentionDays: 30, maxConcurrency: 24, perTenantRateLimitPerMin: 120 },
        },
      });
      const acmeRoles = await seedRoles(tx, acme.id);

      // ── Tenant: Nordwind Logistics (PRO) ──
      const nordwind = await tx.tenant.create({
        data: {
          name: 'Nordwind Logistics',
          slug: 'nordwind',
          plan: 'PRO',
          status: 'ACTIVE',
          timezone: 'Europe/Berlin',
          features: defaultFeaturesForPlan('PRO'),
          settings: { retentionDays: 14, maxConcurrency: 8, perTenantRateLimitPerMin: 60 },
        },
      });
      const nordwindRoles = await seedRoles(tx, nordwind.id);

      // ── Users & memberships ──
      // Petros owns Acme, but is only an Analyst in Nordwind — same identity,
      // different access per tenant. That's the multi-tenant model.
      const petros = await tx.user.create({
        data: {
          email: 'petros@acme.gr',
          name: 'Petros Vasilopoulos',
          passwordHash: hashPassword('petros1234'),
          memberships: {
            create: [
              { tenantId: acme.id, roles: { create: [{ roleId: acmeRoles['owner'] }] } },
              { tenantId: nordwind.id, roles: { create: [{ roleId: nordwindRoles['analyst'] }] } },
            ],
          },
        },
      });

      const maria = await tx.user.create({
        data: {
          email: 'maria@acme.gr',
          name: 'Maria Konstantinou',
          passwordHash: hashPassword('maria1234'),
          memberships: {
            create: [{ tenantId: acme.id, roles: { create: [{ roleId: acmeRoles['operator'] }] } }],
          },
        },
      });

      // Fine-grained override: Maria is an Operator, but we DENY her the ability
      // to download full response payloads — without creating a new role.
      const mariaAcme = await tx.membership.findUniqueOrThrow({
        where: { userId_tenantId: { userId: maria.id, tenantId: acme.id } },
      });
      await tx.permissionOverride.create({
        data: { membershipId: mariaAcme.id, permission: 'responses:download', effect: 'DENY' },
      });

      // ── Jobs ──
      const now = Date.now();
      const acmeJobs = [
        { name: 'Inventory Sync',     slug: 'inventory-sync',     handler: 'http.request', cronExpr: '*/2 * * * *', tags: ['inventory'] },
        { name: 'Order Export → ERP', slug: 'order-export-erp',   handler: 'http.request', cronExpr: '* * * * *',   tags: ['orders'] },
        { name: 'Price Feed Pull',    slug: 'price-feed-pull',    handler: 'http.request', cronExpr: '*/5 * * * *', tags: ['pricing'] },
        { name: 'Nightly Reconcile',  slug: 'nightly-reconcile',  handler: 'http.request', cronExpr: '0 3 * * *',   tags: ['billing'] },
      ];
      for (let i = 0; i < acmeJobs.length; i++) {
        await tx.job.create({
          data: {
            tenantId: acme.id,
            ...acmeJobs[i],
            timezone: 'Europe/Athens',
            payload: { url: 'https://example.com/webhook', method: 'POST' },
            nextRunAt: new Date(now + (i + 1) * 60_000),
            createdBy: petros.id,
          },
        });
      }

      await tx.job.create({
        data: {
          tenantId: nordwind.id,
          name: 'Fleet GPS Ingest',
          slug: 'fleet-gps-ingest',
          handler: 'http.request',
          cronExpr: '* * * * *',
          timezone: 'Europe/Berlin',
          payload: { url: 'https://example.com/gps', method: 'GET' },
          nextRunAt: new Date(now + 60_000),
        },
      });
    },
    { timeout: 30_000 },
  );

  console.log('✔ Seed complete.');
  console.log('  Super-admin : admin@cronapp.local / admin1234');
  console.log('  Owner       : petros@acme.gr / petros1234  (Acme owner, Nordwind analyst)');
  console.log('  Operator    : maria@acme.gr / maria1234    (download DENIED via override)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
