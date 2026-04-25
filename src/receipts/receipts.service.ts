import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptStatus, WithdrawalStatus } from '@prisma/client';

@Injectable()
export class ReceiptsService {
  constructor(private prisma: PrismaService) {}

  async getReceipts(filters: {
    status?: string;
    page?: string;
    limit?: string;
    search?: string;
  }) {
    const where: any = {};
    if (filters?.status) {
      where.status = filters.status as ReceiptStatus;
    }

    const receipts = await this.prisma.receipt.findMany({
      where,
      include: { commodity: true, warehouse: true },
      orderBy: { createdAt: 'desc' },
    });

    return receipts.map((r) => ({
      id: r.id,
      receiptNumber: r.receiptNumber,
      commodityName: r.commodity.name,
      warehouseName: r.warehouse.name,
      quantity: r.quantity,
      quantityAvailable: r.quantityAvailable,
      status: r.status,
    }));
  }

  async getReceiptStats() {
    const [totalIssued, totalActive, totalPledged, totalCompleted] =
      await Promise.all([
        this.prisma.receipt.count(),
        this.prisma.receipt.count({ where: { status: ReceiptStatus.ACTIVE } }),
        this.prisma.receipt.count({ where: { status: ReceiptStatus.PLEDGED } }),
        this.prisma.withdrawal.count({
          where: { status: WithdrawalStatus.COMPLETED },
        }),
      ]);

    return {
      totalIssued,
      totalActive,
      totalPledged,
      totalWithdrawn: totalCompleted,
    };
  }

  async getReceiptDetail(id: string) {
    const r = await this.prisma.receipt.findUnique({
      where: { id },
      include: {
        commodity: true,
        warehouse: true,
        client: true,
        parentReceipt: { select: { id: true, receiptNumber: true } },
        childReceipts: { select: { id: true, receiptNumber: true } },
      },
    });
    if (!r) throw new NotFoundException('Receipt not found');

    return {
      id: r.id,
      receiptNumber: r.receiptNumber,
      commodityName: r.commodity.name,
      warehouseName: r.warehouse.name,
      quantity: r.quantity,
      quantityAvailable: r.quantityAvailable,
      status: r.status,
      dateOfDeposit: r.dateOfDeposit,
      expiryDate: r.expiryDate,
      parentReceipt: r.parentReceipt,
      childReceipts: r.childReceipts,
    };
  }
}
