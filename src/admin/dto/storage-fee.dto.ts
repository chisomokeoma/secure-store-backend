import { ApiProperty } from '@nestjs/swagger';
import { FeeType, BillingFrequency } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsString,
} from 'class-validator';

export class CreateStorageFeePolicyDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  commodityId?: string;

  @ApiProperty({ enum: FeeType })
  @IsEnum(FeeType)
  feeType!: FeeType;

  @ApiProperty()
  @IsNumber()
  rate!: number;

  @ApiProperty({ enum: BillingFrequency })
  @IsEnum(BillingFrequency)
  billingFrequency!: BillingFrequency;

  @ApiProperty()
  @IsNumber()
  gracePeriodDays!: number;

  @ApiProperty()
  @IsNumber()
  latePenaltyPct!: number;

  @ApiProperty({ required: false, default: 'NGN' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class StorageFeePolicyDto extends CreateStorageFeePolicyDto {
  @ApiProperty()
  id!: string;
}
