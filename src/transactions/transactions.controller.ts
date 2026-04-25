import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { TransactionDto } from './dto/transactions.dto';

@ApiTags('Transactions & Reports')
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
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.transactionsService.getTransactions({
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
  exportTransactions(@Query('format') format?: string) {
    return this.transactionsService.exportTransactions(format);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get transaction details (any type)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: TransactionDto })
  getTransactionDetail(@Param('id') id: string) {
    return this.transactionsService.getTransactionDetail(id);
  }
}
