import { Module, Logger } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BILLING_DRIVER, type BillingDriver } from './drivers/billing-driver';
import { LocalBillingDriver } from './drivers/local-billing.driver';
import { StripeBillingDriver } from './drivers/stripe-billing.driver';

/**
 * Billing. The active driver is chosen by the BILLING_DRIVER env var:
 *   - "local"  (default) — self-hosted, plan changes apply immediately
 *   - "stripe"           — hosted checkout (requires STRIPE_SECRET_KEY + prices)
 */
@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    LocalBillingDriver,
    StripeBillingDriver,
    {
      provide: BILLING_DRIVER,
      inject: [LocalBillingDriver, StripeBillingDriver],
      useFactory: (local: LocalBillingDriver, stripe: StripeBillingDriver): BillingDriver => {
        const choice = (process.env.BILLING_DRIVER ?? 'local').toLowerCase();
        const driver = choice === 'stripe' ? stripe : local;
        new Logger('BillingModule').log(`Billing driver: ${driver.kind} (${driver.label})`);
        return driver;
      },
    },
  ],
})
export class BillingModule {}
