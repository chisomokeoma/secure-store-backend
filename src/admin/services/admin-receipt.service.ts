import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ReceiptStatus } from '@prisma/client';

@Injectable()
export class AdminReceiptService {
  constructor(private prisma: PrismaService) {}

  // ─── LIST (full filters per spec §3.4) ────────────────────────────────────

  async getReceipts(
    tenantId: string,
    query: {
      status?: string;
      warehouseId?: string;
      approvalStatus?: string;
      clientId?: string;
      page?: string;
      limit?: string;
    },
  ) {
    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const skip = (page - 1) * limit;

    const where: any = { tenantId };
    if (query.status) where.status = query.status;
    if (query.approvalStatus) where.approvalStatus = query.approvalStatus;
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.clientId) where.clientId = query.clientId;

    const [receipts, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          commodity: { select: { id: true, name: true, unitOfMeasure: true } },
          warehouse: { select: { id: true, name: true, code: true } },
          client: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          approvedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.receipt.count({ where }),
    ]);

    return {
      data: receipts,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── DETAIL ────────────────────────────────────────────────────────────────

  async getReceiptById(tenantId: string, receiptId: string) {
    const receipt = await this.prisma.receipt.findFirst({
      where: { id: receiptId, tenantId },
      include: {
        commodity: true,
        warehouse: true,
        client: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        approvedBy: { select: { id: true, firstName: true, lastName: true } },
        withdrawals: true,
        loans: true,
      },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');
    return receipt;
  }

  // ─── PENDING APPROVALS ─────────────────────────────────────────────────────

  async getPendingApprovals(tenantId: string) {
    return this.prisma.receipt.findMany({
      where: { tenantId, approvalStatus: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        commodity: { select: { id: true, name: true, unitOfMeasure: true } },
        warehouse: { select: { id: true, name: true, code: true } },
        client: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
  }

  // ─── APPROVE ───────────────────────────────────────────────────────────────

  async approveReceipt(
    tenantId: string,
    receiptId: string,
    adminId: string,
    dto: { notes?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.findFirst({
        where: { id: receiptId, tenantId },
      });
      if (!receipt) throw new NotFoundException('Receipt not found');
      if (receipt.approvalStatus !== 'PENDING') {
        throw new BadRequestException(
          `Receipt is already ${receipt.approvalStatus}`,
        );
      }

      return tx.receipt.update({
        where: { id: receiptId },
        data: {
          approvalStatus: 'APPROVED',
          approvedById: adminId,
          approvedAt: new Date(),
          status: ReceiptStatus.ACTIVE,
        },
      });
    });
  }

  // ─── REJECT ────────────────────────────────────────────────────────────────

  async rejectReceipt(
    tenantId: string,
    receiptId: string,
    adminId: string,
    rejectionReason: string,
  ) {
    if (!rejectionReason?.trim()) {
      throw new BadRequestException('rejectionReason is required');
    }

    return this.prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.findFirst({
        where: { id: receiptId, tenantId },
      });
      if (!receipt) throw new NotFoundException('Receipt not found');
      if (receipt.approvalStatus !== 'PENDING') {
        throw new BadRequestException(
          `Receipt is already ${receipt.approvalStatus}`,
        );
      }

      return tx.receipt.update({
        where: { id: receiptId },
        data: {
          approvalStatus: 'REJECTED',
          status: ReceiptStatus.CANCELLED,
          rejectionReason,
          approvedById: adminId,
          approvedAt: new Date(),
        },
      });
    });
  }
}
