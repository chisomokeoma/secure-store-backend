import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LoanStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SecurityService } from '../security/security.service';
import { CalculateLoanDto, CreateLoanDto, EditLoanDto } from './dto/loans.dto';

@Injectable()
export class LoansService {
  constructor(
    private prisma: PrismaService,
    private ledger: InventoryLedgerService,
    private notifications: NotificationsService,
    private security: SecurityService,
  ) {}

  async getFinanciers(tenantId: string) {
    return this.prisma.financier.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        interestRate: true,
        minTenure: true,
        maxTenure: true,
        approvalTime: true,
      },
    });
  }

  /** Only APPROVED, ACTIVE leaves can be pledged. */
  async getPledgeableReceipts(
    tenantId: string,
    clientId: string,
    commodity?: string,
    warehouseIds?: string[],
  ) {
    const receipts = await this.prisma.receipt.findMany({
      where: {
        tenantId,
        clientId,
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        isParent: false,
        ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}),
      },
      include: { commodity: true },
    });

    return receipts
      .filter(
        (r) =>
          !commodity ||
          r.commodity.name.toLowerCase() === commodity.toLowerCase(),
      )
      .map((r) => ({
        id: r.id,
        receiptNumber: r.receiptNumber,
        availableQuantity: Number(r.quantity),
        commodity: r.commodity.name,
      }));
  }

  async calculateLoan(tenantId: string, dto: CalculateLoanDto) {
    const financier = await this.prisma.financier.findFirst({
      where: { id: dto.financierId, tenantId },
    });
    if (!financier) throw new NotFoundException('Financier not found');
    if (dto.amount <= 0) {
      throw new BadRequestException('Loan amount must be greater than zero');
    }
    const tenureMonths = financier.maxTenure;
    const totalInterest = (dto.amount * financier.interestRate) / 100;
    const monthlyPayment = (dto.amount + totalInterest) / tenureMonths;
    return {
      totalInterest,
      monthlyPayment,
      tenureMonths,
      interestRate: financier.interestRate,
    };
  }

  /** Create = pledge the whole selected receipt as collateral (HOLD_LOAN). */
  async createLoan(
    tenantId: string,
    dto: CreateLoanDto,
    clientId: string,
    actorUserId?: string,
    opts: { isOnBehalf?: boolean } = {},
  ) {
    // 2FA gate — see WithdrawalsService.createWithdrawalRequest for semantics.
    await this.security.assertTransactionAuth({
      userId: clientId,
      purpose: 'LOAN',
      pin: dto.pin,
      otp: dto.otp,
      isOnBehalf: opts.isOnBehalf,
    });

    const receipt = await this.prisma.receipt.findFirst({
      where: { id: dto.receiptId, tenantId },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');

    const financier = await this.prisma.financier.findFirst({
      where: { id: dto.financierId, tenantId },
    });
    if (!financier) throw new NotFoundException('Financier not found');
    if (dto.amount <= 0) {
      throw new BadRequestException('Loan amount must be greater than zero');
    }

    const tenureMonths = financier.maxTenure;
    const totalInterest = (dto.amount * financier.interestRate) / 100;
    const monthlyPayment = (dto.amount + totalInterest) / tenureMonths;

    const loanId = randomUUID();
    const { held } = await this.ledger.hold({
      tenantId,
      sourceReceiptId: receipt.id,
      quantity: receipt.quantity,
      heldStatus: 'HELD_LOAN',
      txnType: 'LOAN',
      txnId: loanId,
      actorUserId: actorUserId ?? clientId,
      idempotencyKey: `LOAN:${loanId}:hold`,
    });

    const loan = await this.prisma.loan.upsert({
      where: { id: loanId },
      update: {},
      create: {
        id: loanId,
        reference: `L-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        receiptId: held.id,
        clientId,
        tenantId,
        financierId: financier.id,
        amount: dto.amount,
        interestRate: financier.interestRate,
        tenureMonths,
        totalInterest,
        monthlyPayment,
        status: LoanStatus.PENDING,
        notes: dto.notes,
      },
    });

    void this.notifications.notifyTenantAdmins(tenantId, {
      type: 'LOAN_REQUESTED',
      title: 'New loan request',
      body: `${loan.reference}: ₦${dto.amount.toLocaleString()} via ${financier.name}.`,
      relatedEntityType: 'loan',
      relatedEntityId: loan.id,
      data: {
        amount: dto.amount,
        financierId: financier.id,
        financierName: financier.name,
      },
    });
    void this.notifications.notifyUser(clientId, {
      tenantId,
      type: 'LOAN_REQUESTED',
      title: 'Loan request submitted',
      body: `${loan.reference}: ₦${dto.amount.toLocaleString()} via ${financier.name}. Awaiting approval.`,
      relatedEntityType: 'loan',
      relatedEntityId: loan.id,
    });

    return {
      id: loan.id,
      reference: loan.reference,
      status: loan.status,
      amount: loan.amount,
      totalInterest: loan.totalInterest,
      monthlyPayment: loan.monthlyPayment,
      tenureMonths: loan.tenureMonths,
      pledgedReceiptId: held.id,
    };
  }

  private async loadLoan(tenantId: string, id: string) {
    const loan = await this.prisma.loan.findFirst({ where: { id, tenantId } });
    if (!loan) throw new NotFoundException('Loan not found');
    return loan;
  }

  async approveLoan(tenantId: string, loanId: string, actorUserId?: string) {
    const loan = await this.loadLoan(tenantId, loanId);
    if (loan.status !== LoanStatus.PENDING) {
      throw new BadRequestException(`Loan is not pending (status: ${loan.status})`);
    }
    await this.ledger.approveHold({
      tenantId,
      heldReceiptId: loan.receiptId,
      actorUserId,
      idempotencyKey: `LOAN:${loan.id}:approveHold`,
    });
    const updated = await this.prisma.loan.update({
      where: { id: loanId },
      data: { status: LoanStatus.ACTIVE, approvedAt: new Date() },
    });
    void this.notifications.notifyUser(loan.clientId, {
      tenantId,
      type: 'LOAN_APPROVED',
      title: 'Loan approved',
      body: `${updated.reference}: ₦${loan.amount.toLocaleString()} is now active.`,
      relatedEntityType: 'loan',
      relatedEntityId: updated.id,
    });
    return { id: updated.id, status: updated.status };
  }

  async rejectLoan(tenantId: string, loanId: string, actorUserId?: string) {
    const loan = await this.loadLoan(tenantId, loanId);
    if (loan.status !== LoanStatus.PENDING) {
      throw new BadRequestException(`Loan is not pending (status: ${loan.status})`);
    }
    await this.ledger.release({
      tenantId,
      heldReceiptId: loan.receiptId,
      actorUserId,
      idempotencyKey: `LOAN:${loan.id}:release`,
    });
    const updated = await this.prisma.loan.update({
      where: { id: loanId },
      data: { status: LoanStatus.REJECTED },
    });
    void this.notifications.notifyUser(loan.clientId, {
      tenantId,
      type: 'LOAN_REJECTED',
      title: 'Loan rejected',
      body: `${updated.reference} was rejected.`,
      relatedEntityType: 'loan',
      relatedEntityId: updated.id,
    });
    return { id: updated.id, status: updated.status };
  }

  async repayLoan(tenantId: string, loanId: string, actorUserId?: string) {
    const loan = await this.loadLoan(tenantId, loanId);
    if (loan.status !== LoanStatus.ACTIVE) {
      throw new BadRequestException(`Loan is not active (status: ${loan.status})`);
    }
    const released = await this.ledger.release({
      tenantId,
      heldReceiptId: loan.receiptId,
      actorUserId,
      idempotencyKey: `LOAN:${loan.id}:repay-release`,
    });
    const updated = await this.prisma.loan.update({
      where: { id: loanId },
      data: { status: LoanStatus.REPAID, repaidAt: new Date() },
    });
    void this.notifications.notifyUser(loan.clientId, {
      tenantId,
      type: 'LOAN_REPAID',
      title: 'Loan repaid',
      body: `${updated.reference} is repaid. Collateral released.`,
      relatedEntityType: 'loan',
      relatedEntityId: updated.id,
    });
    void this.notifications.notifyTenantAdmins(tenantId, {
      type: 'LOAN_REPAID',
      title: 'Loan repaid',
      body: `${updated.reference}: repaid; collateral released.`,
      relatedEntityType: 'loan',
      relatedEntityId: updated.id,
    });
    return {
      id: updated.id,
      status: updated.status,
      releasedReceipt: released.receiptNumber,
    };
  }

  /**
   * Edit a previously-filed loan. Permission + state model:
   *
   *   Caller is the OWNING client OR a TENANT_ADMIN/GLOBAL_ADMIN OR a WM
   *   assigned to the pledged receipt's warehouse → permission OK.
   *
   *   PENDING       → anyone above can edit (amount, financierId, notes).
   *                   When amount or financierId change we recompute
   *                   tenureMonths / totalInterest / monthlyPayment via
   *                   the same formula createLoan uses.
   *   APPROVED      → admin only, notes only.
   *   ACTIVE        → admin only, notes only.
   *   REPAID /
   *   DEFAULTED /
   *   REJECTED /
   *   CANCELLED     → 409. Terminal, no edits.
   */
  async editLoan(args: {
    tenantId: string;
    loanId: string;
    actorUserId: string;
    actorRoles: string[];
    dto: EditLoanDto;
  }) {
    const loan = await this.prisma.loan.findFirst({
      where: { id: args.loanId, tenantId: args.tenantId },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    const terminal: LoanStatus[] = [
      LoanStatus.REPAID,
      LoanStatus.DEFAULTED,
      LoanStatus.REJECTED,
      LoanStatus.CANCELLED,
    ];
    if (terminal.includes(loan.status)) {
      throw new ConflictException(
        `This loan is ${loan.status.toLowerCase()} and cannot be edited.`,
      );
    }

    const isAdmin = args.actorRoles.some(
      (r) => r === 'TENANT_ADMIN' || r === 'GLOBAL_ADMIN',
    );
    const isOwner = loan.clientId === args.actorUserId;
    let isAuthorizedWm = false;
    if (
      !isAdmin &&
      !isOwner &&
      args.actorRoles.includes('WAREHOUSE_MANAGER')
    ) {
      const pledged = await this.prisma.receipt.findUnique({
        where: { id: loan.receiptId },
        select: { warehouseId: true },
      });
      if (pledged) {
        const assignment =
          await this.prisma.warehouseManagerAssignment.findFirst({
            where: {
              tenantId: args.tenantId,
              warehouseId: pledged.warehouseId,
              managerId: args.actorUserId,
              unassignedAt: null,
            },
          });
        isAuthorizedWm = !!assignment;
      }
    }
    if (!isAdmin && !isOwner && !isAuthorizedWm) {
      throw new ForbiddenException(
        'Only the loan owner, an admin, or an assigned WM can edit this loan.',
      );
    }

    // State gate for non-admins: PENDING only (per spec — once admin has
    // approved, only the admin should be touching it).
    if (!isAdmin && loan.status !== LoanStatus.PENDING) {
      throw new ConflictException(
        `This loan is already ${loan.status} — only a tenant admin can edit it now.`,
      );
    }

    // Field gate: amount + financierId are only editable in PENDING (even
    // for admins). Past PENDING those values feed already-disclosed
    // payment schedules; if they need to change, recreate the loan.
    if (loan.status !== LoanStatus.PENDING) {
      const disallowed: string[] = [];
      if (args.dto.amount !== undefined) disallowed.push('amount');
      if (args.dto.financierId !== undefined) disallowed.push('financierId');
      if (disallowed.length) {
        throw new BadRequestException(
          `Cannot edit ${disallowed.join(', ')} on a ${loan.status} loan. Notes can still be updated; for material changes, cancel and refile.`,
        );
      }
    }

    const beforeAfter: Record<string, { from: unknown; to: unknown }> = {};
    const updateData: any = {};

    let nextFinancier:
      | { id: string; interestRate: number; maxTenure: number }
      | null = null;
    if (
      args.dto.financierId !== undefined &&
      args.dto.financierId !== loan.financierId
    ) {
      const f = await this.prisma.financier.findFirst({
        where: { id: args.dto.financierId, tenantId: args.tenantId },
        select: { id: true, interestRate: true, maxTenure: true },
      });
      if (!f) throw new BadRequestException('financierId is invalid for this tenant.');
      nextFinancier = f;
      beforeAfter['financierId'] = {
        from: loan.financierId,
        to: args.dto.financierId,
      };
      updateData.financierId = args.dto.financierId;
    }
    if (args.dto.amount !== undefined && args.dto.amount !== loan.amount) {
      beforeAfter['amount'] = { from: loan.amount, to: args.dto.amount };
      updateData.amount = args.dto.amount;
    }
    if (
      args.dto.notes !== undefined &&
      args.dto.notes !== (loan.notes ?? null)
    ) {
      beforeAfter['notes'] = { from: loan.notes, to: args.dto.notes };
      updateData.notes = args.dto.notes;
    }

    // Recompute interest / monthlyPayment / tenureMonths when either
    // amount or financier changed.
    const amountChanged = updateData.amount !== undefined;
    const financierChanged = updateData.financierId !== undefined;
    if (amountChanged || financierChanged) {
      const interestRate =
        nextFinancier?.interestRate ?? loan.interestRate;
      const tenureMonths =
        nextFinancier?.maxTenure ?? loan.tenureMonths;
      const principal = updateData.amount ?? loan.amount;
      const totalInterest = (principal * interestRate) / 100;
      const monthlyPayment = (principal + totalInterest) / tenureMonths;
      if (interestRate !== loan.interestRate) {
        beforeAfter['interestRate'] = {
          from: loan.interestRate,
          to: interestRate,
        };
        updateData.interestRate = interestRate;
      }
      if (tenureMonths !== loan.tenureMonths) {
        beforeAfter['tenureMonths'] = {
          from: loan.tenureMonths,
          to: tenureMonths,
        };
        updateData.tenureMonths = tenureMonths;
      }
      if (totalInterest !== loan.totalInterest) {
        beforeAfter['totalInterest'] = {
          from: loan.totalInterest,
          to: totalInterest,
        };
        updateData.totalInterest = totalInterest;
      }
      if (monthlyPayment !== loan.monthlyPayment) {
        beforeAfter['monthlyPayment'] = {
          from: loan.monthlyPayment,
          to: monthlyPayment,
        };
        updateData.monthlyPayment = monthlyPayment;
      }
    }

    if (!Object.keys(updateData).length) {
      return {
        id: loan.id,
        reference: loan.reference,
        status: loan.status,
        message: 'No changes to apply.',
      };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.loan.update({
        where: { id: loan.id },
        data: updateData,
      });
      await tx.activityLog.create({
        data: {
          tenantId: args.tenantId,
          userId: args.actorUserId,
          action: 'LOAN_EDITED',
          entityType: 'Loan',
          entityId: loan.id,
          metadata: {
            actorKind: isAdmin ? 'TA' : isOwner ? 'CLIENT' : 'WM',
            stateAtEdit: loan.status,
            changes: beforeAfter,
            editReason: args.dto.editReason ?? null,
          } as any,
        },
      });
      return u;
    });

    if (!isOwner) {
      void this.notifications.notifyUser(loan.clientId, {
        tenantId: args.tenantId,
        type: 'LOAN_REQUESTED',
        title: 'Your loan was updated',
        body: `${updated.reference}: details were edited by ${isAdmin ? 'a tenant admin' : 'a warehouse manager'}.`,
        relatedEntityType: 'loan',
        relatedEntityId: loan.id,
        data: { changedFields: Object.keys(beforeAfter) },
      });
    }
    if (!isAdmin) {
      void this.notifications.notifyTenantAdmins(args.tenantId, {
        type: 'LOAN_REQUESTED',
        title: 'Loan updated',
        body: `${updated.reference}: details were edited prior to admin action.`,
        relatedEntityType: 'loan',
        relatedEntityId: loan.id,
        data: { changedFields: Object.keys(beforeAfter) },
      });
    }

    return {
      id: updated.id,
      reference: updated.reference,
      status: updated.status,
      changedFields: Object.keys(beforeAfter),
      message: 'Loan updated.',
    };
  }

  async getLoanDetail(tenantId: string, id: string, forClientId?: string) {
    const loan = await this.prisma.loan.findFirst({
      where: {
        id,
        tenantId,
        ...(forClientId ? { clientId: forClientId } : {}),
      },
      include: {
        receipt: { include: { commodity: true, warehouse: true } },
        financier: true,
        client: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    return {
      id: loan.id,
      reference: loan.reference,
      status: loan.status,
      amount: loan.amount,
      interestRate: loan.interestRate,
      tenureMonths: loan.tenureMonths,
      totalInterest: loan.totalInterest,
      monthlyPayment: loan.monthlyPayment,
      notes: loan.notes,
      approvedAt: loan.approvedAt,
      repaidAt: loan.repaidAt,
      financier: { id: loan.financier.id, name: loan.financier.name },
      receipt: {
        id: loan.receipt.id,
        receiptNumber: loan.receipt.receiptNumber,
        commodity: loan.receipt.commodity.name,
        warehouse: loan.receipt.warehouse.name,
      },
      client: loan.client,
      createdAt: loan.createdAt,
      updatedAt: loan.updatedAt,
    };
  }
}
