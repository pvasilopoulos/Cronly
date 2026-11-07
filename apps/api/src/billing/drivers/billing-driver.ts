/**
 * Billing driver abstraction. The rest of the billing module never talks to a
 * payment provider directly — it asks the configured driver what should happen
 * when a tenant chooses a plan. This keeps the self-hosted path (no payment
 * provider at all) and a future hosted-SaaS path (Stripe) behind one seam.
 */
export const BILLING_DRIVER = Symbol('BILLING_DRIVER');

export interface PlanChangeRequest {
  tenantId: string;
  currentPlan: string;
  targetPlan: string;
  /** Where to send the user back to after an external checkout, if any. */
  returnUrl?: string;
}

export type PlanChangeDecision =
  // Apply the plan immediately in our own database (self-hosted / manual billing).
  | { mode: 'apply' }
  // Redirect the user to an external hosted checkout; the plan is applied later,
  // when the provider confirms payment (e.g. a Stripe webhook).
  | { mode: 'checkout'; checkoutUrl: string };

export interface BillingDriver {
  readonly kind: 'local' | 'stripe';
  readonly label: string;
  /** True when a plan change takes effect instantly (no external checkout). */
  readonly immediate: boolean;
  decidePlanChange(req: PlanChangeRequest): Promise<PlanChangeDecision>;
}
