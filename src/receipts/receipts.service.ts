// import { Injectable, NotFoundException } from '@nestjs/common';
// import { PrismaService } from '../prisma/prisma.service';

// @Injectable()
// export class ReceiptsService {
//   constructor(private prisma: PrismaService) {}

//   async getReceipts(filters: any) {
//     return this.prisma.receipt.findMany({
//       where: filters?.status ? { status: filters.status } : {},
//       include: { commodity: true, warehouse: true }
//     }).then(res => res.map(r => ({
//       id: r.id,
//       receiptNumber: r.receiptNumber,
//       commodityName: r.commodity.name,
//       quantity: r.quantityAvailable,
//       status: r.status
//     })));
//   }

//   async getReceiptStats() {
//     const receipts = await this.prisma.receipt.findMany();
//     return {
//       totalIssued: receipts.length,
//       totalPledged: receipts.filter(r => r.status === 'PLEDGED').length,
//       totalWithdrawn: receipts.filter(r => r.status === 'CANCELLED').length,
//     };
//   }

//   async getReceiptDetail(id: string) {
//     const r = await this.prisma.receipt.findUnique({
//       where: { id },
//       include: { commodity: true, warehouse: true, client: true }
//     });
//     if (!r) throw new NotFoundException('Receipt not found');
//     return {
//       id: r.id,
//       receiptNumber: r.receiptNumber,
//       commodityName: r.commodity.name,
//       warehouseName: r.warehouse.name,
//       quantity: r.quantityAvailable,
//       status: r.status,
//       dateOfDeposit: r.dateOfDeposit,
//       expiryDate: r.expiryDate
//     };
//   }
// }


import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReceiptsService {
  constructor(private prisma: PrismaService) { }

  async getReceipts(filters: any) {
    return this.prisma.receipt.findMany({
      where: filters?.status ? { status: filters.status } : {},
      include: { commodity: true, warehouse: true }
    }).then(res => res.map(r => ({
      id: r.id,
      receiptNumber: r.receiptNumber,
      commodityName: r.commodity.name,
      quantity: r.quantity, // 👈 fixed
      status: r.status
    })));
  }

  async getReceiptStats() {
    const receipts = await this.prisma.receipt.findMany();
    return {
      totalIssued: receipts.length,
      totalPledged: receipts.filter(r => r.status === 'PLEDGED').length,
      totalWithdrawn: receipts.filter(r => r.status === 'CANCELLED').length,
    };
  }

  async getReceiptDetail(id: string) {
    const r = await this.prisma.receipt.findUnique({
      where: { id },
      include: { commodity: true, warehouse: true, client: true }
    });
    if (!r) throw new NotFoundException('Receipt not found');
    return {
      id: r.id,
      receiptNumber: r.receiptNumber,
      commodityName: r.commodity.name,
      warehouseName: r.warehouse.name,
      quantity: r.quantity, // 👈 fixed
      status: r.status,
      dateOfDeposit: r.dateOfDeposit,
      expiryDate: r.expiryDate
    };
  }
}