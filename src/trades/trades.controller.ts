import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TradesService } from './trades.service';
import {
  CreateTradeDto,
  SettleTradeDto,
  TradeListingDto,
  TradeResponseDto,
} from './dto/trades.dto';

@ApiTags('Trades')
@Controller('trades')
export class TradesController {
  constructor(private readonly tradesService: TradesService) {}

  @Get('listings')
  @ApiOperation({ summary: 'Get active trade listings' })
  @ApiResponse({ status: 200, type: [TradeListingDto] })
  getTradeListings() {
    return this.tradesService.getTradeListings();
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
