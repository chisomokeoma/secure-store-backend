import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiParam } from '@nestjs/swagger';
import { CommoditiesService } from './commodities.service';
import { CommodityOverviewDto } from './dto/commodities.dto';

@ApiTags('Commodities')
@Controller('commodities')
export class CommoditiesController {
  constructor(private readonly commoditiesService: CommoditiesService) {}

  @Get('mine')
  @ApiOperation({ summary: 'Get commodities owned by current user' })
  @ApiResponse({ status: 200, type: [CommodityOverviewDto] })
  getMyCommodities() {
    return this.commoditiesService.getMyCommodities();
  }

  @Get(':id/overview')
  @ApiOperation({ summary: 'Get overview metrics for a specific commodity' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: CommodityOverviewDto })
  getCommodityOverview(@Param('id') id: string) {
    return this.commoditiesService.getCommodityOverview(id);
  }

  @Get(':id/receipts')
  @ApiOperation({ summary: 'Get receipts linked to a commodity' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'view', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiResponse({ status: 200, description: 'Paginated list of receipts' })
  getCommodityReceipts(@Param('id') id: string, @Query('view') view?: string, @Query('page') page?: string, @Query('search') search?: string) {
    return this.commoditiesService.getCommodityReceipts(id);
  }

  @Get(':id/export')
  @ApiOperation({ summary: 'Export commodity data' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'format', required: false })
  @ApiResponse({ status: 200, description: 'Exported file buffer' })
  exportCommodityData(@Param('id') id: string, @Query('format') format?: string) {
    return 'Export Stub';
  }
}
