import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { RbacModule } from './rbac/rbac.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './rbac/permissions.guard';
import { MeModule } from './me/me.module';
import { JobsModule } from './jobs/jobs.module';
import { RunsModule } from './runs/runs.module';
import { RolesModule } from './roles/roles.module';
import { MembersModule } from './members/members.module';
import { HealthModule } from './health/health.module';
import { SecretsModule } from './secrets/secrets.module';
import { AlertsModule } from './alerts/alerts.module';
import { ApiKeysModule } from './apikeys/apikeys.module';
import { AuditModule } from './audit/audit.module';
import { HeartbeatModule } from './heartbeat/heartbeat.module';
import { QuotaModule } from './quota/quota.module';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { ObservabilityModule } from './observability/observability.module';
import { AppConfigModule } from './appconfig/appconfig.module';
import { AdminModule } from './admin/admin.module';
import { BillingModule } from './billing/billing.module';
import { SmtpModule } from './smtp/smtp.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TemplatesModule } from './templates/templates.module';
import { RateLimitGuard } from './common/rate-limit.guard';

@Module({
  imports: [
    PrismaModule,
    RbacModule,
    QueueModule,
    AuthModule,
    MeModule,
    JobsModule,
    RunsModule,
    RolesModule,
    MembersModule,
    HealthModule,
    SecretsModule,
    AlertsModule,
    ApiKeysModule,
    AuditModule,
    HeartbeatModule,
    QuotaModule,
    EntitlementsModule,
    ObservabilityModule,
    AppConfigModule,
    AdminModule,
    BillingModule,
    SmtpModule,
    NotificationsModule,
    TemplatesModule,
  ],
  providers: [
    // Order matters: rate-limit first, then authenticate, then resolve
    // tenant + permissions.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
