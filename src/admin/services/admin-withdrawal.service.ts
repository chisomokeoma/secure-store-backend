import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WithdrawalStatus } from '@prisma/client';

@Injectable()
export class AdminWithdrawalService {
  constructor(private prisma: PrismaService) {}

  async approveWithdrawal(
    tenantId: string,
    withdrawalId: string,
    adminId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findFirst({
        where: { id: withdrawalId, tenantId },
      });
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');
      if (withdrawal.status !== WithdrawalStatus.PAID_PENDING_APPROVAL) {
        throw new BadRequestException(
          `Withdrawal is not awaiting approval (status: ${withdrawal.status})`,
        );
      }

      return tx.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: WithdrawalStatus.APPROVED,
          approvedById: adminId,
          approvedAt: new Date(),
        },
      });
    });
  }

  async rejectWithdrawal(
    tenantId: string,
    withdrawalId: string,
    adminId: string,
    reason: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findFirst({
        where: { id: withdrawalId, tenantId },
      });
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');

      return tx.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: WithdrawalStatus.REJECTED,
          rejectionReason: reason,
          approvedById: adminId,
          approvedAt: new Date(),
        },
      });
    });
  }

  async getPendingWithdrawals(tenantId: string) {
    return this.prisma.withdrawal.findMany({
      where: {
        tenantId,
        status: WithdrawalStatus.PAID_PENDING_APPROVAL,
      },
      include: {
        receipt: { include: { commodity: true } },
        client: true,
      },
    });
  }
}
