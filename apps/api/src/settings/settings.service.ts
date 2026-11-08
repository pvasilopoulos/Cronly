import { Injectable } from '@nestjs/common';
import { Prisma } from '@cronapp/database';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../rbac/principal.service';
import { UpdateDigestDto } from './settings.dto';

export interface DigestConfig {
  enabled: boolean;
  hour: number;
}

const DIGEST_DEFAULT: DigestConfig = { enabled: false, hour: 8 };

/** Read a tenant's digest config out of its free-form settings JSON. */
export function readDigest(settings: unknown): DigestConfig {
  const s = (settings ?? {}) as Record<string, any>;
  const d = (s.digest ?? {}) as Record<string, any>;
  const hour = Number.isInteger(d.hour) && d.hour >= 0 && d.hour <= 23 ? d.hour : DIGEST_DEFAULT.hour;
  return { enabled: d.enabled === true, hour };
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getDigest(p: Principal): Promise<DigestConfig> {
    const tenant = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: p.tenantId }, select: { settings: true } }),
    );
    return readDigest(tenant?.settings);
  }

  async updateDigest(p: Principal, dto: UpdateDigestDto): Promise<DigestConfig> {
    const next = await this.prisma.forTenant(p.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: p.tenantId }, select: { settings: true } });
      const settings = (tenant?.settings ?? {}) as Record<string, any>;
      const current = readDigest(settings);
      const merged: DigestConfig = {
        enabled: dto.enabled ?? current.enabled,
        hour: dto.hour ?? current.hour,
      };
      await tx.tenant.update({
        where: { id: p.tenantId },
        // Preserve any other settings keys (retention, concurrency, …).
        data: { settings: { ...settings, digest: { ...merged } } as Prisma.InputJsonObject },
      });
      return merged;
    });
    await this.audit.record_for(p, 'settings.digest.updated', p.tenantId, { ...next });
    return next;
  }
}
