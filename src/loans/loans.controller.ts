import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { LoansService } from './loans.service';
import {
  FinancierDto,
  PledgeableReceiptDto,
  CalculateLoanDto,
  CreateLoanDto,
  LoanCalculationResponseDto,
  LoanResponseDto,
} from './dto/loans.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('Loans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Get('financiers')
  @ApiOperation({ summary: 'Get list of available financiers' })
  @ApiResponse({ status: 200, type: [FinancierDto] })
  getFinanciers(@CurrentUser('tenantId') tenantId: string) {
    return this.loansService.getFinanciers(tenantId);
  }

  @Get('pledgeable-receipts')
  @ApiOperation({ summary: 'Get receipts available to be pledged for a loan' })
  @ApiQuery({ name: 'commodity', required: false })
  @ApiResponse({ status: 200, type: [PledgeableReceiptDto] })
  getPledgeableReceipts(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Query('commodity') commodity?: string,
  ) {
    return this.loansService.getPledgeableReceipts(tenantId, userId, commodity);
  }

  @Post('calculate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Calculate loan terms' })
  @ApiResponse({ status: 200, type: LoanCalculationResponseDto })
  calculateLoan(
    @CurrentUser('tenantId') tenantId: string,
    @Body() body: CalculateLoanDto,
  ) {
    return this.loansService.calculateLoan(tenantId, body);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new loan application — pledges the collateral receipt',
  })
  @ApiResponse({ status: 201, type: LoanResponseDto })
  createLoan(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Body() body: CreateLoanDto,
  ) {
    return this.loansService.createLoan(tenantId, body, userId);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve loan — moves PENDING → ACTIVE' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: LoanResponseDto })
  approveLoan(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.loansService.approveLoan(tenantId, id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject loan — returns pledged receipt to ACTIVE',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: LoanResponseDto })
  rejectLoan(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.loansService.rejectLoan(tenantId, id);
  }

  @Post(':id/repay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark loan as repaid — releases the pledged receipt',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: LoanResponseDto })
  repayLoan(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.loansService.repayLoan(tenantId, id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details of a specific loan' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: LoanResponseDto })
  getLoanDetail(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.loansService.getLoanDetail(tenantId, id);
  }
}
