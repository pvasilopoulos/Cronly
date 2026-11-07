import { Injectable } from '@nestjs/common';
import type { BillingDriver, PlanChangeDecision } from './billing-driver';

/**
 * Self-hosted / manual billing. There is no payment provider, so a plan change
 * is applied immediately. This is the default driver and the right one for a
 * single-company deployment or an on-prem install where plans are provisioned
 * by an operator rather than paid for by card.
 */
@Injectable()
export class LocalBillingDriver implements BillingDriver {
  readonly kind = 'local' as const;
  readonly label = 'Self-hosted (no payment provider)';
  readonly immediate = true;

  async decidePlanChange(): Promise<PlanChangeDecision> {
    return { mode: 'apply' };
  }
}
