import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptStatus, TradeStatus } from '@prisma/client';

@Injectable()
export class TradesService {
  constructor(private prisma: PrismaService) {}

  async getTradeListings() {
    const trades = await this.prisma.trade.findMany({
      where: { status: TradeStatus.LISTED },
      include: { receipt: { include: { commodity: true } }, seller: true },
    });

    return trades.map((t) => ({
      id: t.id,
      reference: t.reference,
      receiptNumber: t.receipt.receiptNumber,
      commodityName: t.receipt.commodity.name,
      quantity: t.quantity,
      pricePerUnit: t.pricePerUnit,
      totalPrice: t.totalPrice,
      seller: `${t.seller.firstName} ${t.seller.lastName}`,
    }));
  }

  async createTrade(
    dto: { receiptId: string; pricePerUnit: number },
    sellerId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.findUnique({
        where: { id: dto.receiptId },
      });
      if (!receipt) throw new NotFoundException('Receipt not found');
      if (receipt.status !== ReceiptStatus.ACTIVE) {
        throw new BadRequestException(
          `Receipt is not active and cannot be listed (status: ${receipt.status})`,
        );
      }
      if (receipt.quantityAvailable <= 0) {
        throw new BadRequestException('Receipt has no available quantity');
      }
      if (dto.pricePerUnit <= 0) {
        throw new BadRequestException(
          'Price per unit must be greater than zero',
        );
      }

      const seller = sellerId
        ? { id: sellerId }
        : await tx.user.findFirst({
            where: { email: 'demo@securestore.com' },
          });
      if (!seller) throw new NotFoundException('Seller not found');

      const quantity = receipt.quantityAvailable;
      const totalPrice = quantity * dto.pricePerUnit;

      // Lock the receipt — LIEN means it's listed for trade
      await tx.receipt.update({
        where: { id: receipt.id },
        data: {
          status: ReceiptStatus.LIEN,
          quantityAvailable: 0,
        },
      });

      const trade = await tx.trade.create({
        data: {
          reference: `T-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          receiptId: receipt.id,
          sellerId: seller.id,
          quantity,
          pricePerUnit: dto.pricePerUnit,
          totalPrice,
          status: TradeStatus.LISTED,
        },
      });

      return {
        id: trade.id,
        reference: trade.reference,
        status: trade.status,
        quantity: trade.quantity,
        pricePerUnit: trade.pricePerUnit,
        totalPrice: trade.totalPrice,
        listedReceipt: receipt.receiptNumber,
      };
    });
  }

  async settleTrade(tradeId: string, buyerId: string) {
    return this.prisma.$transaction(async (tx) => {
      const trade = await tx.trade.findUnique({
        where: { id: tradeId },
        include: { receipt: true },
      });
      if (!trade) throw new NotFoundException('Trade not found');
      if (trade.status !== TradeStatus.LISTED) {
        throw new BadRequestException(
          `Trade is not available for settlement (status: ${trade.status})`,
        );
      }
      if (trade.sellerId === buyerId) {
        throw new BadRequestException('Buyer and seller cannot be the same');
      }

      const buyer = await tx.user.findUnique({ where: { id: buyerId } });
      if (!buyer) throw new NotFoundException('Buyer not found');

      // Transfer ownership and reactivate the receipt
      await tx.receipt.update({
        where: { id: trade.receiptId },
        data: {
          clientId: buyerId,
          status: ReceiptStatus.ACTIVE,
          quantityAvailable: trade.receipt.quantity,
        },
      });

      const updated = await tx.trade.update({
        where: { id: tradeId },
        data: {
          status: TradeStatus.SETTLED,
          buyerId,
          settledAt: new Date(),
        },
      });

      return {
        id: updated.id,
        reference: updated.reference,
        status: updated.status,
        receiptNumber: trade.receipt.receiptNumber,
        newOwner: `${buyer.firstName} ${buyer.lastName}`,
      };
    });
  }

  async cancelTrade(tradeId: string) {
    return this.prisma.$transaction(async (tx) => {
      const trade = await tx.trade.findUnique({
        where: { id: tradeId },
        include: { receipt: true },
      });
      if (!trade) throw new NotFoundException('Trade not found');
      if (trade.status !== TradeStatus.LISTED) {
        throw new BadRequestException(
          `Trade cannot be cancelled (status: ${trade.status})`,
        );
      }

      // Return the receipt to ACTIVE for the seller
      await tx.receipt.update({
        where: { id: trade.receiptId },
        data: {
          status: ReceiptStatus.ACTIVE,
          quantityAvailable: trade.receipt.quantity,
        },
      });

      const updated = await tx.trade.update({
        where: { id: tradeId },
        data: { status: TradeStatus.CANCELLED },
      });

      return { id: updated.id, status: updated.status };
    });
  }
  async getTradeDetail(id: string) {
    const trade = await this.prisma.trade.findUnique({
      where: { id },
      include: {
        receipt: {
          include: { commodity: true, warehouse: true },
        },
        seller: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        buyer: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    if (!trade) throw new NotFoundException('Trade not found');

    return {
      id: trade.id,
      reference: trade.reference,
      status: trade.status,
      quantity: trade.quantity,
      pricePerUnit: trade.pricePerUnit,
      totalPrice: trade.totalPrice,
      receipt: {
        id: trade.receipt.id,
        receiptNumber: trade.receipt.receiptNumber,
        commodity: trade.receipt.commodity.name,
        warehouse: trade.receipt.warehouse.name,
      },
      seller: trade.seller,
      buyer: trade.buyer,
      settledAt: trade.settledAt,
      createdAt: trade.createdAt,
      updatedAt: trade.updatedAt,
    };
  }
}
