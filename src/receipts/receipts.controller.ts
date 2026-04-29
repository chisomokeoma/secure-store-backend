import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiParam } from '@nestjs/swagger';
import { ReceiptsService } from './receipts.service';
import { ReceiptDetailsDto, ReceiptStatsDto, PaginatedReceiptResponseDto } from './dto/receipts.dto';

@ApiTags('Warehouse Receipts')
@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Get()
  @ApiOperation({ summary: 'List all warehouse receipts' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiResponse({ status: 200, type: PaginatedReceiptResponseDto })
  getReceipts(@Query('status') status?: string, @Query('page') page?: string, @Query('limit') limit?: string, @Query('search') search?: string) {
    return this.receiptsService.getReceipts({ status, page, limit, search });
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get aggregate statistics for receipts' })
  @ApiResponse({ status: 200, type: ReceiptStatsDto })
  getReceiptStats() {
    return this.receiptsService.getReceiptStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details of a specific receipt' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: ReceiptDetailsDto })
  getReceiptDetail(@Param('id') id: string) {
    return this.receiptsService.getReceiptDetail(id);
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'Stream PDF version of receipt' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'PDF Buffer' })
  streamPdf(@Param('id') id: string) {
    return 'PDF Buffer Stub';
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download receipt as PDF' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'File Download' })
  downloadDepositReceipt(@Param('id') id: string) {
    return 'File Download Stub';
  }
}
