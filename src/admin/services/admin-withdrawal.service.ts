import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WithdrawalsService } from '../../withdrawals/withdrawals.service';
import { WithdrawalStatus } from '@prisma/client';

/**
 * Tenant-admin approve/reject of withdrawals. Delegates to the ledger-wired
 * WithdrawalsService so the receipt tree (HELD_WITHDRAWAL → ACTIVE / consumed)
 * AND the InventoryEvent log stay in sync — no more silent drift between
 * withdrawal.status and the tree.
 */
@Injectable()
export class AdminWithdrawalService {
  constructor(
    private prisma: PrismaService,
    private withdrawals: WithdrawalsService,
  ) {}

  approveWithdrawal(tenantId: string, withdrawalId: string, adminId: string) {
    return this.withdrawals.approveWithdrawal(tenantId, withdrawalId, adminId);
  }

  rejectWithdrawal(
    tenantId: string,
    withdrawalId: string,
    adminId: string,
    reason: string,
  ) {
    return this.withdrawals.rejectWithdrawal(
      tenantId,
      withdrawalId,
      adminId,
      reason,
    );
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
