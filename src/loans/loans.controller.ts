import { Controller, Get, Post, Param, Query, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiParam } from '@nestjs/swagger';
import { LoansService } from './loans.service';
import { FinancierDto, PledgeableReceiptDto, CalculateLoanDto, CreateLoanDto, LoanCalculationResponseDto, LoanResponseDto } from './dto/loans.dto';

@ApiTags('Loans')
@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Get('financiers')
  @ApiOperation({ summary: 'Get list of available financiers' })
  @ApiResponse({ status: 200, type: [FinancierDto] })
  getFinanciers() {
    return this.loansService.getFinanciers();
  }

  @Get('pledgeable-receipts')
  @ApiOperation({ summary: 'Get receipts available to be pledged for a loan' })
  @ApiQuery({ name: 'commodity', required: false })
  @ApiResponse({ status: 200, type: [PledgeableReceiptDto] })
  getPledgeableReceipts(@Query('commodity') commodity?: string) {
    return this.loansService.getPledgeableReceipts(commodity);
  }

  @Post('calculate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Calculate loan terms' })
  @ApiResponse({ status: 200, type: LoanCalculationResponseDto })
  calculateLoan(@Body() body: CalculateLoanDto) {
    return this.loansService.calculateLoan(body);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new loan application' })
  @ApiResponse({ status: 201, type: LoanResponseDto })
  createLoan(@Body() body: CreateLoanDto) {
    return this.loansService.createLoan(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details of a specific loan' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: LoanResponseDto })
  getLoanDetail(@Param('id') id: string) {
    return { id, status: 'PENDING', amount: 5000 };
  }
}
