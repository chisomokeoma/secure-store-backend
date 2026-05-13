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

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  // -- General Dashboard Endpoints (accessible to all authenticated users) --

  @Get('summary')
  @Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Get high-level dashboard metrics (Tenant Admin)' })
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

  // -- Admin-only Drill-down Endpoints --

  @Get('clients/:id/summary')
  @Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
  @UseGuards(RolesGuard)
  @ApiOperation({
    summary: 'Get detailed summary for a specific client (Admin only)',
  })
  @ApiParam({ name: 'id' })
  getClientDrilldown(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.dashboardService.getClientDrilldown(tenantId, id);
  }

  @Get('commodities/:id/summary')
  @Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
  @UseGuards(RolesGuard)
  @ApiOperation({
    summary: 'Get detailed summary for a specific commodity (Admin only)',
  })
  @ApiParam({ name: 'id' })
  getCommodityDrilldown(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.dashboardService.getCommodityDrilldown(tenantId, id);
  }
}
