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

export class WithdrawalListItemDto {
  id!: string;
  reference!: string;
  receiptNumber!: string;
  commodity!: string;
  quantity!: number;
  status!: string;
  createdAt!: Date;
}

export class PaginationMetaDto {
  total!: number;
  page!: number;
  limit!: number;
  totalPages!: number;
}

export class PaginatedWithdrawalResponseDto {
  data!: WithdrawalListItemDto[];
  meta!: PaginationMetaDto;
}

export class WithdrawalResponseDto {
  id!: string;
  status!: string;
  quantity!: number;
  reference?: string;
  fee?: number;
  reason?: string;
  plannedDate?: Date;
}
