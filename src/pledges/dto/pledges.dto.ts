import {
  IsString,
  IsOptional,
  IsUUID,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';

/**
 * POST /me/pledges. Matches FE `CreatePledgePayload`:
 *   { receiptId, financierId, quantity, note? }
 *
 * `financierId` — the FinancierOrg the client wants to pledge to.
 * The FE picks this from GET /me/financiers?warehouseId=... which only
 * returns financiers with an ACTIVE WarehouseLink to the receipt's
 * warehouse.
 *
 * `quantity` — decimal string in the receipt's unit. Regex allows up
 * to 4 decimal places to match the schema's Decimal(20,4).
 */
export class CreatePledgeDto {
  @IsUUID() receiptId!: string;
  @IsUUID() financierId!: string;

  @IsString()
  @Matches(/^\d+(\.\d{1,4})?$/, {
    message: 'quantity must be a positive decimal (up to 4 places)',
  })
  quantity!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

/**
 * POST /financier/pledges/:id/accept — matches FE AcceptPledgePayload.
 * OTP is mandatory (2FA gate per §5); note is free-text for the
 * financier to attach context to the acceptance.
 */
export class AcceptPledgeDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'otp must be exactly 6 digits' })
  otp!: string;

  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/**
 * POST /financier/pledges/:id/reject — matches FE RejectPledgePayload.
 * Reason is mandatory (financier must justify).
 */
export class RejectPledgeDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

/**
 * POST /financier/otp/request — matches FE RequestFinancierOtpPayload.
 * `context` picks the TransactionOtpPurpose the OTP is scoped to.
 * `resourceId` is the pledge or release-request id the caller is about
 * to act on; kept for correlation / audit even though the OTP flow
 * doesn't bind to it strictly.
 */
export class RequestFinancierOtpDto {
  @IsString()
  @Matches(/^(PLEDGE_ACCEPT|RELEASE_APPROVE)$/, {
    message: 'context must be PLEDGE_ACCEPT or RELEASE_APPROVE',
  })
  context!: 'PLEDGE_ACCEPT' | 'RELEASE_APPROVE';

  @IsUUID() resourceId!: string;
}
