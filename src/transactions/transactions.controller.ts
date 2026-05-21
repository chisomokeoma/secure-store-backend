import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { TransactionDto } from './dto/transactions.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';

/**
 * Legacy /transactions surface. The canonical sources are now
 * `/admin/transactions` (tenant-admin) and `/manager/transactions` (WM).
 * Kept for backward-compat and gated to TENANT_ADMIN/GLOBAL_ADMIN; properly
 * tenant-scoped (the original was an unscoped data leak).
 */
@ApiTags('Transactions & Reports (legacy)')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Get unified transaction history (withdrawals, loans, trades) sorted newest-first',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'WITHDRAWAL | LOAN | TRADE',
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, type: [TransactionDto] })
  getTransactions(
    @CurrentUser('tenantId') tenantId: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.transactionsService.getTransactions(tenantId, {
      type,
      from,
      to,
      page,
      limit,
    });
  }

  @Get('export')
  @ApiOperation({ summary: 'Export transaction list (csv or json)' })
  @ApiQuery({ name: 'format', required: false, description: 'csv | json' })
  @ApiResponse({ status: 200, description: 'CSV string or JSON list' })
  exportTransactions(
    @CurrentUser('tenantId') tenantId: string,
    @Query('format') format?: string,
  ) {
    return this.transactionsService.exportTransactions(tenantId, format);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get transaction details (any type)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: TransactionDto })
  getTransactionDetail(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.transactionsService.getTransactionDetail(tenantId, id);
  }
}
