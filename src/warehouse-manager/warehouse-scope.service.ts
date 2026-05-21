import { Injectable, Scope, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveRoles } from '../common/scope.util';

const ADMIN_ROLES = ['TENANT_ADMIN', 'GLOBAL_ADMIN'];

/**
 * Resolves, per request, which warehouses the caller may see:
 *   - null  → unrestricted (TENANT_ADMIN / GLOBAL_ADMIN — full tenant view)
 *   - string[] → restrict to these warehouse ids (a WAREHOUSE_MANAGER's
 *     active WarehouseManagerAssignment set; may be empty → sees nothing)
 *
 * Request-scoped + memoized so the assignment lookup runs once per request and
 * no controller/handler signatures need to change.
 */
@Injectable({ scope: Scope.REQUEST })
export class WarehouseScopeService {
  private cached?: string[] | null;

  constructor(
    @Inject(REQUEST) private readonly req: any,
    private readonly prisma: PrismaService,
  ) {}

  async warehouseIds(tenantId: string): Promise<string[] | null> {
    if (this.cached !== undefined) return this.cached;
    const user = this.req?.user ?? {};
    const activeRole = this.req?.headers?.['x-active-role'];
    const roles = effectiveRoles(user.roles, activeRole);
    if (roles.some((r) => ADMIN_ROLES.includes(r))) {
      this.cached = null;
      return null;
    }
    const rows = await this.prisma.warehouseManagerAssignment.findMany({
      where: { tenantId, managerId: user.id, unassignedAt: null },
      select: { warehouseId: true },
    });
    this.cached = rows.map((r) => r.warehouseId);
    return this.cached;
  }
}
