// import { Injectable, NotFoundException } from '@nestjs/common';
// import { PrismaService } from '../prisma/prisma.service';

// @Injectable()
// export class TradesService {
//   constructor(private prisma: PrismaService) {}

//   async getTradeListings() {
//     const receipts = await this.prisma.receipt.findMany({
//       where: { status: 'ACTIVE', quantityAvailable: { gt: 0 } },
//       include: { commodity: true }
//     });

//     return receipts.slice(0, 3).map(r => ({
//       id: 'T-' + r.id.substring(0, 8),
//       commodityName: r.commodity.name,
//       quantity: Math.min(100, r.quantityAvailable || 100),
//       price: Math.floor(Math.random() * 500) + 100,
//     }));
//   }

//   async createTrade(dto: any) {
//     return { id: 'T-REQ-' + Math.floor(Math.random()*10000), status: 'LISTED' };
//   }
// }


import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptStatus } from '../../prisma/generated/prisma/client';

@Injectable()
export class TradesService {
  constructor(private prisma: PrismaService) { }

  async getTradeListings() {
    const receipts = await this.prisma.receipt.findMany({
      where: { status: ReceiptStatus.ACTIVE }, // 👈 removed quantityAvailable
      include: { commodity: true } // 👈 include to access commodity relation
    });

    return receipts.slice(0, 3).map(r => ({
      id: 'T-' + r.id.substring(0, 8),
      commodityName: r.commodity.name,
      quantity: Math.min(100, r.quantity || 100), // 👈 changed from quantityAvailable to quantity
      price: Math.floor(Math.random() * 500) + 100,
    }));
  }

  async createTrade(dto: any) {
    return { id: 'T-REQ-' + Math.floor(Math.random() * 10000), status: 'LISTED' };
  }
}
