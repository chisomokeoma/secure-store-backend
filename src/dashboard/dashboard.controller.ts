import { Controller, Get, Query, Param, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import {
  DashboardSummaryDto,
  CommodityBreakdownDto,
  ActivityTrendDto,
  RecentActivityDto,
} from './dto/dashboard.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('Admin Dashboard')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Get high-level dashboard metrics' })
  @ApiResponse({ status: 200, type: DashboardSummaryDto })
  getSummary(@CurrentUser('tenantId') tenantId: string) {
    return this.dashboardService.getSummary(tenantId);
  }

  @Get('commodity-breakdown')
  @ApiOperation({ summary: 'Get stock breakdown by commodity' })
  @ApiResponse({ status: 200, type: [CommodityBreakdownDto] })
  getCommodityBreakdown(@CurrentUser('tenantId') tenantId: string) {
    return this.dashboardService.getCommodityBreakdown(tenantId);
  }

  @Get('activity-trend')
  @ApiOperation({ summary: 'Get deposit/withdrawal trends over time' })
  @ApiQuery({ name: 'range', enum: ['7d', '1m', '6m', '1y'], required: false })
  @ApiResponse({ status: 200, type: [ActivityTrendDto] })
  getActivityTrend(
    @CurrentUser('tenantId') tenantId: string,
    @Query('range') range: '7d' | '1m' | '6m' | '1y' = '6m',
  ) {
    return this.dashboardService.getActivityTrend(tenantId, range);
  }

  @Get('recent-activities')
  @ApiOperation({ summary: 'Get unified recent activity feed' })
  @ApiResponse({ status: 200, type: [RecentActivityDto] })
  getRecentActivities(@CurrentUser('tenantId') tenantId: string) {
    return this.dashboardService.getRecentActivities(tenantId);
  }

  @Get('clients/:id/summary')
  @ApiOperation({ summary: 'Get detailed summary for a specific client' })
  @ApiParam({ name: 'id' })
  getClientDrilldown(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.dashboardService.getClientDrilldown(tenantId, id);
  }

  @Get('commodities/:id/summary')
  @ApiOperation({ summary: 'Get detailed summary for a specific commodity' })
  @ApiParam({ name: 'id' })
  getCommodityDrilldown(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.dashboardService.getCommodityDrilldown(tenantId, id);
  }
}
