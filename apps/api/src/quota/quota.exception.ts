import { HttpException } from '@nestjs/common';
import { QUOTA_LABELS, type QuotaKey } from '@cronapp/rbac';

/**
 * Raised when a tenant tries to create a resource beyond its plan quota.
 *
 * Uses HTTP 402 (Payment Required) so the web console can tell a quota wall
 * apart from an ordinary 400/403 and offer an upgrade path. The body carries
 * the machine-readable `quota`, `plan`, `limit` and `used` fields alongside a
 * human-readable message.
 */
export class QuotaExceededException extends HttpException {
  constructor(quota: QuotaKey, plan: string, limit: number, used: number) {
    const label = QUOTA_LABELS[quota];
    super(
      {
        statusCode: 402,
        error: 'Quota Exceeded',
        message: `Your ${plan} plan allows ${limit} ${label}. Upgrade your plan to add more.`,
        quota,
        plan,
        limit,
        used,
      },
      402,
    );
  }
}
