import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminReportService {
  constructor(private prisma: PrismaService) {}

  async getStockSummary(tenantId: string) {
    const stocks = await this.prisma.receipt.groupBy({
      by: ['commodityId', 'warehouseId'],
      where: {
        tenantId,
        status: { in: ['ACTIVE', 'HELD_LOAN', 'HELD_TRADE'] },
      },
      _sum: {
        quantity: true,
      },
    });

    // Hydrate with names
    const commodities = await this.prisma.commodity.findMany({
      where: { tenantId },
    });
    const warehouses = await this.prisma.warehouse.findMany({
      where: { tenantId },
    });

    return stocks.map((s) => ({
      commodity: commodities.find((c) => c.id === s.commodityId)?.name,
      warehouse: warehouses.find((w) => w.id === s.warehouseId)?.name,
      totalQuantity: Number(s._sum?.quantity ?? 0),
    }));
  }

  async getAgingAnalysis(tenantId: string) {
    const receipts = await this.prisma.receipt.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
      },
    });

    const now = new Date();
    const categories = {
      '0-30 days': 0,
      '31-60 days': 0,
      '61-90 days': 0,
      '90+ days': 0,
    };

    receipts.forEach((r) => {
      const diffTime = Math.abs(now.getTime() - r.dateOfDeposit.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays <= 30) categories['0-30 days'] += Number(r.quantity);
      else if (diffDays <= 60) categories['31-60 days'] += Number(r.quantity);
      else if (diffDays <= 90) categories['61-90 days'] += Number(r.quantity);
      else categories['90+ days'] += Number(r.quantity);
    });

    return Object.entries(categories).map(([range, quantity]) => ({
      range,
      quantity,
    }));
  }
}
