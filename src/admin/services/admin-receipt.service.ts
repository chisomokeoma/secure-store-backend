import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ReceiptStatus } from '@prisma/client';

@Injectable()
export class AdminReceiptService {
  constructor(private prisma: PrismaService) {}

  async approveReceipt(
    tenantId: string,
    receiptId: string,
    adminId: string,
    dto: { gradingScores?: any; finalGrade?: string },
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

      const updated = await tx.receipt.update({
        where: { id: receiptId },
        data: {
          approvalStatus: 'APPROVED',
          approvedById: adminId,
          approvedAt: new Date(),
          status: ReceiptStatus.ACTIVE,
          gradingScores: dto.gradingScores || receipt.gradingScores,
          grade: dto.finalGrade || receipt.grade,
        },
      });

      return updated;
    });
  }

  async rejectReceipt(
    tenantId: string,
    receiptId: string,
    adminId: string,
    reason: string,
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

      const updated = await tx.receipt.update({
        where: { id: receiptId },
        data: {
          approvalStatus: 'REJECTED',
          status: ReceiptStatus.CANCELLED,
          rejectionReason: reason,
          approvedById: adminId,
          approvedAt: new Date(),
        },
      });

      return updated;
    });
  }

  async getPendingApprovals(tenantId: string) {
    return this.prisma.receipt.findMany({
      where: {
        tenantId,
        approvalStatus: 'PENDING',
      },
      include: {
        commodity: true,
        warehouse: true,
        client: true,
      },
    });
  }
}
