import {
  IsString,
  IsOptional,
  IsEmail,
  IsNumber,
  IsPositive,
  IsObject,
  IsEnum,
  IsDateString,
  IsArray,
  ArrayUnique,
} from 'class-validator';
import { ClientType } from '@prisma/client';

export class CreateClientDto {
  @IsString() firstName!: string;
  @IsString() lastName!: string;

  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phoneNumber?: string;
  @IsOptional() @IsString() gender?: string;
  @IsOptional() @IsDateString() dateOfBirth?: string;

  @IsOptional() @IsEnum(ClientType) type?: ClientType;
  @IsOptional() @IsString() occupation?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() nationality?: string;
  @IsOptional() @IsString() stateOfOrigin?: string;
  @IsOptional() @IsString() lga?: string;
  @IsOptional() @IsString() nationalId?: string;
  @IsOptional() @IsString() residentialAddress?: string;

  // Multi-focus commodities. Replaces the legacy single `focusCommodityId`.
  // Passing `[]` is valid and means "no focus commodities".
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  focusCommodityIds?: string[];

  @IsOptional() @IsString() profilePhotoUrl?: string;
  @IsOptional() @IsString() idDocumentUrl?: string;

  @IsOptional() @IsString() bankAccountName?: string;
  @IsOptional() @IsString() bankAccountNumber?: string;
  @IsOptional() @IsString() bankName?: string;

  @IsOptional() @IsString() nokFullName?: string;
  @IsOptional() @IsString() nokAddress?: string;
  @IsOptional() @IsString() nokPhone?: string;
  @IsOptional() @IsString() nokEmail?: string;
  @IsOptional() @IsString() nokRelationship?: string;
}

export class UpdateClientDto {
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsString() phoneNumber?: string;
  @IsOptional() @IsEnum(ClientType) type?: ClientType;
  @IsOptional() @IsString() occupation?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() nationality?: string;
  @IsOptional() @IsString() stateOfOrigin?: string;
  @IsOptional() @IsString() lga?: string;
  @IsOptional() @IsString() nationalId?: string;
  @IsOptional() @IsString() residentialAddress?: string;

  // Pass the full desired set; the service replaces existing focus rows
  // atomically. Omit to leave the existing set untouched; pass `[]` to
  // clear all focus commodities.
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  focusCommodityIds?: string[];

  @IsOptional() @IsString() bankAccountName?: string;
  @IsOptional() @IsString() bankAccountNumber?: string;
  @IsOptional() @IsString() bankName?: string;
  @IsOptional() @IsString() nokFullName?: string;
  @IsOptional() @IsString() nokAddress?: string;
  @IsOptional() @IsString() nokPhone?: string;
  @IsOptional() @IsString() nokEmail?: string;
  @IsOptional() @IsString() nokRelationship?: string;
}

export class CreateDepositDto {
  @IsString() clientId!: string;
  @IsString() commodityId!: string;
  @IsString() warehouseId!: string;

  @IsNumber() @IsPositive() quantity!: number;

  // Raw grading measurements, keyed by grading-parameter **id**
  // (the ids returned from GET /manager/commodities/:id/grading-parameters).
  @IsObject() measurements!: Record<string, number>;

  @IsOptional() @IsString() grade?: string;
  @IsOptional() @IsDateString() dateOfDeposit?: string;
}

/**
 * Stateless grading preview — used on the WM's deposit "review" step so the
 * computed grade can be shown to the manager (and the client) BEFORE submit.
 * Same scoring logic as `createDeposit`; mismatch between preview and submit
 * is therefore impossible.
 */
export class PreviewGradingDto {
  @IsString() commodityId!: string;

  // Measurements keyed by grading-parameter **id** — identical to the
  // shape `CreateDepositDto.measurements` uses, so the FE can hand the
  // same object to both endpoints without remapping.
  @IsObject() measurements!: Record<string, number>;
}
