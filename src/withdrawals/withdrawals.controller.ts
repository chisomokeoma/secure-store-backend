import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { WithdrawalsService } from './withdrawals.service';
import {
  CalculateWithdrawalDto,
  CreateWithdrawalDto,
  WithdrawalCalculationResponseDto,
  WithdrawalResponseDto,
  PaginatedWithdrawalResponseDto,
} from './dto/withdrawals.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ClientScopeId } from '../common/decorators/client-scope-id.decorator';

@ApiTags('Withdrawals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  @Get()
  @ApiOperation({ summary: 'List withdrawal requests (auto-scoped to caller if CLIENT)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiResponse({ status: 200, type: PaginatedWithdrawalResponseDto })
  getWithdrawals(
    @CurrentUser('tenantId') tenantId: string,
    @ClientScopeId() forClientId: string | undefined,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.withdrawalsService.getWithdrawals(
      tenantId,
      { status, page, limit, search },
      forClientId,
    );
  }

  @Get('eligible-receipts')
  @ApiOperation({
    summary:
      "Caller's receipts eligible for withdrawal (filter by ?warehouseId= and ?commodityId= for the 3-step selection flow)",
  })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'commodityId', required: false })
  @ApiResponse({ status: 200, description: 'List of eligible receipts' })
  getEligibleReceipts(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('commodityId') commodityId?: string,
  ) {
    return this.withdrawalsService.getEligibleReceipts(
      tenantId,
      userId,
      warehouseId ? [warehouseId] : undefined,
      commodityId,
    );
  }

  @Get('receipts/:receiptId/prefill')
  @ApiOperation({ summary: 'Prefill withdrawal data for a receipt' })
  @ApiParam({ name: 'receiptId' })
  @ApiResponse({ status: 200, description: 'Prefill data' })
  getReceiptPrefill(
    @CurrentUser('tenantId') tenantId: string,
    @ClientScopeId() forClientId: string | undefined,
    @Param('receiptId') receiptId: string,
  ) {
    return this.withdrawalsService.getReceiptPrefill(
      tenantId,
      receiptId,
      forClientId,
    );
  }

  @Post('calculate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Calculate fees for a proposed withdrawal' })
  @ApiResponse({ status: 200, type: WithdrawalCalculationResponseDto })
  calculateWithdrawal(
    @CurrentUser('tenantId') tenantId: string,
    @Body() body: CalculateWithdrawalDto,
  ) {
    return this.withdrawalsService.calculateWithdrawal(tenantId, body);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new withdrawal request' })
  @ApiResponse({ status: 201, type: WithdrawalResponseDto })
  createWithdrawalRequest(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Body() body: CreateWithdrawalDto,
  ) {
    return this.withdrawalsService.createWithdrawalRequest(
      tenantId,
      body,
      userId,
    );
  }

  @Post(':id/confirm-payment')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Confirm payment — moves PENDING_PAYMENT → PAID_PENDING_APPROVAL. Callable by the withdrawal's owning client (self-attestation: 'I made the transfer') OR by a tenant admin (e.g. cash payment confirmed at the desk). The admin's `approve` step is the actual verification.",
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  confirmPayment(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('roles') roles: string[],
    @Param('id') id: string,
  ) {
    return this.withdrawalsService.confirmPayment(
      tenantId,
      id,
      userId,
      roles ?? [],
    );
  }

  @Post(':id/approve')
  @Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve withdrawal — moves PAID_PENDING_APPROVAL → APPROVED',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  approveWithdrawal(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.withdrawalsService.approveWithdrawal(tenantId, id);
  }

  @Post(':id/reject')
  @Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject withdrawal' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  rejectWithdrawal(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.withdrawalsService.rejectWithdrawal(tenantId, id);
  }

  @Post(':id/complete')
  @Roles('WAREHOUSE_MANAGER', 'TENANT_ADMIN', 'GLOBAL_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Complete withdrawal — cancels source receipt, issues child receipt for remainder',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Completion details' })
  completeWithdrawal(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.withdrawalsService.completeWithdrawal(tenantId, id);
  }

  @Get(':id/fee-quote')
  @ApiOperation({
    summary:
      "What the storage fee would be RIGHT NOW if this withdrawal were dispatched. Shows the row's provisional fee, the live projection, the delta, and the resolved policy.",
  })
  @ApiParam({ name: 'id' })
  getFeeQuote(
    @CurrentUser('tenantId') tenantId: string,
    @ClientScopeId() forClientId: string | undefined,
    @Param('id') id: string,
  ) {
    return this.withdrawalsService.getFeeQuote(tenantId, id, forClientId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get withdrawal details (own only if CLIENT)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  getWithdrawalDetail(
    @CurrentUser('tenantId') tenantId: string,
    @ClientScopeId() forClientId: string | undefined,
    @Param('id') id: string,
  ) {
    return this.withdrawalsService.getWithdrawalDetail(
      tenantId,
      id,
      forClientId,
    );
  }
}
