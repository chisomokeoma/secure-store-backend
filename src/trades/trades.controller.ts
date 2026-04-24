import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TradesService } from './trades.service';
import { CreateTradeDto, TradeListingDto, TradeResponseDto } from './dto/trades.dto';

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
  @ApiOperation({ summary: 'Create a new trade listing' })
  @ApiResponse({ status: 201, type: TradeResponseDto })
  createTrade(@Body() body: CreateTradeDto) {
    return this.tradesService.createTrade(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get specific trade detail' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: TradeListingDto })
  getTradeDetail(@Param('id') id: string) {
    return { id, commodityName: 'Maize', quantity: 100, price: 500 };
  }
}
