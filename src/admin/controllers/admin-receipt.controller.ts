import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AdminReceiptService } from '../services/admin-receipt.service';
import { JwtAuthGuard } from '../../auth/jwt.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';

@ApiTags('Admin Receipts')
@ApiBearerAuth()
@Roles('WAREHOUSE_MANAGER', 'TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/receipts')
export class AdminReceiptController {
  constructor(private readonly adminReceiptService: AdminReceiptService) {}

  @Get('pending')
  @ApiOperation({ summary: 'List all receipts awaiting approval' })
  getPendingApprovals(@CurrentUser('tenantId') tenantId: string) {
    return this.adminReceiptService.getPendingApprovals(tenantId);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a warehouse receipt' })
  approveReceipt(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: { gradingScores?: any; finalGrade?: string },
  ) {
    return this.adminReceiptService.approveReceipt(tenantId, id, userId, body);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a warehouse receipt' })
  rejectReceipt(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('reason') reason: string,
  ) {
    return this.adminReceiptService.rejectReceipt(tenantId, id, userId, reason);
  }
}
