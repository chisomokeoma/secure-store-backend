import { Controller, Get, Query, UseGuards, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AdminTransactionsService } from '../services/admin-transactions.service';
import { JwtAuthGuard } from '../../auth/jwt.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';

@ApiTags('Admin Transactions (Reports)')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/transactions')
export class AdminTransactionsController {
  constructor(private readonly service: AdminTransactionsService) {}

  @Get()
  @ApiOperation({ summary: 'List all tenant transactions with filters' })
  @ApiQuery({ name: 'type', required: false, enum: ['WITHDRAWAL', 'LOAN', 'TRADE'] })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'clientId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date string e.g. 2025-01-01' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date string e.g. 2025-12-31' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getTransactions(
    @CurrentUser('tenantId') tenantId: string,
    @Query('type') type?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('clientId') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getTransactions(tenantId, { type, warehouseId, clientId, from, to, page, limit });
  }

  /**
   * CSV export: always uses @Res() so NestJS hands full control to Express.
   * JSON export: same pattern — consistent response handling.
   */
  @Get('export')
  @ApiOperation({ summary: 'Export transactions as CSV or JSON' })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'json'], description: 'Default: json' })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  async exportTransactions(
    @CurrentUser('tenantId') tenantId: string,
    @Res() res: any,
    @Query('format') format: string = 'json',
    @Query('type') type?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const data = await this.service.exportTransactions(tenantId, { format, type, warehouseId, from, to });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
      return res.send(data);
    }

    return res.json({ data });
  }
}
