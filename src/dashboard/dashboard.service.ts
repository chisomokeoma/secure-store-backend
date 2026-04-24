import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) { }

  async getSummary(clientId?: string) {
    const where = clientId ? { clientId } : {};
    const receipts = await this.prisma.receipt.findMany({ where });
    const activeReceipts = receipts.filter(r => r.status === 'ACTIVE').length;
    const totalVolume = receipts.reduce((sum, r) => sum + (r.quantity || 0), 0);
    return { totalVolume, activeReceipts, totalValue: totalVolume * 1500 };
  }

  async getCommodityBreakdown(clientId?: string) {
    const where = clientId ? { clientId } : {};
    const receipts = await this.prisma.receipt.findMany({ where, include: { commodity: true } });
    const map = new Map<string, number>();
    let total = 0;
    for (const r of receipts) {
      const val = map.get(r.commodity.name) || 0;
      map.set(r.commodity.name, val + (r.quantity || 0));
      total += (r.quantity || 0);
    }
    return Array.from(map.entries()).map(([name, qty]) => ({
      commodityName: name,
      percentage: total > 0 ? Math.round((qty / total) * 100) : 0
    }));
  }

  async getActivityTrend() {
    return [{ date: new Date().toISOString().split('T')[0], activityCount: 12 }];
  }

  async getSystemStatus() {
    return { isOperational: true, lastChecked: new Date() };
  }
}
