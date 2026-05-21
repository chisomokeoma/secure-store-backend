import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CommoditiesService } from './commodities.service';
import { CommodityOverviewDto } from './dto/commodities.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('Commodities')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('commodities')
export class CommoditiesController {
  constructor(private readonly commoditiesService: CommoditiesService) {}

  @Get('mine')
  @ApiOperation({ summary: 'Get commodities owned by current user' })
  @ApiResponse({ status: 200, type: [CommodityOverviewDto] })
  getMyCommodities(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.commoditiesService.getMyCommodities(tenantId, userId);
  }

  @Get(':id/overview')
  @ApiOperation({ summary: 'Get overview metrics for a specific commodity' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: CommodityOverviewDto })
  getCommodityOverview(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.commoditiesService.getCommodityOverview(tenantId, id, userId);
  }

  @Get(':id/receipts')
  @ApiOperation({
    summary:
      "Caller's receipts for a commodity (client-scoped — never returns other clients' receipts).",
  })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiResponse({ status: 200, description: 'Paginated list of receipts' })
  getCommodityReceipts(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.commoditiesService.getCommodityReceipts(tenantId, id, userId, {
      page,
      limit,
      search,
    });
  }

  @Get(':id/export')
  @ApiOperation({ summary: 'Export commodity data' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'format', required: false })
  @ApiResponse({ status: 200, description: 'Exported file buffer' })
  exportCommodityData(
    @Param('id') id: string,
    @Query('format') format?: string,
  ) {
    return 'Export Stub';
  }
}
