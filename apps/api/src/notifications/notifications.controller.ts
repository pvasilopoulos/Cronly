import { BadRequestException, Body, Controller, Get, Headers, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/jwt.strategy';
import { NotificationsService } from './notifications.service';
import { MarkReadDto, PushSubscribeDto, PushUnsubscribeDto, UpdatePrefsDto } from './notifications.dto';

/**
 * Per-user live notifications and the user's notification policy. These are
 * scoped to the caller + active tenant (x-tenant-id), not a shared resource, so
 * there is no permission gate — any member manages their own feed and prefs.
 * The service resolves (and validates) the principal from the user + tenant.
 */
@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  private tenant(h?: string): string {
    if (!h) throw new BadRequestException('Missing x-tenant-id header');
    return h;
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Headers('x-tenant-id') tenantId?: string) {
    return this.svc.list(user, this.tenant(tenantId));
  }

  @Post('read')
  markRead(@CurrentUser() user: AuthUser, @Body() dto: MarkReadDto, @Headers('x-tenant-id') tenantId?: string) {
    return this.svc.markRead(user, this.tenant(tenantId), dto.ids);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: AuthUser, @Headers('x-tenant-id') tenantId?: string) {
    return this.svc.markAllRead(user, this.tenant(tenantId));
  }

  @Post('test')
  test(@CurrentUser() user: AuthUser, @Headers('x-tenant-id') tenantId?: string) {
    return this.svc.createTest(user, this.tenant(tenantId));
  }

  @Get('prefs')
  getPrefs(@CurrentUser() user: AuthUser, @Headers('x-tenant-id') tenantId?: string) {
    return this.svc.getPrefs(user, this.tenant(tenantId));
  }

  @Put('prefs')
  putPrefs(@CurrentUser() user: AuthUser, @Body() dto: UpdatePrefsDto, @Headers('x-tenant-id') tenantId?: string) {
    return this.svc.putPrefs(user, this.tenant(tenantId), dto);
  }

  // ── Web Push (per-user device subscriptions; tenant-agnostic) ──

  @Get('vapid')
  vapid() {
    return this.svc.vapidPublicKey();
  }

  @Post('push/subscribe')
  subscribePush(@CurrentUser() user: AuthUser, @Body() dto: PushSubscribeDto) {
    return this.svc.subscribePush(user, dto.endpoint, dto.keys, dto.ua);
  }

  @Post('push/unsubscribe')
  unsubscribePush(@CurrentUser() user: AuthUser, @Body() dto: PushUnsubscribeDto) {
    return this.svc.unsubscribePush(user, dto.endpoint);
  }
}
