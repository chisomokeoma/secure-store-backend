import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AdminWithdrawalService } from '../services/admin-withdrawal.service';
import { JwtAuthGuard } from '../../auth/jwt.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';

@ApiTags('Admin Withdrawals')
@ApiBearerAuth()
@Roles('WAREHOUSE_MANAGER', 'TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/withdrawals')
export class AdminWithdrawalController {
  constructor(
    private readonly adminWithdrawalService: AdminWithdrawalService,
  ) {}

  @Get('pending')
  @ApiOperation({ summary: 'List all withdrawals awaiting approval' })
  getPendingWithdrawals(@CurrentUser('tenantId') tenantId: string) {
    return this.adminWithdrawalService.getPendingWithdrawals(tenantId);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a withdrawal request' })
  approveWithdrawal(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.adminWithdrawalService.approveWithdrawal(tenantId, id, userId);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a withdrawal request' })
  rejectWithdrawal(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('reason') reason: string,
  ) {
    return this.adminWithdrawalService.rejectWithdrawal(
      tenantId,
      id,
      userId,
      reason,
    );
  }
}
