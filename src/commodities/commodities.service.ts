import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CommoditiesService {
  constructor(private prisma: PrismaService) {}

  async getMyCommodities(tenantId: string, clientId: string) {
    const receipts = await this.prisma.receipt.findMany({
      where: { tenantId, clientId },
      include: { commodity: true },
    });

    const map = new Map<string, any>();
    for (const r of receipts) {
      if (!map.has(r.commodityId)) {
        map.set(r.commodityId, {
          id: r.commodityId,
          name: r.commodity.name,
          totalQuantity: 0,
          availableQuantity: 0,
        });
      }
      const data = map.get(r.commodityId);
      data.totalQuantity += r.quantity;
      data.availableQuantity += r.quantityAvailable || 0;
    }
    return Array.from(map.values());
  }

  async getCommodityOverview(tenantId: string, id: string, clientId: string) {
    const receipts = await this.prisma.receipt.findMany({
      where: { tenantId, commodityId: id, clientId },
    });
    const commodity = await this.prisma.commodity.findFirst({
      where: { id, tenantId },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');

    const totalQuantity = receipts.reduce((sum, r) => sum + r.quantity, 0);
    const availableQuantity = receipts.reduce(
      (sum, r) => sum + (r.quantityAvailable || 0),
      0,
    );

    return { id, name: commodity.name, totalQuantity, availableQuantity };
  }

  async getCommodityReceipts(tenantId: string, id: string) {
    return this.prisma.receipt
      .findMany({
        where: { tenantId, commodityId: id },
        include: { warehouse: true },
      })
      .then((res) =>
        res.map((r) => ({
          id: r.id,
          receiptNumber: r.receiptNumber,
          quantity: r.quantityAvailable,
          status: r.status,
          warehouse: r.warehouse.name,
        })),
      );
  }
}