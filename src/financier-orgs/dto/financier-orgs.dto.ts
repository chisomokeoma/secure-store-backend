import {
  IsString,
  IsOptional,
  IsEmail,
  IsInt,
  Min,
  Max,
  MinLength,
  MaxLength,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * The first user seeded into a new FinancierOrg. The `email` field is
 * the user's REAL inbox (welcome mail + future OTPs delivered here);
 * the server derives a system-issued login alias
 * (`firstname.lastname@securestore.com`) internally. This matches the FE's
 * "Add Financier" modal — the TA only types the person's real email.
 *
 * Naming: field is `email` (matches FE payload verbatim per
 * src/api/types/collateral.ts:CreateFinancierOrgPayload.firstUser.email);
 * on the User row it lands in `contactEmail`.
 */
export class FinancierOrgFirstUserDto {
  @IsString() @MinLength(1) firstName!: string;
  @IsString() @MinLength(1) lastName!: string;
  @IsEmail()  email!: string;
}

/**
 * Payload for POST /admin/financiers — creates the org + first user
 * atomically. Matches the FE's CreateFinancierOrgPayload shape verbatim.
 * `licenseNumber` is required (FE marks it as `string`, not `string?`).
 */
export class CreateFinancierOrgDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsString() @MinLength(1) @MaxLength(64) licenseNumber!: string;
  @IsOptional() @IsString() logoUrl?: string;

  // Optional URL of the signed license certificate / master agreement PDF
  // — uploaded via POST /storage/upload?kind=LICENSE_DOC on the FE's Add
  // Financier drawer. Persists on FinancierOrg so the TA table can offer
  // a "view license" affordance later.
  @IsOptional() @IsString() licenseDocUrl?: string;

  @ValidateNested()
  @Type(() => FinancierOrgFirstUserDto)
  firstUser!: FinancierOrgFirstUserDto;
}

/**
 * Payload for POST /admin/financiers/:id/users — invites an additional
 * user. Same shape as the first-user block for FE reuse.
 */
export class InviteFinancierUserDto {
  @IsString() @MinLength(1) firstName!: string;
  @IsString() @MinLength(1) lastName!: string;
  @IsEmail()  email!: string;
}

/**
 * Payload for PATCH /financier/settings (Q1 — per-org pledge TTL).
 * `null` clears the override → falls back to platform default.
 * 1–90 sets a custom window. Matches FE's UpdateFinancierSettingsPayload
 * (which requires the field but allows null; nullable-but-required).
 */
export class UpdateFinancierSettingsDto {
  // FE always sends this field on save (either an integer or null).
  // We use `@ValidateIf` to allow null through, and `@Min/@Max` when set.
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(90)
  pledgeTtlDays!: number | null;
}

/**
 * Payload for POST /admin/warehouse-links/:id/reject. Reason is mandatory
 * per FE flow (rejection UI has a required textarea).
 */
export class RejectWarehouseLinkDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

/**
 * Payload for POST /financier/warehouses/:id/onboard.
 * `agreementDocUrl` — the URL of the signed agreement PDF the financier
 * uploaded via POST /storage/upload?kind=AGREEMENT_DOC.
 */
export class OnboardWarehouseDto {
  @IsString() @MinLength(1) agreementDocUrl!: string;
}
