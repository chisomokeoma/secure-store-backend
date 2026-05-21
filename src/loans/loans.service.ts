import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LoanStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CalculateLoanDto, CreateLoanDto } from './dto/loans.dto';

@Injectable()
export class LoansService {
  constructor(
    private prisma: PrismaService,
    private ledger: InventoryLedgerService,
    private notifications: NotificationsService,
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
  ) {
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
