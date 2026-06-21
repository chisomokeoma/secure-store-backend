import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { AdminReceiptService } from '../services/admin-receipt.service';
import { EditDepositDto } from '../../warehouse-manager/dto/wm.dto';
import { JwtAuthGuard } from '../../auth/jwt.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';

@ApiTags('Admin Receipts')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN', 'WAREHOUSE_MANAGER')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/receipts')
export class AdminReceiptController {
  constructor(private readonly adminReceiptService: AdminReceiptService) {}

  @Get()
  @ApiOperation({ summary: 'List all receipts with filters' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({
    name: 'approvalStatus',
    required: false,
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
  })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'clientId', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getReceipts(
    @CurrentUser('tenantId') tenantId: string,
    @Query('status') status?: string,
    @Query('approvalStatus') approvalStatus?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('clientId') clientId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminReceiptService.getReceipts(tenantId, {
      status,
      approvalStatus,
      warehouseId,
      clientId,
      page,
      limit,
    });
  }

  @Get('stats')
  @ApiOperation({
    summary:
      'Receipt-management header counts (total, active, approved, pending/rejected). SPLIT internal nodes are excluded from every count.',
  })
  getReceiptStats(@CurrentUser('tenantId') tenantId: string) {
    return this.adminReceiptService.getReceiptStats(tenantId);
  }

  @Get('pending-approvals')
  @ApiOperation({ summary: 'List receipts awaiting admin approval' })
  getPendingApprovals(@CurrentUser('tenantId') tenantId: string) {
    return this.adminReceiptService.getPendingApprovals(tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single receipt by ID' })
  getReceiptById(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.adminReceiptService.getReceiptById(tenantId, id);
  }

  @Patch(':id/deposit-edit')
  @ApiOperation({
    summary:
      "Edit a deposit as tenant admin. Allowed states: PENDING_APPROVAL (all fields editable) and ACTIVE (only grade / measurements / dateOfDeposit / editReason — structural fields are locked once the receipt is live). HELD_* states require the in-flight transaction to be released first. SPLIT and terminal states are refused. If measurements are supplied without an explicit grade, the deposit is re-scored. Every edit writes an ActivityLog row + notifies the client and the WM who originally filed it.",
  })
  editDepositAsAdmin(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: EditDepositDto,
  ) {
    return this.adminReceiptService.editDepositAsAdmin(tenantId, userId, id, dto);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a receipt' })
  @ApiBody({
    schema: { type: 'object', properties: { notes: { type: 'string' } } },
  })
  approveReceipt(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: { notes?: string },
  ) {
    return this.adminReceiptService.approveReceipt(tenantId, id, userId, body);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a receipt with a reason' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['rejectionReason'],
      properties: { rejectionReason: { type: 'string' } },
    },
  })
  rejectReceipt(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('rejectionReason') rejectionReason: string,
  ) {
    return this.adminReceiptService.rejectReceipt(
      tenantId,
      id,
      userId,
      rejectionReason,
    );
  }
}
