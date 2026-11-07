import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { defaultFeaturesForPlan } from '@cronapp/rbac';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { QuotaService } from '../quota/quota.service';
import type { Principal } from '../rbac/principal.service';
import { BILLING_DRIVER, type BillingDriver } from './drivers/billing-driver';
import {
  ALL_FEATURE_LABELS,
  isKnownPlan,
  planCatalog,
  planRank,
} from './plans.catalog';

function startOfMonthUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly quota: QuotaService,
    @Inject(BILLING_DRIVER) private readonly driver: BillingDriver,
  ) {}

  /** Everything the billing page renders: current plan, catalog, usage. */
  async overview(tenantId: string) {
    const tenant = await this.prisma.forTenant(tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { plan: true, features: true } }),
    );
    const plan = tenant?.plan ?? 'STARTER';

    const periodStart = startOfMonthUTC();
    const runsThisMonth = await this.prisma.forTenant(tenantId, (tx) =>
      tx.jobRun.count({ where: { scheduledAt: { gte: periodStart } } }),
    );
    const usage = await this.quota.usage(tenantId);

    return {
      driver: { kind: this.driver.kind, label: this.driver.label, immediate: this.driver.immediate },
      plan,
      planRank: planRank(plan),
      features: tenant?.features ?? [],
      allFeatures: ALL_FEATURE_LABELS,
      plans: planCatalog(),
      usage: {
        runsThisMonth,
        periodStart: periodStart.toISOString(),
        quota: usage.items,
      },
    };
  }

  /**
   * Self-serve plan change. With the local driver this applies immediately and
   * — crucially for the acceptance criterion — resets the tenant's feature set
   * to the new plan's defaults, so upgrading unlocks gated capabilities at once.
   * With a hosted driver the plan is applied later, on payment confirmation, and
   * the caller is handed a checkout URL to redirect to.
   */
  async changePlan(p: Principal, targetPlan: string, returnUrl?: string) {
    if (!isKnownPlan(targetPlan)) throw new BadRequestException(`Unknown plan "${targetPlan}"`);

    const tenant = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: p.tenantId }, select: { plan: true } }),
    );
    const currentPlan = tenant?.plan ?? 'STARTER';
    if (currentPlan === targetPlan) {
      throw new BadRequestException(`Already on the ${targetPlan} plan`);
    }

    const decision = await this.driver.decidePlanChange({
      tenantId: p.tenantId,
      currentPlan,
      targetPlan,
      returnUrl,
    });

    if (decision.mode === 'checkout') {
      await this.audit.record_for(p, 'billing.checkout.started', p.tenantId, {
        from: currentPlan,
        to: targetPlan,
        driver: this.driver.kind,
      });
      return { applied: false as const, checkoutUrl: decision.checkoutUrl, plan: currentPlan };
    }

    // mode === 'apply' — provision the plan now.
    const features = defaultFeaturesForPlan(targetPlan);
    const updated = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.tenant.update({
        where: { id: p.tenantId },
        data: { plan: targetPlan as never, features },
        select: { plan: true, features: true },
      }),
    );

    const upgrade = planRank(targetPlan) > planRank(currentPlan);
    await this.audit.record_for(p, 'billing.plan.changed', p.tenantId, {
      from: currentPlan,
      to: targetPlan,
      direction: upgrade ? 'upgrade' : 'downgrade',
      features: updated.features,
    });

    return {
      applied: true as const,
      plan: updated.plan,
      features: updated.features,
      direction: upgrade ? ('upgrade' as const) : ('downgrade' as const),
    };
  }
}
