import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './decorators';
import { ApiKeysService } from '../apikeys/apikeys.service';

/**
 * Authenticates every request by one of two mechanisms:
 *   • `Authorization: Bearer cak_…`  → a tenant-scoped API key (programmatic).
 *   • `Authorization: Bearer <jwt>`  → an interactive console session.
 * API keys carry their own tenant + scopes, which PermissionsGuard reads from
 * `req.apiKey`; JWT sessions resolve the tenant from the `x-tenant-id` header.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeysService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header = req.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer cak_')) {
      const token = header.slice('Bearer '.length);
      const key = await this.apiKeys.verify(token);
      if (!key) throw new UnauthorizedException('Invalid or expired API key');
      // Shape a minimal AuthUser plus the api-key context for PermissionsGuard.
      req.user = { userId: key.createdBy ?? `apikey:${key.id}`, email: '', isSuperAdmin: false };
      req.apiKey = { id: key.id, tenantId: key.tenantId, scopes: key.scopes };
      return true;
    }

    return (await super.canActivate(context)) as boolean;
  }
}
