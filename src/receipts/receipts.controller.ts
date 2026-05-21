import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ReceiptsService } from './receipts.service';
import {
  ReceiptDetailsDto,
  ReceiptStatsDto,
  PaginatedReceiptResponseDto,
} from './dto/receipts.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ClientScopeId } from '../common/decorators/client-scope-id.decorator';

@ApiTags('Warehouse Receipts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Get()
  @ApiOperation({
    summary:
      "List receipts (auto-scoped to the caller if they're a CLIENT). The `status` query drives the four UI tabs: ALL · ACTIVE · LIENED · CANCELLED. SPLIT internal nodes are excluded everywhere. Each row carries `group` (the bucket), the raw `status` + `approvalStatus`, and — for liened rows — the `request` object describing the withdrawal/loan/trade holding the receipt.",
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description:
      'ALL | ACTIVE | LIENED (alias PLEDGE) | CANCELLED, or a raw ReceiptStatus value',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiResponse({ status: 200, type: PaginatedReceiptResponseDto })
  getReceipts(
    @CurrentUser('tenantId') tenantId: string,
    @ClientScopeId() forClientId: string | undefined,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.receiptsService.getReceipts(
      tenantId,
      { status, page, limit, search },
      forClientId,
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'Aggregate receipt stats (auto-scoped if CLIENT)' })
  @ApiResponse({ status: 200, type: ReceiptStatsDto })
  getReceiptStats(
    @CurrentUser('tenantId') tenantId: string,
    @ClientScopeId() forClientId: string | undefined,
  ) {
    return this.receiptsService.getReceiptStats(tenantId, forClientId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get receipt details (own only if CLIENT)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: ReceiptDetailsDto })
  getReceiptDetail(
    @CurrentUser('tenantId') tenantId: string,
    @ClientScopeId() forClientId: string | undefined,
    @Param('id') id: string,
  ) {
    return this.receiptsService.getReceiptDetail(tenantId, id, forClientId);
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
