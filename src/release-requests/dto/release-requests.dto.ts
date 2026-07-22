import {
  IsArray,
  ArrayMinSize,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One line within a release request — targets a specific lien with a
 * specific quantity. FE shape (CreateReleaseRequestPayload.lines[]):
 *   { lienId: string, quantity: string }
 */
export class ReleaseRequestLineDto {
  @IsUUID() lienId!: string;

  @IsString()
  @Matches(/^\d+(\.\d{1,4})?$/, {
    message: 'quantity must be a positive decimal (up to 4 places)',
  })
  quantity!: string;
}

/**
 * POST /me/release-requests. FE `CreateReleaseRequestPayload`.
 * All lines MUST target liens belonging to `financierId` (single
 * financier per request — the FE flow picks one and shows lines under it).
 * At least one line required.
 */
export class CreateReleaseRequestDto {
  @IsUUID() financierId!: string;

  @IsDateString() requestedDate!: string;

  @IsOptional() @IsString() @MaxLength(500) note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReleaseRequestLineDto)
  lines!: ReleaseRequestLineDto[];
}

/**
 * POST /financier/release-requests/:id/approve — matches FE
 * ApproveReleasePayload. OTP is mandatory (2FA gate per §5).
 */
export class ApproveReleaseRequestDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'otp must be exactly 6 digits' })
  otp!: string;
}

/**
 * POST /financier/release-requests/:id/reject — mandatory reason.
 */
export class RejectReleaseRequestDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}
