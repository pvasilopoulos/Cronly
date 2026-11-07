import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@cronapp/rbac';
import { PERMISSIONS_KEY } from '../auth/decorators';
import { PrincipalService } from './principal.service';

/**
 * Runs after JwtAuthGuard. For any route decorated with @RequirePermissions it:
 *   1. reads the active tenant from the `x-tenant-id` header,
 *   2. resolves the caller's principal in that tenant (membership + roles +
 *      overrides + feature gating),
 *   3. requires the caller to hold every listed permission key,
 * and attaches the principal to the request for controllers to use.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly principals: PrincipalService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true; // route is tenant-agnostic

    const req = context.switchToHttp().getRequest();

    // API-key requests carry their own tenant + scopes (set by JwtAuthGuard);
    // the x-tenant-id header does not apply to them.
    if (req.apiKey) {
      const principal = await this.principals.loadFromScopes(
        req.user.userId,
        req.apiKey.tenantId,
        req.apiKey.scopes,
      );
      req.principal = principal;
      const missing = required.filter((key) => !principal.keys.has(key));
      if (missing.length > 0) {
        throw new ForbiddenException(`API key missing scope(s): ${missing.join(', ')}`);
      }
      return true;
    }

    const tenantId = req.headers['x-tenant-id'];
    if (!tenantId || typeof tenantId !== 'string') {
      throw new BadRequestException('Missing x-tenant-id header');
    }

    const principal = await this.principals.load(req.user, tenantId);
    req.principal = principal;

    const missing = required.filter((key) => !principal.keys.has(key));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
