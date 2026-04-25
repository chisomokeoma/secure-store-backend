import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { WithdrawalsService } from './withdrawals.service';
import {
  CalculateWithdrawalDto,
  CreateWithdrawalDto,
  WithdrawalCalculationResponseDto,
  WithdrawalResponseDto,
} from './dto/withdrawals.dto';

@ApiTags('Withdrawals')
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  @Get('eligible-receipts')
  @ApiOperation({ summary: 'Get receipts eligible for withdrawal' })
  @ApiResponse({ status: 200, description: 'List of eligible receipts' })
  getEligibleReceipts() {
    return this.withdrawalsService.getEligibleReceipts();
  }

  @Get('receipts/:receiptId/prefill')
  @ApiOperation({ summary: 'Prefill withdrawal data for a receipt' })
  @ApiParam({ name: 'receiptId' })
  @ApiResponse({ status: 200, description: 'Prefill data' })
  getReceiptPrefill(@Param('receiptId') receiptId: string) {
    return this.withdrawalsService.getReceiptPrefill(receiptId);
  }

  @Post('calculate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Calculate fees for a proposed withdrawal' })
  @ApiResponse({ status: 200, type: WithdrawalCalculationResponseDto })
  calculateWithdrawal(@Body() body: CalculateWithdrawalDto) {
    return this.withdrawalsService.calculateWithdrawal(body);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new withdrawal request' })
  @ApiResponse({ status: 201, type: WithdrawalResponseDto })
  createWithdrawalRequest(@Body() body: CreateWithdrawalDto) {
    return this.withdrawalsService.createWithdrawalRequest(body);
  }

  @Post(':id/confirm-payment')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm payment — moves PENDING_PAYMENT → PAID_PENDING_APPROVAL',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  confirmPayment(@Param('id') id: string) {
    return this.withdrawalsService.confirmPayment(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve withdrawal — moves PAID_PENDING_APPROVAL → APPROVED',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  approveWithdrawal(@Param('id') id: string) {
    return this.withdrawalsService.approveWithdrawal(id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject withdrawal' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  rejectWithdrawal(@Param('id') id: string) {
    return this.withdrawalsService.rejectWithdrawal(id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Complete withdrawal — cancels source receipt, issues child receipt for remainder',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Completion details' })
  completeWithdrawal(@Param('id') id: string) {
    return this.withdrawalsService.completeWithdrawal(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get withdrawal details' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  getWithdrawalDetail(@Param('id') id: string) {
    return this.withdrawalsService.getWithdrawalDetail(id);
  }
}
