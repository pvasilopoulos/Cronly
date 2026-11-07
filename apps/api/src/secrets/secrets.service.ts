import { Injectable } from '@nestjs/common';
import { encryptSecret, secretHint } from '@cronapp/database';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../rbac/principal.service';
import { CreateSecretDto } from './secrets.dto';

// Secret values are encrypted on write and NEVER returned — the API only ever
// exposes the name and a short hint.
const SAFE_SELECT = { id: true, name: true, hint: true, createdAt: true, updatedAt: true } as const;

@Injectable()
export class SecretsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(p: Principal) {
    return this.prisma.forTenant(p.tenantId, (tx) =>
      tx.secret.findMany({ orderBy: { name: 'asc' }, select: SAFE_SELECT }),
    );
  }

  async upsert(p: Principal, dto: CreateSecretDto) {
    const blob = encryptSecret(dto.value);
    const enc = {
      ciphertext: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
      hint: secretHint(dto.value),
    };
    const secret = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.secret.upsert({
        where: { tenantId_name: { tenantId: p.tenantId, name: dto.name } },
        create: { tenantId: p.tenantId, name: dto.name, createdBy: p.userId, ...enc },
        update: enc,
        select: SAFE_SELECT,
      }),
    );
    // Never log the value — only the name of the secret that was set/rotated.
    await this.audit.record_for(p, 'secret.set', secret.id, { name: dto.name });
    return secret;
  }

  async remove(p: Principal, name: string) {
    await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.secret.deleteMany({ where: { tenantId: p.tenantId, name } }),
    );
    await this.audit.record_for(p, 'secret.deleted', null, { name });
    return { ok: true };
  }
}
