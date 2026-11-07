import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { BillingDriver, PlanChangeDecision, PlanChangeRequest } from './billing-driver';

/**
 * Hosted-SaaS billing via Stripe Checkout. This is the Stripe-ready seam: when
 * `STRIPE_SECRET_KEY` and a price for the target plan are configured, a plan
 * change produces a Checkout Session URL and the plan is applied on the
 * `checkout.session.completed` webhook (handled elsewhere when wired).
 *
 * The HTTP call to Stripe is intentionally left as a single, clearly-marked
 * integration point so this ships without a hard `stripe` dependency; until a
 * secret key is present the driver refuses cleanly rather than pretending.
 */
@Injectable()
export class StripeBillingDriver implements BillingDriver {
  readonly kind = 'stripe' as const;
  readonly label = 'Stripe Checkout';
  readonly immediate = false;

  private readonly secretKey = process.env.STRIPE_SECRET_KEY ?? '';

  /** Per-plan Stripe Price IDs, e.g. STRIPE_PRICE_PRO=price_123. */
  private priceId(plan: string): string | undefined {
    return process.env[`STRIPE_PRICE_${plan}`];
  }

  async decidePlanChange(req: PlanChangeRequest): Promise<PlanChangeDecision> {
    if (!this.secretKey) {
      throw new ServiceUnavailableException(
        'Stripe billing is selected but STRIPE_SECRET_KEY is not configured.',
      );
    }
    const price = this.priceId(req.targetPlan);
    if (!price) {
      throw new ServiceUnavailableException(
        `No Stripe price configured for the ${req.targetPlan} plan (set STRIPE_PRICE_${req.targetPlan}).`,
      );
    }
    // ── Stripe integration point ──────────────────────────────────────────
    // const stripe = new Stripe(this.secretKey);
    // const session = await stripe.checkout.sessions.create({
    //   mode: 'subscription',
    //   line_items: [{ price, quantity: 1 }],
    //   client_reference_id: req.tenantId,
    //   success_url: req.returnUrl ?? '...',
    //   cancel_url: req.returnUrl ?? '...',
    // });
    // return { mode: 'checkout', checkoutUrl: session.url! };
    throw new ServiceUnavailableException(
      'Stripe checkout is not wired in this build. Install the `stripe` package and complete the integration point in StripeBillingDriver.',
    );
  }
}
