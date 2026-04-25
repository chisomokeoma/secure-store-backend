import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type TransactionType = 'WITHDRAWAL' | 'LOAN' | 'TRADE';

export interface UnifiedTransaction {
  id: string;
  type: TransactionType;
  reference: string;
  status: string;
  amount: number;
  quantity?: number;
  receiptNumber?: string;
  commodity?: string;
  counterparty?: string;
  date: Date;
}

@Injectable()
export class TransactionsService {
  constructor(private prisma: PrismaService) {}

  async getTransactions(filters: {
    type?: string;
    clientId?: string;
    from?: string;
    to?: string;
    page?: string;
    limit?: string;
  }) {
    const { type, clientId, from, to, page, limit } = filters || {};

    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;

    const dateFilter =
      fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {};

    const clientFilter = clientId ? { clientId } : {};

    const wantsType = (t: TransactionType) => !type || type.toUpperCase() === t;

    const promises: Promise<UnifiedTransaction[]>[] = [];

    if (wantsType('WITHDRAWAL')) {
      promises.push(
        this.prisma.withdrawal
          .findMany({
            where: { ...clientFilter, ...dateFilter },
            include: {
              receipt: { include: { commodity: true } },
            },
            orderBy: { createdAt: 'desc' },
          })
          .then((rows) =>
            rows.map((w) => ({
              id: w.id,
              type: 'WITHDRAWAL' as const,
              reference: w.reference,
              status: w.status,
              amount: w.totalFee,
              quantity: w.quantity,
              receiptNumber: w.receipt.receiptNumber,
              commodity: w.receipt.commodity.name,
              date: w.createdAt,
            })),
          ),
      );
    }

    if (wantsType('LOAN')) {
      promises.push(
        this.prisma.loan
          .findMany({
            where: { ...clientFilter, ...dateFilter },
            include: {
              receipt: { include: { commodity: true } },
              financier: true,
            },
            orderBy: { createdAt: 'desc' },
          })
          .then((rows) =>
            rows.map((l) => ({
              id: l.id,
              type: 'LOAN' as const,
              reference: l.reference,
              status: l.status,
              amount: l.amount,
              receiptNumber: l.receipt.receiptNumber,
              commodity: l.receipt.commodity.name,
              counterparty: l.financier.name,
              date: l.createdAt,
            })),
          ),
      );
    }

    if (wantsType('TRADE')) {
      const tradeWhere = clientId
        ? { OR: [{ sellerId: clientId }, { buyerId: clientId }] }
        : {};
      promises.push(
        this.prisma.trade
          .findMany({
            where: { ...tradeWhere, ...dateFilter },
            include: {
              receipt: { include: { commodity: true } },
              seller: true,
              buyer: true,
            },
            orderBy: { createdAt: 'desc' },
          })
          .then((rows) =>
            rows.map((t) => ({
              id: t.id,
              type: 'TRADE' as const,
              reference: t.reference,
              status: t.status,
              amount: t.totalPrice,
              quantity: t.quantity,
              receiptNumber: t.receipt.receiptNumber,
              commodity: t.receipt.commodity.name,
              counterparty: clientId
                ? t.sellerId === clientId
                  ? t.buyer
                    ? `${t.buyer.firstName} ${t.buyer.lastName}`
                    : 'Awaiting buyer'
                  : `${t.seller.firstName} ${t.seller.lastName}`
                : `${t.seller.firstName} ${t.seller.lastName}`,
              date: t.createdAt,
            })),
          ),
      );
    }

    const buckets = await Promise.all(promises);
    const all = buckets.flat();

    // Sort newest-first
    all.sort((a, b) => b.date.getTime() - a.date.getTime());

    // Paginate
    const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
    const perPage = limit ? Math.max(1, parseInt(limit, 10)) : 50;
    const start = (pageNum - 1) * perPage;
    const items = all.slice(start, start + perPage);

    return {
      items,
      pagination: {
        page: pageNum,
        limit: perPage,
        total: all.length,
        totalPages: Math.ceil(all.length / perPage) || 1,
      },
    };
  }

  async getTransactionDetail(id: string) {
    // Try each table in turn — UUIDs are unique across tables, so only one will match.
    const w = await this.prisma.withdrawal.findUnique({
      where: { id },
      include: {
        receipt: { include: { commodity: true, warehouse: true } },
        client: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    if (w) {
      return {
        id: w.id,
        type: 'WITHDRAWAL',
        reference: w.reference,
        status: w.status,
        amount: w.totalFee,
        quantity: w.quantity,
        reason: w.reason,
        plannedDate: w.plannedDate,
        storageFee: w.storageFee,
        handlingFee: w.handlingFee,
        receipt: {
          id: w.receipt.id,
          receiptNumber: w.receipt.receiptNumber,
          commodity: w.receipt.commodity.name,
          warehouse: w.receipt.warehouse.name,
        },
        client: w.client,
        date: w.createdAt,
      };
    }

    const loan = await this.prisma.loan.findUnique({
      where: { id },
      include: {
        receipt: { include: { commodity: true, warehouse: true } },
        financier: true,
        client: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    if (loan) {
      return {
        id: loan.id,
        type: 'LOAN',
        reference: loan.reference,
        status: loan.status,
        amount: loan.amount,
        interestRate: loan.interestRate,
        tenureMonths: loan.tenureMonths,
        totalInterest: loan.totalInterest,
        monthlyPayment: loan.monthlyPayment,
        financier: { id: loan.financier.id, name: loan.financier.name },
        receipt: {
          id: loan.receipt.id,
          receiptNumber: loan.receipt.receiptNumber,
          commodity: loan.receipt.commodity.name,
          warehouse: loan.receipt.warehouse.name,
        },
        client: loan.client,
        date: loan.createdAt,
      };
    }

    const trade = await this.prisma.trade.findUnique({
      where: { id },
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
    if (trade) {
      return {
        id: trade.id,
        type: 'TRADE',
        reference: trade.reference,
        status: trade.status,
        amount: trade.totalPrice,
        quantity: trade.quantity,
        pricePerUnit: trade.pricePerUnit,
        receipt: {
          id: trade.receipt.id,
          receiptNumber: trade.receipt.receiptNumber,
          commodity: trade.receipt.commodity.name,
          warehouse: trade.receipt.warehouse.name,
        },
        seller: trade.seller,
        buyer: trade.buyer,
        settledAt: trade.settledAt,
        date: trade.createdAt,
      };
    }

    throw new NotFoundException('Transaction not found');
  }

  async exportTransactions(format?: string) {
    if (format && !['csv', 'json'].includes(format.toLowerCase())) {
      throw new BadRequestException('Unsupported format. Use csv or json.');
    }

    const { items } = await this.getTransactions({ limit: '10000' });

    if (format?.toLowerCase() === 'csv') {
      const headers = [
        'id',
        'type',
        'reference',
        'status',
        'amount',
        'quantity',
        'receiptNumber',
        'commodity',
        'counterparty',
        'date',
      ];
      const rows = items.map((t) =>
        headers
          .map((h) => {
            const v = (t as any)[h];
            if (v == null) return '';
            const s = v instanceof Date ? v.toISOString() : String(v);
            return `"${s.replace(/"/g, '""')}"`;
          })
          .join(','),
      );
      return [headers.join(','), ...rows].join('\n');
    }

    return items;
  }
}
