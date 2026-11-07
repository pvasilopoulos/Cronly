import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../rbac/principal.service';
import { CreateMaintenanceWindowDto } from './maintenance.dto';

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** All windows for the tenant, soonest-starting first. */
  list(p: Principal) {
    return this.prisma.forTenant(p.tenantId, (tx) =>
      tx.maintenanceWindow.findMany({ orderBy: { startsAt: 'asc' } }),
    );
  }

  async create(p: Principal, dto: CreateMaintenanceWindowDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException('Invalid start or end time.');
    }
    if (endsAt <= startsAt) {
      throw new BadRequestException('The window end must be after its start.');
    }
    const w = await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.maintenanceWindow.create({
        data: {
          tenantId: p.tenantId,
          label: dto.label?.trim() || null,
          startsAt,
          endsAt,
          createdBy: p.userId,
        },
      }),
    );
    await this.audit.record_for(p, 'maintenance.window.created', w.id, {
      label: w.label,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
    });
    return w;
  }

  async remove(p: Principal, id: string) {
    await this.prisma.forTenant(p.tenantId, (tx) =>
      tx.maintenanceWindow.deleteMany({ where: { id } }),
    );
    await this.audit.record_for(p, 'maintenance.window.deleted', id);
    return { ok: true };
  }
}
