import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TradesService {
  constructor(private prisma: PrismaService) {}

  async getTradeListings() {
    const receipts = await this.prisma.receipt.findMany({
      where: { status: 'ACTIVE', quantityAvailable: { gt: 0 } },
      include: { commodity: true }
    });
    
    return receipts.slice(0, 3).map(r => ({
      id: 'T-' + r.id.substring(0, 8),
      commodityName: r.commodity.name,
      quantity: Math.min(100, r.quantityAvailable || 100),
      price: Math.floor(Math.random() * 500) + 100,
    }));
  }

  async createTrade(dto: any) {
    return { id: 'T-REQ-' + Math.floor(Math.random()*10000), status: 'LISTED' };
  }
}
