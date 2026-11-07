import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PrincipalService } from '../rbac/principal.service';
import type { AuthUser } from '../auth/jwt.strategy';
import type { UpdatePrefsDto } from './notifications.dto';

/** The catalog of notifiable events (also used by the policy UI). */
export const NOTIFICATION_EVENTS = [
  { key: 'job.failed', label: 'Job failed', severity: 'CRITICAL' },
  { key: 'job.timeout', label: 'Job timed out', severity: 'CRITICAL' },
  { key: 'job.dead_letter', label: 'Job dead-lettered', severity: 'CRITICAL' },
  { key: 'heartbeat.missed', label: 'Heartbeat missed', severity: 'WARNING' },
] as const;

const DEFAULT_EVENTS = NOTIFICATION_EVENTS.map((e) => e.key);
const VALID_EVENTS = new Set<string>(DEFAULT_EVENTS);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface PrefsView {
  events: string[];
  browser: boolean;
  quietStart: string | null;
  quietEnd: string | null;
  quietTz: string;
  catalog: { key: string; label: string; severity: string }[];
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principals: PrincipalService,
  ) {}

  async list(user: AuthUser, tenantId: string) {
    const p = await this.principals.load(user, tenantId);
    return this.prisma.forTenant(p.tenantId, async (tx) => {
      const [items, unread] = await Promise.all([
        tx.notification.findMany({
          where: { userId: p.userId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        tx.notification.count({ where: { userId: p.userId, readAt: null } }),
      ]);
      return { items, unread };
    });
  }

  async markRead(user: AuthUser, tenantId: string, ids: string[]) {
    const p = await this.principals.load(user, tenantId);
    await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.notification.updateMany({
        where: { userId: p.userId, id: { in: ids }, readAt: null },
        data: { readAt: new Date() },
      }),
    );
    return { ok: true };
  }

  async markAllRead(user: AuthUser, tenantId: string) {
    const p = await this.principals.load(user, tenantId);
    await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.notification.updateMany({
        where: { userId: p.userId, readAt: null },
        data: { readAt: new Date() },
      }),
    );
    return { ok: true };
  }

  async getPrefs(user: AuthUser, tenantId: string): Promise<PrefsView> {
    const p = await this.principals.load(user, tenantId);
    const row = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.notificationPref.findUnique({ where: { tenantId_userId: { tenantId: p.tenantId, userId: p.userId } } }),
    );
    return {
      events: row?.events ?? DEFAULT_EVENTS,
      browser: row?.browser ?? true,
      quietStart: row?.quietStart ?? null,
      quietEnd: row?.quietEnd ?? null,
      quietTz: row?.quietTz ?? 'Europe/Athens',
      catalog: NOTIFICATION_EVENTS.map((e) => ({ ...e })),
    };
  }

  async putPrefs(user: AuthUser, tenantId: string, dto: UpdatePrefsDto): Promise<PrefsView> {
    const p = await this.principals.load(user, tenantId);
    const events = (dto.events ?? DEFAULT_EVENTS).filter((e) => VALID_EVENTS.has(e));
    const quietStart = this.normTime(dto.quietStart);
    const quietEnd = this.normTime(dto.quietEnd);
    if ((quietStart && !quietEnd) || (!quietStart && quietEnd)) {
      throw new BadRequestException('Set both quiet-hours start and end, or neither.');
    }
    await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.notificationPref.upsert({
        where: { tenantId_userId: { tenantId: p.tenantId, userId: p.userId } },
        update: { events, browser: dto.browser ?? true, quietStart, quietEnd, quietTz: dto.quietTz || 'Europe/Athens' },
        create: {
          tenantId: p.tenantId,
          userId: p.userId,
          events,
          browser: dto.browser ?? true,
          quietStart,
          quietEnd,
          quietTz: dto.quietTz || 'Europe/Athens',
        },
      }),
    );
    return this.getPrefs(user, tenantId);
  }

  /** Create a self-addressed test notification (used to verify delivery + browser popups). */
  async createTest(user: AuthUser, tenantId: string) {
    const p = await this.principals.load(user, tenantId);
    const n = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.notification.create({
        data: {
          tenantId: p.tenantId,
          userId: p.userId,
          type: 'test',
          severity: 'INFO',
          title: 'Test notification',
          body: 'If you can see this, live notifications are working.',
        },
      }),
    );
    return n;
  }

  private normTime(v: string | null | undefined): string | null {
    if (v === undefined || v === null || v.trim() === '') return null;
    if (!HHMM.test(v.trim())) throw new BadRequestException('Quiet hours must be HH:MM (24h).');
    return v.trim();
  }

  // ─── Web Push device subscriptions (per user, not tenant-scoped) ───

  /** The VAPID public key the browser needs to create a push subscription. */
  vapidPublicKey(): { publicKey: string | null } {
    return { publicKey: process.env.VAPID_PUBLIC_KEY || null };
  }

  /** Register (or refresh) this browser/device's push subscription for the user. */
  async subscribePush(user: AuthUser, endpoint: string, keys: { p256dh: string; auth: string }, ua?: string) {
    if (!keys?.p256dh || !keys?.auth) throw new BadRequestException('Missing subscription keys');
    // PushSubscription is user-scoped (no RLS); the raw client is correct here.
    await this.prisma.client.pushSubscription.upsert({
      where: { endpoint },
      update: { userId: user.userId, p256dh: keys.p256dh, auth: keys.auth, ua: ua ?? null, lastSeenAt: new Date() },
      create: { userId: user.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, ua: ua ?? null },
    });
    return { ok: true };
  }

  /** Remove a device subscription (only the caller's own). */
  async unsubscribePush(user: AuthUser, endpoint: string) {
    await this.prisma.client.pushSubscription.deleteMany({ where: { endpoint, userId: user.userId } });
    return { ok: true };
  }
}
