import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TradeStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class TradesService {
  constructor(
    private prisma: PrismaService,
    private ledger: InventoryLedgerService,
    private notifications: NotificationsService,
  ) {}

  async getTrades(
    tenantId: string,
    filters: { status?: string; page?: string; limit?: string; search?: string },
    forClientId?: string,
  ) {
    const page = parseInt(filters.page || '1', 10);
    const limit = parseInt(filters.limit || '10', 10);
    const skip = (page - 1) * limit;

    const where: any = { tenantId };
    if (filters.status) where.status = filters.status as TradeStatus;

    // For clients, restrict to trades where they are seller OR buyer; combine
    // with the search OR via AND when both are present.
    const ands: any[] = [];
    if (forClientId) {
      ands.push({
        OR: [{ sellerId: forClientId }, { buyerId: forClientId }],
      });
    }
    if (filters.search) {
      ands.push({
        OR: [
          { reference: { contains: filters.search, mode: 'insensitive' } },
          {
            receipt: {
              receiptNumber: {
                contains: filters.search,
                mode: 'insensitive',
              },
            },
          },
          {
            receipt: {
              commodity: {
                name: { contains: filters.search, mode: 'insensitive' },
              },
            },
          },
          {
            seller: {
              firstName: { contains: filters.search, mode: 'insensitive' },
            },
          },
          {
            seller: {
              lastName: { contains: filters.search, mode: 'insensitive' },
            },
          },
        ],
      });
    }
    if (ands.length === 1) Object.assign(where, ands[0]);
    else if (ands.length > 1) where.AND = ands;

    const [trades, total] = await Promise.all([
      this.prisma.trade.findMany({
        where,
        include: {
          receipt: { include: { commodity: true } },
          seller: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.trade.count({ where }),
    ]);

    return {
      data: trades.map((t) => ({
        id: t.id,
        reference: t.reference,
        receiptNumber: t.receipt.receiptNumber,
        commodityName: t.receipt.commodity.name,
        quantity: t.quantity,
        pricePerUnit: t.pricePerUnit,
        totalPrice: t.totalPrice,
        seller: `${t.seller.firstName} ${t.seller.lastName}`,
        status: t.status,
        createdAt: t.createdAt,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Reworked flow: select an ACTIVE receipt and push the whole thing to the
   * exchange. The ledger HOLDs it as HELD_TRADE. No client-entered quantity;
   * price is an optional ask (final price is exchange/settlement-driven).
   */
  async createTrade(
    tenantId: string,
    dto: { receiptId: string },
    sellerId: string,
    actorUserId?: string,
  ) {
    const receipt = await this.prisma.receipt.findFirst({
      where: { id: dto.receiptId, tenantId },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');

    const tradeId = randomUUID();
    const { held } = await this.ledger.hold({
      tenantId,
      sourceReceiptId: receipt.id,
      quantity: receipt.quantity,
      heldStatus: 'HELD_TRADE',
      txnType: 'TRADE',
      txnId: tradeId,
      actorUserId: actorUserId ?? sellerId,
      idempotencyKey: `TRADE:${tradeId}:hold`,
    });

    // Price is exchange-driven (set on settlement). Stored as 0 here.
    const qty = Number(held.quantity);
    const trade = await this.prisma.trade.upsert({
      where: { id: tradeId },
      update: {},
      create: {
        id: tradeId,
        reference: `T-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        receiptId: held.id,
        sellerId,
        tenantId,
        quantity: qty,
        pricePerUnit: 0,
        totalPrice: 0,
        status: TradeStatus.LISTED,
      },
    });

    void this.notifications.notifyUser(sellerId, {
      tenantId,
      type: 'TRADE_LISTED',
      title: 'Trade listed on the exchange',
      body: `${trade.reference}: ${qty} units of ${held.receiptNumber} are now listed.`,
      relatedEntityType: 'trade',
      relatedEntityId: trade.id,
    });
    void this.notifications.notifyTenantAdmins(tenantId, {
      type: 'TRADE_LISTED',
      title: 'New trade listing',
      body: `${trade.reference}: receipt ${held.receiptNumber} (${qty} units) listed.`,
      relatedEntityType: 'trade',
      relatedEntityId: trade.id,
    });

    return {
      id: trade.id,
      reference: trade.reference,
      status: trade.status,
      quantity: trade.quantity,
      pricePerUnit: trade.pricePerUnit,
      totalPrice: trade.totalPrice,
      listedReceipt: held.receiptNumber,
    };
  }

  private async loadTrade(tenantId: string, id: string) {
    const t = await this.prisma.trade.findFirst({ where: { id, tenantId } });
    if (!t) throw new NotFoundException('Trade not found');
    return t;
  }

  /**
   * Interim settlement (the webhook + storage-fee flow is deferred). Kept as a
   * clean composition of ledger primitives — no new primitive: transfer
   * ownership to the buyer, then release so the buyer holds an ACTIVE receipt
   * with the full lineage preserved.
   */
  async settleTrade(tenantId: string, tradeId: string, buyerId: string) {
    const trade = await this.loadTrade(tenantId, tradeId);
    if (trade.sellerId === buyerId) {
      throw new BadRequestException('Buyer and seller cannot be the same');
    }
    if (
      trade.status === TradeStatus.SETTLED &&
      trade.buyerId === buyerId
    ) {
      const buyer = await this.prisma.user.findFirst({
        where: { id: buyerId, tenantId },
      });
      return {
        id: trade.id,
        reference: trade.reference,
        status: trade.status,
        newOwner: buyer ? `${buyer.firstName} ${buyer.lastName}` : '',
      };
    }
    if (trade.status !== TradeStatus.LISTED) {
      throw new BadRequestException(
        `Trade is not available for settlement (status: ${trade.status})`,
      );
    }
    const buyer = await this.prisma.user.findFirst({
      where: { id: buyerId, tenantId },
    });
    if (!buyer) throw new NotFoundException('Buyer not found');

    await this.ledger.transferAndRelease({
      tenantId,
      heldReceiptId: trade.receiptId,
      newOwnerId: buyerId,
      txnType: 'TRADE',
      txnId: trade.id,
      idempotencyKey: `TRADE:${trade.id}:transfer`,
      withinTx: async (tx) => {
        const result = await tx.trade.updateMany({
          where: { id: tradeId, status: TradeStatus.LISTED },
          data: {
            status: TradeStatus.SETTLED,
            buyerId,
            settledAt: new Date(),
          },
        });
        if (result.count === 0) {
          throw new ConflictException(
            'Trade was settled by another buyer while this request was in flight',
          );
        }
      },
    });
    // Seller: their listing sold. Buyer: they now own the receipt. Admins: settled.
    const buyerName = `${buyer.firstName} ${buyer.lastName}`;
    void this.notifications.notifyUser(trade.sellerId, {
      tenantId,
      type: 'TRADE_SOLD',
      title: 'Your trade was settled',
      body: `${trade.reference}: sold to ${buyerName}.`,
      relatedEntityType: 'trade',
      relatedEntityId: trade.id,
      data: { buyerId },
    });
    void this.notifications.notifyUser(buyerId, {
      tenantId,
      type: 'TRADE_SOLD',
      title: 'Trade settled — ownership transferred',
      body: `${trade.reference}: you now own the receipt.`,
      relatedEntityType: 'trade',
      relatedEntityId: trade.id,
      data: { sellerId: trade.sellerId },
    });
    void this.notifications.notifyTenantAdmins(tenantId, {
      type: 'TRADE_SOLD',
      title: 'Trade settled',
      body: `${trade.reference}: settled to ${buyerName}.`,
      relatedEntityType: 'trade',
      relatedEntityId: trade.id,
    });

    return {
      id: trade.id,
      reference: trade.reference,
      status: TradeStatus.SETTLED,
      newOwner: buyerName,
    };
  }

  async cancelTrade(tenantId: string, tradeId: string) {
    const trade = await this.loadTrade(tenantId, tradeId);
    if (trade.status !== TradeStatus.LISTED) {
      throw new BadRequestException(
        `Trade cannot be cancelled (status: ${trade.status})`,
      );
    }
    await this.ledger.release({
      tenantId,
      heldReceiptId: trade.receiptId,
      idempotencyKey: `TRADE:${trade.id}:cancel-release`,
    });
    const updated = await this.prisma.trade.update({
      where: { id: tradeId },
      data: { status: TradeStatus.CANCELLED },
    });
    void this.notifications.notifyUser(trade.sellerId, {
      tenantId,
      type: 'TRADE_CANCELLED',
      title: 'Trade cancelled',
      body: `${updated.reference} was cancelled and the receipt released back to active.`,
      relatedEntityType: 'trade',
      relatedEntityId: updated.id,
    });
    return { id: updated.id, status: updated.status };
  }

  async getTradeDetail(tenantId: string, id: string, forClientId?: string) {
    const trade = await this.prisma.trade.findFirst({
      where: {
        id,
        tenantId,
        ...(forClientId
          ? { OR: [{ sellerId: forClientId }, { buyerId: forClientId }] }
          : {}),
      },
      include: {
        receipt: { include: { commodity: true, warehouse: true } },
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
