import { IsString, IsNumber, IsOptional } from 'class-validator';

export class CalculateWithdrawalDto {
  @IsString()
  receiptId!: string;

  @IsNumber()
  quantity!: number;
}

export class CreateWithdrawalDto extends CalculateWithdrawalDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsString()
  plannedDate!: string;
}

export class WithdrawalCalculationResponseDto {
  totalFee!: number;
  breakdown!: any;
}

export class WithdrawalResponseDto {
  id!: string;
  status!: string;
  quantity!: number;
}
