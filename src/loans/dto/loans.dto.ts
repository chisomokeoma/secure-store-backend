import { IsString, IsNumber, IsOptional, IsPositive } from 'class-validator';

export class CalculateLoanDto {
  @IsString()
  receiptId!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsString()
  financierId!: string;
}

export class CreateLoanDto extends CalculateLoanDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

export class FinancierDto {
  id!: string;
  name!: string;
  interestRate!: number;
  minTenure!: number;
  maxTenure!: number;
  approvalTime!: string;
}

export class PledgeableReceiptDto {
  id!: string;
  receiptNumber!: string;
  availableQuantity!: number;
  commodity!: string;
}

export class LoanCalculationResponseDto {
  totalInterest!: number;
  monthlyPayment!: number;
  tenureMonths!: number;
  interestRate!: number;
}

export class LoanResponseDto {
  id!: string;
  reference!: string;
  status!: string;
  amount!: number;
  totalInterest!: number;
  monthlyPayment!: number;
  tenureMonths!: number;
  pledgedReceipt!: string;
}
