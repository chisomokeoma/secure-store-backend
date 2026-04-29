import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { TradesService } from './trades.service';
import {
  CreateTradeDto,
  SettleTradeDto,
  TradeListingDto,
  TradeResponseDto,
  PaginatedTradeResponseDto,
} from './dto/trades.dto';

@ApiTags('Trades')
@Controller('trades')
export class TradesController {
  constructor(private readonly tradesService: TradesService) {}

  @Get()
  @ApiOperation({ summary: 'List all trades with filters' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiResponse({ status: 200, type: PaginatedTradeResponseDto })
  getTrades(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.tradesService.getTrades({
      status,
      page,
      limit,
      search,
    });
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new trade listing — locks the receipt with LIEN status',
  })
  @ApiResponse({ status: 201, type: TradeResponseDto })
  createTrade(@Body() body: CreateTradeDto) {
    return this.tradesService.createTrade(body);
  }

  @Post(':id/settle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Settle a trade — transfers receipt ownership to buyer, status returns to ACTIVE',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: TradeResponseDto })
  settleTrade(@Param('id') id: string, @Body() body: SettleTradeDto) {
    return this.tradesService.settleTrade(id, body.buyerId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a trade listing — returns receipt to ACTIVE for seller',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: TradeResponseDto })
  cancelTrade(@Param('id') id: string) {
    return this.tradesService.cancelTrade(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get specific trade detail' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: TradeListingDto })
  getTradeDetail(@Param('id') id: string) {
    return this.tradesService.getTradeDetail(id);
  }
}
