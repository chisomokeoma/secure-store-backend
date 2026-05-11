import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptStatus, LoanStatus } from '@prisma/client';
import { CalculateLoanDto, CreateLoanDto } from './dto/loans.dto';

@Injectable()
export class LoansService {
  constructor(private prisma: PrismaService) {}

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

  async getPledgeableReceipts(
    tenantId: string,
    clientId: string,
    commodity?: string,
  ) {
    const receipts = await this.prisma.receipt.findMany({
      where: {
        tenantId,
        clientId: clientId,
        status: ReceiptStatus.ACTIVE,
        quantityAvailable: { gt: 0 },
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
        availableQuantity: r.quantityAvailable,
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

  async createLoan(tenantId: string, dto: CreateLoanDto, clientId: string) {
    return this.prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.findFirst({
        where: { id: dto.receiptId, tenantId },
      });
      if (!receipt) throw new NotFoundException('Receipt not found');
      if (receipt.status !== ReceiptStatus.ACTIVE) {
        throw new BadRequestException(
          `Receipt is not active and cannot be pledged (status: ${receipt.status})`,
        );
      }
      if (receipt.quantityAvailable <= 0) {
        throw new BadRequestException('Receipt has no available quantity');
      }

      const financier = await tx.financier.findFirst({
        where: { id: dto.financierId, tenantId },
      });
      if (!financier) throw new NotFoundException('Financier not found');

      const tenureMonths = financier.maxTenure;
      const totalInterest = (dto.amount * financier.interestRate) / 100;
      const monthlyPayment = (dto.amount + totalInterest) / tenureMonths;

      // Pledge the receipt — locks it from withdrawal/trade
      await tx.receipt.update({
        where: { id: receipt.id },
        data: {
          status: ReceiptStatus.PLEDGED,
          quantityAvailable: 0,
        },
      });

      const loan = await tx.loan.create({
        data: {
          reference: `L-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          receiptId: receipt.id,
          clientId: clientId,
          tenantId: tenantId,
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

      return {
        id: loan.id,
        reference: loan.reference,
        status: loan.status,
        amount: loan.amount,
        totalInterest: loan.totalInterest,
        monthlyPayment: loan.monthlyPayment,
        tenureMonths: loan.tenureMonths,
        pledgedReceipt: receipt.receiptNumber,
      };
    });
  }

  async approveLoan(tenantId: string, loanId: string) {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, tenantId },
      });
      if (!loan) throw new NotFoundException('Loan not found');
      if (loan.status !== LoanStatus.PENDING) {
        throw new BadRequestException(
          `Loan is not pending (status: ${loan.status})`,
        );
      }

      const updated = await tx.loan.update({
        where: { id: loanId },
        data: { status: LoanStatus.ACTIVE, approvedAt: new Date() },
      });

      return { id: updated.id, status: updated.status };
    });
  }

  async rejectLoan(tenantId: string, loanId: string) {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, tenantId },
      });
      if (!loan) throw new NotFoundException('Loan not found');
      if (loan.status !== LoanStatus.PENDING) {
        throw new BadRequestException(
          `Loan is not pending (status: ${loan.status})`,
        );
      }

      // Restore the pledged receipt to ACTIVE
      await tx.receipt.update({
        where: { id: loan.receiptId },
        data: {
          status: ReceiptStatus.ACTIVE,
          quantityAvailable: { set: 0 },
        },
      });

      const receipt = await tx.receipt.findUnique({
        where: { id: loan.receiptId },
      });
      if (receipt) {
        await tx.receipt.update({
          where: { id: receipt.id },
          data: { quantityAvailable: receipt.quantity },
        });
      }

      const updated = await tx.loan.update({
        where: { id: loanId },
        data: { status: LoanStatus.REJECTED },
      });

      return { id: updated.id, status: updated.status };
    });
  }

  async repayLoan(tenantId: string, loanId: string) {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, tenantId },
        include: { receipt: true },
      });
      if (!loan) throw new NotFoundException('Loan not found');
      if (loan.status !== LoanStatus.ACTIVE) {
        throw new BadRequestException(
          `Loan is not active (status: ${loan.status})`,
        );
      }

      // Release the pledged receipt
      await tx.receipt.update({
        where: { id: loan.receipt.id },
        data: {
          status: ReceiptStatus.ACTIVE,
          quantityAvailable: loan.receipt.quantity,
        },
      });

      const updated = await tx.loan.update({
        where: { id: loanId },
        data: { status: LoanStatus.REPAID, repaidAt: new Date() },
      });

      return {
        id: updated.id,
        status: updated.status,
        releasedReceipt: loan.receipt.receiptNumber,
      };
    });
  }

  async getLoanDetail(tenantId: string, id: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      include: {
        receipt: {
          include: { commodity: true, warehouse: true },
        },
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
