import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminTransactionsService {
  constructor(private prisma: PrismaService) {}

  async getTransactions(
    tenantId: string,
    query: {
      type?: string;
      warehouseId?: string;
      clientId?: string;
      from?: string;
      to?: string;
      page?: string;
      limit?: string;
    },
  ) {
    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const skip = (page - 1) * limit;

    const dateFilter: any = {};
    if (query.from) dateFilter.gte = new Date(query.from);
    if (query.to) dateFilter.lte = new Date(query.to);

    const results: any[] = [];

    if (!query.type || query.type === 'WITHDRAWAL') {
      const where: any = { tenantId };
      if (query.clientId) where.clientId = query.clientId;
      if (query.warehouseId) where.receipt = { warehouseId: query.warehouseId };
      if (Object.keys(dateFilter).length) where.createdAt = dateFilter;

      const items = await this.prisma.withdrawal.findMany({
        where,
        include: {
          receipt: {
            include: {
              warehouse: { select: { id: true, name: true } },
              commodity: { select: { id: true, name: true, unitOfMeasure: true } },
            },
          },
          client: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      results.push(...items.map((i) => ({ ...i, type: 'WITHDRAWAL' })));
    }

    if (!query.type || query.type === 'LOAN') {
      const where: any = { tenantId };
      if (query.clientId) where.clientId = query.clientId;
      if (Object.keys(dateFilter).length) where.createdAt = dateFilter;

      const items = await this.prisma.loan.findMany({
        where,
        include: {
          receipt: {
            include: {
              warehouse: { select: { id: true, name: true } },
            },
          },
          client: { select: { id: true, firstName: true, lastName: true } },
          financier: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      results.push(...items.map((i) => ({ ...i, type: 'LOAN' })));
    }

    if (!query.type || query.type === 'TRADE') {
      const where: any = { tenantId };
      if (query.clientId) where.sellerId = query.clientId;
      if (Object.keys(dateFilter).length) where.createdAt = dateFilter;

      const items = await this.prisma.trade.findMany({
        where,
        include: {
          receipt: {
            include: {
              warehouse: { select: { id: true, name: true } },
              commodity: { select: { id: true, name: true, unitOfMeasure: true } },
            },
          },
          seller: { select: { id: true, firstName: true, lastName: true } },
          buyer: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      results.push(...items.map((i) => ({ ...i, type: 'TRADE' })));
    }

    // Sort combined results by createdAt desc
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = results.length;
    const paginated = results.slice(skip, skip + limit);

    return {
      data: paginated,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async exportTransactions(
    tenantId: string,
    query: { format?: string; type?: string; warehouseId?: string; from?: string; to?: string },
  ) {
    const { data } = await this.getTransactions(tenantId, { ...query, page: '1', limit: '10000' });

    if (query.format === 'csv') {
      const headers = ['id', 'type', 'status', 'createdAt'];
      const rows = data.map((row: any) =>
        headers.map((h) => JSON.stringify(row[h] ?? '')).join(','),
      );
      return [headers.join(','), ...rows].join('\n');
    }

    return data;
  }
}
