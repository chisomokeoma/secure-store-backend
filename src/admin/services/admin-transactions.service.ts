import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WarehouseManagerService } from '../../warehouse-manager/warehouse-manager.service';

/**
 * Tenant-admin transaction reports. Delegates to the single canonical
 * collector (`WarehouseManagerService.listTransactions`) so admins and
 * managers share one definition of "a transaction" — no parallel
 * implementations, no drift.
 *
 * Admins (whScope = null) get the full tenant view; managers calling the WM
 * endpoint get their warehouse-scoped view. Same data shape on both.
 */
@Injectable()
export class AdminTransactionsService {
  constructor(
    private prisma: PrismaService,
    private wm: WarehouseManagerService,
  ) {}

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
    return this.wm.listTransactions(tenantId, {
      type: query.type,
      clientId: query.clientId,
      warehouseId: query.warehouseId,
      fromDate: query.from,
      toDate: query.to,
      page: query.page,
      limit: query.limit,
    });
  }

  async exportTransactions(
    tenantId: string,
    query: {
      format?: string;
      type?: string;
      warehouseId?: string;
      from?: string;
      to?: string;
    },
  ) {
    const { data } = await this.getTransactions(tenantId, {
      ...query,
      page: '1',
      limit: '10000',
    });

    if (query.format === 'csv') {
      const headers = [
        'id',
        'type',
        'reference',
        'status',
        'clientName',
        'commodity',
        'quantity',
        'receiptNumber',
        'warehouseId',
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
