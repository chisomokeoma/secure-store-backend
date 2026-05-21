import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { MeService } from './me.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('Me (User Settings)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get()
  @ApiOperation({ summary: 'Get current user profile' })
  getProfile(@CurrentUser('id') userId: string) {
    return this.meService.getProfile(userId);
  }

  @Get('dashboard')
  @ApiOperation({
    summary:
      "Current user's dashboard summary (cards + per-unit/per-commodity totals + recent activity), scoped to their own data",
  })
  getDashboard(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.meService.getDashboard(tenantId, userId);
  }

  @Get('activity-trend')
  @ApiOperation({
    summary: "Time-series of the caller's activity (powers the 1Y/6M/3M/1M chart)",
  })
  @ApiQuery({
    name: 'range',
    required: false,
    enum: ['7d', '1m', '3m', '6m', '1y'],
  })
  getActivityTrend(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Query('range') range?: string,
  ) {
    const r = (range || '1y') as '7d' | '1m' | '3m' | '6m' | '1y';
    return this.meService.getActivityTrend(tenantId, userId, r);
  }

  @Get('transactions/stats')
  @ApiOperation({
    summary: "Stats for the caller's transaction report (totals + counts)",
  })
  getTransactionStats(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.meService.getTransactionStats(tenantId, userId);
  }

  @Get('transactions')
  @ApiOperation({
    summary:
      "Caller's unified transaction history (?type=DEPOSIT|WITHDRAWAL|LOAN|PLEDGE|TRADE, ?from, ?to, ?search, ?page, ?limit)",
  })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listTransactions(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.meService.listTransactions(tenantId, userId, {
      type,
      from,
      to,
      search,
      page,
      limit,
    });
  }

  @Get('transactions/:type/:id')
  @ApiOperation({
    summary:
      "Caller's transaction detail (record + receipt lineage + ledger trail)",
  })
  @ApiParam({ name: 'type' })
  @ApiParam({ name: 'id' })
  getTransactionDetail(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('type') type: string,
    @Param('id') id: string,
  ) {
    return this.meService.getTransactionDetail(tenantId, userId, type, id);
  }

  @Get('inventory/warehouses')
  @ApiOperation({
    summary:
      "Step 1 of the deposit/withdraw selection flow: warehouses where the caller has eligible inventory",
  })
  getInventoryWarehouses(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.meService.getInventoryWarehouses(tenantId, userId);
  }

  @Get('inventory/warehouses/:warehouseId/commodities')
  @ApiOperation({
    summary:
      'Step 2: commodities (with eligible quantity/unit) the caller holds in the chosen warehouse',
  })
  @ApiParam({ name: 'warehouseId' })
  getInventoryCommodities(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('warehouseId') warehouseId: string,
  ) {
    return this.meService.getInventoryCommodities(
      tenantId,
      userId,
      warehouseId,
    );
  }

  @Patch()
  @ApiOperation({ summary: 'Update current user profile fields' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        middleName: { type: 'string' },
        phoneNumber: { type: 'string' },
        contactEmail: { type: 'string' },
        profilePhotoUrl: { type: 'string' },
      },
    },
  })
  updateProfile(@CurrentUser('id') userId: string, @Body() body: any) {
    return this.meService.updateProfile(userId, body);
  }

  @Post('change-password')
  @ApiOperation({ summary: 'User-initiated password change' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['currentPassword', 'newPassword'],
      properties: {
        currentPassword: { type: 'string' },
        newPassword: { type: 'string', minLength: 8 },
      },
    },
  })
  changePassword(
    @CurrentUser('id') userId: string,
    @Body('currentPassword') currentPassword: string,
    @Body('newPassword') newPassword: string,
  ) {
    return this.meService.changePassword(userId, currentPassword, newPassword);
  }

  @Patch('notification-prefs')
  @ApiOperation({ summary: 'Update notification preferences' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email: { type: 'boolean' },
        sms: { type: 'boolean' },
        inApp: { type: 'boolean' },
      },
    },
  })
  updateNotificationPrefs(
    @CurrentUser('id') userId: string,
    @Body() body: any,
  ) {
    return this.meService.updateNotificationPrefs(userId, body);
  }
}
