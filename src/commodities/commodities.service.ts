import { Injectable, NotFoundException } from '@nestjs/common';
import { ReceiptStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { deriveGroup, HELD_STATUSES } from '../inventory/inventory.types';

// "In-system" = the client still owns it AND it's a real leaf, not a
// superseded SPLIT parent or a closed terminal node. Includes the
// PENDING_APPROVAL leaves so a fresh deposit shows up in totals.
const IN_SYSTEM_STATUSES: ReceiptStatus[] = [
  ReceiptStatus.ACTIVE,
  ReceiptStatus.PENDING_APPROVAL,
  ...HELD_STATUSES,
];

@Injectable()
export class CommoditiesService {
  constructor(private prisma: PrismaService) {}

  async getMyCommodities(tenantId: string, clientId: string) {
    // Only count receipts the client still owns AND are real leaves. The
    // SPLIT parents would double-count with their children; terminal nodes
    // (WITHDRAWN/TRADED_OUT/SEIZED/EXPIRED/CANCELLED) have left the client's
    // inventory and must not contribute.
    const receipts = await this.prisma.receipt.findMany({
      where: { tenantId, clientId, status: { in: IN_SYSTEM_STATUSES } },
      include: { commodity: true },
    });

    const map = new Map<string, any>();
    for (const r of receipts) {
      if (!map.has(r.commodityId)) {
        map.set(r.commodityId, {
          id: r.commodityId,
          name: r.commodity.name,
          code: r.commodity.code,
          unit: r.commodity.unitOfMeasure,
          totalQuantity: 0,
          availableQuantity: 0,
          lockedQuantity: 0,
          pendingQuantity: 0,
        });
      }
      const data = map.get(r.commodityId);
      const qty = Number(r.quantity);
      data.totalQuantity += qty;
      if (r.status === ReceiptStatus.ACTIVE) data.availableQuantity += qty;
      else if (r.status === ReceiptStatus.PENDING_APPROVAL)
        data.pendingQuantity += qty;
      else data.lockedQuantity += qty; // HELD_* (the only remaining branch)
    }
    return Array.from(map.values());
  }

  async getCommodityOverview(tenantId: string, id: string, clientId: string) {
    // Same in-system rule as getMyCommodities so the cards on the
    // commodity-detail page line up exactly with the row totals on the list.
    const receipts = await this.prisma.receipt.findMany({
      where: {
        tenantId,
        commodityId: id,
        clientId,
        status: { in: IN_SYSTEM_STATUSES },
      },
      select: { status: true, quantity: true },
    });
    const commodity = await this.prisma.commodity.findFirst({
      where: { id, tenantId },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');

    let totalQuantity = 0;
    let availableQuantity = 0;
    let lockedQuantity = 0;
    let pendingQuantity = 0;
    let activeReceiptCount = 0;
    for (const r of receipts) {
      const qty = Number(r.quantity);
      totalQuantity += qty;
      if (r.status === ReceiptStatus.ACTIVE) {
        availableQuantity += qty;
        activeReceiptCount += 1;
      } else if (r.status === ReceiptStatus.PENDING_APPROVAL) {
        pendingQuantity += qty;
      } else {
        // HELD_* — only remaining branch under the IN_SYSTEM_STATUSES filter.
        lockedQuantity += qty;
      }
    }

    return {
      id,
      name: commodity.name,
      code: commodity.code,
      unit: commodity.unitOfMeasure,
      totalQuantity,
      availableQuantity,
      lockedQuantity,
      pendingQuantity,
      activeReceiptCount,
    };
  }

  /**
   * Receipts for a commodity, scoped to the caller. Lives on the client-facing
   * "My commodities → details" page, so we ALWAYS filter by clientId — every
   * sibling endpoint on this controller (`getMyCommodities`, `getCommodityOverview`)
   * already does. Without the filter a client sees every other client's
   * receipts for the same commodity. SPLIT internal nodes are excluded so
   * superseded parents don't leak into the list.
   */
  async getCommodityReceipts(
    tenantId: string,
    commodityId: string,
    clientId: string,
    opts: { page?: string; limit?: string; search?: string } = {},
  ) {
    const page = Math.max(1, parseInt(opts.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(opts.limit ?? '20', 10)));

    const where: Prisma.ReceiptWhereInput = {
      tenantId,
      commodityId,
      clientId,
      status: { notIn: [ReceiptStatus.SPLIT] },
    };
    if (opts.search) {
      where.receiptNumber = {
        contains: opts.search,
        mode: 'insensitive',
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        include: { warehouse: { select: { id: true, name: true, code: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.receipt.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        receiptNumber: r.receiptNumber,
        quantity: Number(r.quantity),
        status: r.status,
        approvalStatus: r.approvalStatus,
        group: deriveGroup(r),
        warehouse: r.warehouse.name,
        warehouseId: r.warehouseId,
        depositDate: r.dateOfDeposit,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }
}
