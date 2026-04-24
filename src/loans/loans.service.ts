import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LoansService {
  constructor(private prisma: PrismaService) {}

  async getFinanciers() {
    return this.prisma.financier.findMany({
        select: { id: true, name: true, interestRate: true, maxTenure: true }
    });
  }

  async getPledgeableReceipts(commodity?: string) {
    const receipts = await this.prisma.receipt.findMany({
      where: { status: 'ACTIVE', quantityAvailable: { gt: 0 } },
      include: { commodity: true }
    });
    
    return receipts
        .filter(r => !commodity || r.commodity.name.toLowerCase() === commodity.toLowerCase())
        .map(r => ({
            id: r.id,
            receiptNumber: r.receiptNumber,
            availableQuantity: r.quantityAvailable,
            commodity: r.commodity.name
        }));
  }

  async calculateLoan(dto: any) {
    const financier = await this.prisma.financier.findUnique({ where: { id: dto.financierId } });
    if (!financier) throw new NotFoundException('Financier not found');

    const totalInterest = (dto.amount * financier.interestRate) / 100;
    return { totalInterest, monthlyPayment: (dto.amount + totalInterest) / 12 };
  }

  async createLoan(dto: any) {
    return { id: 'L-REQ-' + Math.floor(Math.random()*10000), status: 'PENDING', amount: dto.amount };
  }
}
