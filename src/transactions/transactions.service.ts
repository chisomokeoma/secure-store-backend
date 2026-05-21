import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { WarehouseManagerService } from '../warehouse-manager/warehouse-manager.service';

/**
 * Legacy /transactions service. Delegates to the canonical
 * WarehouseManagerService.listTransactions so there is ONE source of truth
 * for "a transaction" across /transactions, /admin/transactions and
 * /manager/transactions. Properly tenant-scoped; no more cross-tenant leak.
 */
@Injectable()
export class TransactionsService {
  constructor(private wm: WarehouseManagerService) {}

  async getTransactions(
    tenantId: string,
    filters: {
      type?: string;
      from?: string;
      to?: string;
      page?: string;
      limit?: string;
    },
  ) {
    return this.wm.listTransactions(tenantId, {
      type: filters.type,
      fromDate: filters.from,
      toDate: filters.to,
      page: filters.page,
      limit: filters.limit,
    });
  }

  async getTransactionDetail(tenantId: string, id: string) {
    // The legacy endpoint took only an id (no type). Try each domain in turn
    // and return the first hit. Tenant-scoped throughout.
    for (const type of ['WITHDRAWAL', 'LOAN', 'TRADE', 'DEPOSIT']) {
      try {
        return await this.wm.getTransactionDetail(tenantId, type, id);
      } catch (e) {
        if (e instanceof NotFoundException) continue;
        throw e;
      }
    }
    throw new NotFoundException('Transaction not found');
  }

  async exportTransactions(tenantId: string, format?: string) {
    if (format && !['csv', 'json'].includes(format.toLowerCase())) {
      throw new BadRequestException('Unsupported format. Use csv or json.');
    }
    const { data } = await this.wm.listTransactions(tenantId, {
      limit: '10000',
    });
    if (format?.toLowerCase() === 'csv') {
      const headers = [
        'id',
        'type',
        'reference',
        'status',
        'clientName',
        'commodity',
        'quantity',
        'receiptNumber',
        'date',
      ];
      const rows = data.map((row: any) =>
        headers.map((h) => JSON.stringify(row[h] ?? '')).join(','),
      );
      return [headers.join(','), ...rows].join('\n');
    }
    return data;
  }
}
