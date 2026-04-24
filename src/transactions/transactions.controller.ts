import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiParam } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { TransactionDto } from './dto/transactions.dto';

@ApiTags('Transactions & Reports')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  @ApiOperation({ summary: 'Get transaction history' })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiResponse({ status: 200, type: [TransactionDto] })
  getTransactions(@Query('type') type?: string) {
    return this.transactionsService.getTransactions(type);
  }

  @Get('export')
  @ApiOperation({ summary: 'Export transaction reports' })
  @ApiQuery({ name: 'format', required: false, description: 'csv or pdf' })
  @ApiResponse({ status: 200, description: 'Export Buffer' })
  exportTransactions(@Query('format') format?: string) {
    return 'Export Stub';
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get transaction details' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: TransactionDto })
  getTransactionDetail(@Param('id') id: string) {
    return { id, type: 'WITHDRAWAL_FEE', amount: 150, date: new Date() };
  }
}
