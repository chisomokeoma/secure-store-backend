import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptStatus } from '@prisma/client';
import { CalculateWithdrawalDto, CreateWithdrawalDto } from './dto/withdrawals.dto';

@Injectable()
export class WithdrawalsService {
  constructor(private prisma: PrismaService) { }

  async getEligibleReceipts(clientId?: string) {
    const user = clientId ? { id: clientId } : await this.prisma.user.findFirst({ where: { email: 'demo@securestore.com' } });
    return this.prisma.receipt.findMany({
      where: { clientId: user?.id, status: ReceiptStatus.ACTIVE, quantityAvailable: { gt: 0 } },
      include: { commodity: true, warehouse: true }
    }).then(res => res.map(r => ({
      id: r.id,
      receiptNumber: r.receiptNumber,
      commodity: r.commodity.name,
      availableQuantity: r.quantityAvailable,
      warehouse: r.warehouse.name,
      unit: r.commodity.unitOfMeasure
    })));
  }

  async getReceiptPrefill(receiptId: string) {
    const r = await this.prisma.receipt.findUnique({ where: { id: receiptId }, include: { warehouse: true, commodity: true } });
    if (!r) throw new NotFoundException('Receipt not found');

    const wc = await this.prisma.warehouseCommodity.findUnique({
      where: { warehouseId_commodityId: { warehouseId: r.warehouseId, commodityId: r.commodityId } }
    });

    return {
      maxQuantity: r.quantityAvailable,
      storageFeePerUnit: wc?.storageFeePerUnit || 15,
      receiptDetails: {
        receiptNumber: r.receiptNumber,
        commodity: r.commodity.name,
        grade: r.grade || 'Standard',
        warehouseLocation: r.warehouse.location,
        dateOfDeposit: r.dateOfDeposit,
        expiryDate: r.expiryDate
      }
    };
  }

  async calculateWithdrawal(dto: CalculateWithdrawalDto) {
    const prefill = await this.getReceiptPrefill(dto.receiptId);
    if (dto.quantity > (prefill.maxQuantity || 0)) throw new BadRequestException('Requested quantity exceeds available quantity');

    const storageFee = dto.quantity * prefill.storageFeePerUnit;
    const handlingFee = 10000; // Mocked handling fee matching the design
    const totalFee = storageFee + handlingFee;

    return {
      totalFee,
      breakdown: {
        quantity: dto.quantity,
        feePerUnit: prefill.storageFeePerUnit,
        storageFee,
        handlingFee
      }
    };
  }

  async createWithdrawalRequest(dto: CreateWithdrawalDto) {
    const calc = await this.calculateWithdrawal(dto);
    return {
      id: 'W-REQ-' + Math.floor(Math.random() * 10000),
      status: 'PENDING_PAYMENT',
      quantity: dto.quantity,
      fee: calc.totalFee,
      reason: dto.reason,
      plannedDate: dto.plannedDate
    };
  }

  async confirmPayment(id: string) {
    return { id, status: 'PAID_PENDING_APPROVAL', quantity: 0 };
  }
}
