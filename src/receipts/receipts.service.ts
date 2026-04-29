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
    const page = parseInt(filters.page || '1', 10);
    const limit = parseInt(filters.limit || '10', 10);
    const skip = (page - 1) * limit;

    const where: any = {};

    // 1. Status Filter
    if (filters?.status) {
      where.status = filters.status as ReceiptStatus;
    }

    // 2. Search Filter
    if (filters.search) {
      where.OR = [
        { receiptNumber: { contains: filters.search, mode: 'insensitive' } },
        { commodity: { name: { contains: filters.search, mode: 'insensitive' } } },
      ];
    }

    // 3. Fetch Data & Total Count
    const [receipts, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        include: { commodity: true, warehouse: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.receipt.count({ where }),
    ]);

    const data = receipts.map((r) => ({
      id: r.id,
      receiptNumber: r.receiptNumber,
      commodityName: r.commodity.name,
      warehouseName: r.warehouse.name,
      quantity: r.quantity,
      quantityAvailable: r.quantityAvailable,
      status: r.status,
    }));

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getReceiptStats() {
    const [totalIssued, totalActive, totalPledged, totalWithdrawn] =
      await Promise.all([
        this.prisma.receipt.count(),
        this.prisma.receipt.count({ where: { status: ReceiptStatus.ACTIVE } }),
        this.prisma.receipt.count({ where: { status: ReceiptStatus.PLEDGED } }),
        this.prisma.receipt.count({ where: { status: ReceiptStatus.WITHDRAWN } }),
      ]);

    return {
      totalIssued,
      totalActive,
      totalPledged,
      totalWithdrawn,
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
