import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptStatus, WithdrawalStatus } from '@prisma/client';
import {
  CalculateWithdrawalDto,
  CreateWithdrawalDto,
} from './dto/withdrawals.dto';

@Injectable()
export class WithdrawalsService {
  constructor(private prisma: PrismaService) {}

  async getWithdrawals(
    tenantId: string,
    filters: {
      status?: string;
      page?: string;
      limit?: string;
      search?: string;
    },
  ) {
    const page = parseInt(filters.page || '1', 10);
    const limit = parseInt(filters.limit || '10', 10);
    const skip = (page - 1) * limit;

    const where: any = { tenantId };

    if (filters.status) {
      where.status = filters.status as WithdrawalStatus;
    }

    if (filters.search) {
      where.OR = [
        { reference: { contains: filters.search, mode: 'insensitive' } },
        {
          receipt: {
            receiptNumber: { contains: filters.search, mode: 'insensitive' },
          },
        },
        {
          receipt: {
            commodity: {
              name: { contains: filters.search, mode: 'insensitive' },
            },
          },
        },
      ];
    }

    const [withdrawals, total] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where,
        include: {
          receipt: {
            include: { commodity: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.withdrawal.count({ where }),
    ]);

    const data = withdrawals.map((w) => ({
      id: w.id,
      reference: w.reference,
      receiptNumber: w.receipt.receiptNumber,
      commodity: w.receipt.commodity.name,
      quantity: w.quantity,
      status: w.status,
      createdAt: w.createdAt,
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

  async getEligibleReceipts(tenantId: string, clientId: string) {
    const receipts = await this.prisma.receipt.findMany({
      where: {
        tenantId,
        clientId: clientId,
        status: ReceiptStatus.ACTIVE,
        quantityAvailable: { gt: 0 },
      },
      include: { commodity: true, warehouse: true },
    });

    return receipts.map((r) => ({
      id: r.id,
      receiptNumber: r.receiptNumber,
      commodity: r.commodity.name,
      availableQuantity: r.quantityAvailable,
      warehouse: r.warehouse.name,
      unit: r.commodity.unitOfMeasure,
    }));
  }

  async getReceiptPrefill(tenantId: string, receiptId: string) {
    const r = await this.prisma.receipt.findFirst({
      where: { id: receiptId, tenantId },
      include: { warehouse: true, commodity: true },
    });
    if (!r) throw new NotFoundException('Receipt not found');

    const wc = await this.prisma.warehouseCommodity.findUnique({
      where: {
        warehouseId_commodityId: {
          warehouseId: r.warehouseId,
          commodityId: r.commodityId,
        },
      },
    });

    return {
      maxQuantity: r.quantityAvailable,
      storageFeePerUnit: wc?.storageFeePerUnit ?? 15,
      receiptDetails: {
        receiptNumber: r.receiptNumber,
        commodity: r.commodity.name,
        grade: r.grade || 'Standard',
        warehouseLocation: r.warehouse.location,
        dateOfDeposit: r.dateOfDeposit,
        expiryDate: r.expiryDate,
      },
    };
  }

  async calculateWithdrawal(tenantId: string, dto: CalculateWithdrawalDto) {
    const prefill = await this.getReceiptPrefill(tenantId, dto.receiptId);
    if (dto.quantity <= 0) {
      throw new BadRequestException('Quantity must be greater than zero');
    }
    if (dto.quantity > (prefill.maxQuantity || 0)) {
      throw new BadRequestException(
        'Requested quantity exceeds available quantity',
      );
    }

    const storageFee = dto.quantity * prefill.storageFeePerUnit;
    const handlingFee = 10000;
    const totalFee = storageFee + handlingFee;

    return {
      totalFee,
      breakdown: {
        quantity: dto.quantity,
        feePerUnit: prefill.storageFeePerUnit,
        storageFee,
        handlingFee,
      },
    };
  }

  async createWithdrawalRequest(
    tenantId: string,
    dto: CreateWithdrawalDto,
    clientId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Re-fetch inside the transaction to prevent races
      const receipt = await tx.receipt.findFirst({
        where: { id: dto.receiptId, tenantId },
      });
      if (!receipt) throw new NotFoundException('Receipt not found');
      if (receipt.status !== ReceiptStatus.ACTIVE) {
        throw new BadRequestException(
          `Receipt is not active (status: ${receipt.status})`,
        );
      }
      if (dto.quantity <= 0) {
        throw new BadRequestException('Quantity must be greater than zero');
      }
      if (dto.quantity > receipt.quantityAvailable) {
        throw new BadRequestException(
          'Requested quantity exceeds available quantity',
        );
      }

      // Compute fees inside the tx (don't trust the prefill from earlier reads)
      const wc = await tx.warehouseCommodity.findUnique({
        where: {
          warehouseId_commodityId: {
            warehouseId: receipt.warehouseId,
            commodityId: receipt.commodityId,
          },
        },
      });
      const feePerUnit = wc?.storageFeePerUnit ?? 15;
      const storageFee = dto.quantity * feePerUnit;
      const handlingFee = 10000;
      const totalFee = storageFee + handlingFee;

      const withdrawal = await tx.withdrawal.create({
        data: {
          reference: `W-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          receiptId: receipt.id,
          clientId: clientId,
          tenantId: tenantId,
          quantity: dto.quantity,
          reason: dto.reason,
          plannedDate: new Date(dto.plannedDate),
          status: WithdrawalStatus.PENDING_PAYMENT,
          storageFee,
          handlingFee,
          totalFee,
        },
      });

      return {
        id: withdrawal.id,
        reference: withdrawal.reference,
        status: withdrawal.status,
        quantity: withdrawal.quantity,
        fee: withdrawal.totalFee,
        reason: withdrawal.reason,
        plannedDate: withdrawal.plannedDate,
      };
    });
  }

  async confirmPayment(tenantId: string, withdrawalId: string) {
    return this.prisma.$transaction(async (tx) => {
      const w = await tx.withdrawal.findFirst({
        where: { id: withdrawalId, tenantId },
      });
      if (!w) throw new NotFoundException('Withdrawal not found');
      if (w.status !== WithdrawalStatus.PENDING_PAYMENT) {
        throw new BadRequestException(
          `Withdrawal is not awaiting payment (status: ${w.status})`,
        );
      }

      const updated = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.PAID_PENDING_APPROVAL },
      });

      return {
        id: updated.id,
        reference: updated.reference,
        status: updated.status,
        quantity: updated.quantity,
      };
    });
  }

  async approveWithdrawal(tenantId: string, withdrawalId: string) {
    return this.prisma.$transaction(async (tx) => {
      const w = await tx.withdrawal.findFirst({
        where: { id: withdrawalId, tenantId },
      });
      if (!w) throw new NotFoundException('Withdrawal not found');
      if (w.status !== WithdrawalStatus.PAID_PENDING_APPROVAL) {
        throw new BadRequestException(
          `Withdrawal is not awaiting approval (status: ${w.status})`,
        );
      }

      const updated = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.APPROVED },
      });

      return { id: updated.id, status: updated.status };
    });
  }

  async rejectWithdrawal(tenantId: string, withdrawalId: string) {
    return this.prisma.$transaction(async (tx) => {
      const w = await tx.withdrawal.findFirst({
        where: { id: withdrawalId, tenantId },
      });
      if (!w) throw new NotFoundException('Withdrawal not found');
      if (
        w.status === WithdrawalStatus.COMPLETED ||
        w.status === WithdrawalStatus.REJECTED
      ) {
        throw new BadRequestException(
          `Withdrawal is already ${w.status.toLowerCase()}`,
        );
      }

      const updated = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.REJECTED },
      });

      return { id: updated.id, status: updated.status };
    });
  }

  async completeWithdrawal(tenantId: string, withdrawalId: string) {
    return this.prisma.$transaction(async (tx) => {
      const w = await tx.withdrawal.findFirst({
        where: { id: withdrawalId, tenantId },
        include: { receipt: true },
      });
      if (!w) throw new NotFoundException('Withdrawal not found');
      if (w.status !== WithdrawalStatus.APPROVED) {
        throw new BadRequestException(
          `Withdrawal must be APPROVED before completion (status: ${w.status})`,
        );
      }

      const parent = w.receipt;
      if (parent.status !== ReceiptStatus.ACTIVE) {
        throw new BadRequestException(
          `Source receipt is no longer active (status: ${parent.status})`,
        );
      }
      if (w.quantity > parent.quantityAvailable) {
        throw new BadRequestException(
          'Withdrawal quantity exceeds remaining available quantity on receipt',
        );
      }

      const remainder = parent.quantityAvailable - w.quantity;

      // Mark the parent receipt as WITHDRAWN (it's been fully accounted for)
      await tx.receipt.update({
        where: { id: parent.id },
        data: {
          status: ReceiptStatus.WITHDRAWN,
          quantityAvailable: 0,
        },
      });

      // If there's remaining stock, issue a new child receipt for it
      let childReceipt: any = null;
      if (remainder > 0) {
        const childNumber = await this.generateChildReceiptNumber(
          tx,
          parent.receiptNumber,
        );
        childReceipt = await tx.receipt.create({
          data: {
            receiptNumber: childNumber,
            status: ReceiptStatus.ACTIVE,
            commodityId: parent.commodityId,
            warehouseId: parent.warehouseId,
            clientId: parent.clientId,
            tenantId: tenantId,
            parentReceiptId: parent.id,
            quantity: remainder,
            quantityAvailable: remainder,
            grade: parent.grade,
            dateOfDeposit: parent.dateOfDeposit,
            expiryDate: parent.expiryDate,
          },
        });
      }

      const updated = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.COMPLETED },
      });

      return {
        withdrawal: {
          id: updated.id,
          reference: updated.reference,
          status: updated.status,
          quantity: updated.quantity,
        },
        cancelledReceipt: parent.receiptNumber,
        newReceipt: childReceipt
          ? {
              id: childReceipt.id,
              receiptNumber: childReceipt.receiptNumber,
              quantity: childReceipt.quantity,
            }
          : null,
      };
    });
  }

  private async generateChildReceiptNumber(
    tx: any,
    parentNumber: string,
  ): Promise<string> {
    const baseNumber = parentNumber.replace(/-[A-Z]+$/, '');
    const existing = await tx.receipt.findMany({
      where: { receiptNumber: { startsWith: `${baseNumber}-` } },
      select: { receiptNumber: true },
    });
    const suffixes = existing
      .map((r: { receiptNumber: string }) =>
        r.receiptNumber.slice(baseNumber.length + 1),
      )
      .filter((s: string) => /^[A-Z]+$/.test(s));
    const next = this.nextSuffix(suffixes);
    return `${baseNumber}-${next}`;
  }

  private nextSuffix(existing: string[]): string {
    if (existing.length === 0) return 'A';
    const sorted = [...existing].sort();
    const last = sorted[sorted.length - 1];
    if (last === 'Z') return 'AA';
    if (last.length === 1) {
      return String.fromCharCode(last.charCodeAt(0) + 1);
    }
    const chars = last.split('');
    for (let i = chars.length - 1; i >= 0; i--) {
      if (chars[i] !== 'Z') {
        chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
        return chars.join('');
      }
      chars[i] = 'A';
    }
    return 'A' + chars.join('');
  }

  async getWithdrawalDetail(tenantId: string, id: string) {
    const w = await this.prisma.withdrawal.findFirst({
      where: { id, tenantId },
      include: {
        receipt: {
          include: { commodity: true, warehouse: true },
        },
        client: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    if (!w) throw new NotFoundException('Withdrawal not found');

    return {
      id: w.id,
      reference: w.reference,
      status: w.status,
      quantity: w.quantity,
      reason: w.reason,
      plannedDate: w.plannedDate,
      storageFee: w.storageFee,
      handlingFee: w.handlingFee,
      totalFee: w.totalFee,
      receipt: {
        id: w.receipt.id,
        receiptNumber: w.receipt.receiptNumber,
        commodity: w.receipt.commodity.name,
        warehouse: w.receipt.warehouse.name,
      },
      client: w.client,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  }
}
