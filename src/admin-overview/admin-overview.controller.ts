import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminOverviewService } from './admin-overview.service';

/**
 * Global-Admin platform-wide read surface. Every route GLOBAL_ADMIN only.
 * Matches the FE's adminGlobalRoutes contract in
 * src/api/endpoints/admin-global.ts:
 *   GET /admin/overview
 *   GET /admin/overview/trend?days=
 *   GET /admin/overview/distribution
 *   GET /admin/network/warehouses
 *   GET /admin/activity
 */
@ApiTags('Global Admin — Overview & Activity')
@ApiBearerAuth()
@Roles('GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin')
export class AdminOverviewController {
  constructor(private readonly service: AdminOverviewService) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'Platform-wide KPI aggregation for the GA dashboard. Six blocks: tenants, financiers, warehouses, people (managers/clients), collateral (totalLienedValue), receipts. Counts are DISTINCT platform-wide (people.clients is client users, not attachments).',
  })
  overview() {
    return this.service.getOverview();
  }

  @Get('overview/trend')
  @ApiOperation({
    summary:
      'Daily activity time-series on ONE shared axis: receiptsIssued, pledgesCreated, liensPlaced. Server-side zero-filled so the FE renders a continuous line even on quiet days. `days` limited to 7, 30, or 90.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    enum: [7, 30, 90],
    example: 30,
  })
  trend(@Query('days') days?: string) {
    return this.service.getTrend(days ? parseInt(days, 10) : 30);
  }

  @Get('overview/distribution')
  @ApiOperation({
    summary:
      'Per-tenant stored + liened value. Powers the "Stored value by institution" horizontal ranking chart. FE sorts by storedValue and renders top 6.',
  })
  distribution() {
    return this.service.getDistribution();
  }

  @Get('network/warehouses')
  @ApiOperation({
    summary:
      "Cross-tenant warehouse list. Deliberately separate from the tenant-scoped /admin/warehouses (which stays as-is). Search matches name / code / location / tenant name. Each row carries tenantId + tenantName + stored/liened values.",
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  networkWarehouses(
    @Query('search') search?: string,
    @Query('tenantId') tenantId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listNetworkWarehouses({
      search,
      tenantId,
      page,
      limit,
    });
  }

  @Get('activity')
  @ApiOperation({
    summary:
      "Platform-wide audit stream from the ActivityLog table. `type` (dotted event key) → ActivityLog.action; `summary` → ActivityLog.description (must be a complete sentence); `severity` → metadata.severity (INFO for onboardings/approvals, WARNING for suspensions/rejections/offboards, CRITICAL for security events and lien.force_released).",
  })
  @ApiQuery({
    name: 'severity',
    required: false,
    enum: ['INFO', 'WARNING', 'CRITICAL'],
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  activity(
    @Query('severity') severity?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listActivity({ severity, page, limit });
  }
}
