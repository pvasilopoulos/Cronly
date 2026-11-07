import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/jwt.strategy';

/**
 * Gate for the platform console. These routes are tenant-agnostic (no
 * `@RequirePermissions`, so the global PermissionsGuard waves them through) and
 * must be reachable ONLY by a verified platform super-admin — never by a tenant
 * owner, however many permissions they hold. The JWT guard has already populated
 * `req.user` by the time this runs.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (!req.user?.isSuperAdmin) {
      throw new ForbiddenException('Platform super-admin access required');
    }
    return true;
  }
}
