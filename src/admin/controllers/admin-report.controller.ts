import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AdminReportService } from '../services/admin-report.service';
import { JwtAuthGuard } from '../../auth/jwt.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';

@ApiTags('Admin Reports')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/reports')
export class AdminReportController {
  constructor(private readonly adminReportService: AdminReportService) {}

  @Get('stock-summary')
  @ApiOperation({ summary: 'Get total stock summary by commodity and warehouse' })
  getStockSummary(@CurrentUser('tenantId') tenantId: string) {
    return this.adminReportService.getStockSummary(tenantId);
  }

  @Get('aging-analysis')
  @ApiOperation({ summary: 'Get aging analysis of current stock' })
  getAgingAnalysis(@CurrentUser('tenantId') tenantId: string) {
    return this.adminReportService.getAgingAnalysis(tenantId);
  }
}
