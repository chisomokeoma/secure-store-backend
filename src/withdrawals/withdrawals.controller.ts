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
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('Withdrawals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  @Get()
  @ApiOperation({ summary: 'List all withdrawal requests' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiResponse({ status: 200, type: PaginatedWithdrawalResponseDto })
  getWithdrawals(
    @CurrentUser('tenantId') tenantId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.withdrawalsService.getWithdrawals(tenantId, {
      status,
      page,
      limit,
      search,
    });
  }

  @Get('eligible-receipts')
  @ApiOperation({ summary: 'Get receipts eligible for withdrawal' })
  @ApiResponse({ status: 200, description: 'List of eligible receipts' })
  getEligibleReceipts(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.withdrawalsService.getEligibleReceipts(tenantId, userId);
  }

  @Get('receipts/:receiptId/prefill')
  @ApiOperation({ summary: 'Prefill withdrawal data for a receipt' })
  @ApiParam({ name: 'receiptId' })
  @ApiResponse({ status: 200, description: 'Prefill data' })
  getReceiptPrefill(
    @CurrentUser('tenantId') tenantId: string,
    @Param('receiptId') receiptId: string,
  ) {
    return this.withdrawalsService.getReceiptPrefill(tenantId, receiptId);
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
    summary: 'Confirm payment — moves PENDING_PAYMENT → PAID_PENDING_APPROVAL',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  confirmPayment(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.withdrawalsService.confirmPayment(tenantId, id);
  }

  @Post(':id/approve')
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

  @Get(':id')
  @ApiOperation({ summary: 'Get withdrawal details' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  getWithdrawalDetail(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.withdrawalsService.getWithdrawalDetail(tenantId, id);
  }
}
