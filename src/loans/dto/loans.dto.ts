import { IsString, IsNumber, IsOptional } from 'class-validator';

export class CalculateLoanDto {
  @IsString()
  receiptId!: string;

  @IsNumber()
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
}

export class PledgeableReceiptDto {
  id!: string;
  receiptNumber!: string;
  availableQuantity!: number;
}

export class LoanCalculationResponseDto {
  totalInterest!: number;
  monthlyPayment!: number;
}

export class LoanResponseDto {
  id!: string;
  status!: string;
  amount!: number;
}
