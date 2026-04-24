import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { DashboardSummaryDto, CommodityBreakdownDto, ActivityTrendDto, SystemStatusDto } from './dto/dashboard.dto';

@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Get high-level dashboard metrics' })
  @ApiResponse({ status: 200, type: DashboardSummaryDto })
  getSummary() {
    return this.dashboardService.getSummary();
  }

  @Get('commodity-breakdown')
  @ApiOperation({ summary: 'Get percentage breakdown of stored commodities' })
  @ApiQuery({ name: 'period', required: false })
  @ApiResponse({ status: 200, type: [CommodityBreakdownDto] })
  getCommodityBreakdown(@Query('period') period?: string) {
    return this.dashboardService.getCommodityBreakdown();
  }

  @Get('activity-trend')
  @ApiOperation({ summary: 'Get system activity over time' })
  @ApiQuery({ name: 'range', required: false })
  @ApiResponse({ status: 200, type: [ActivityTrendDto] })
  getActivityTrend(@Query('range') range?: string) {
    return this.dashboardService.getActivityTrend();
  }

  @Get('system-status')
  @ApiOperation({ summary: 'Get current system operational status' })
  @ApiResponse({ status: 200, type: SystemStatusDto })
  getSystemStatus() {
    return this.dashboardService.getSystemStatus();
  }
}
