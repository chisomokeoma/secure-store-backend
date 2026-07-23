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
 *
 * "Basic KYC" block (contactEmail through website) is optional per PO
 * decision — financiers are heavily regulated externally, so our own
 * KYC is light. The GA form only enforces `name` + `licenseNumber` +
 * `firstUser`; the rest fills in over time via edit.
 */
export class CreateFinancierOrgDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  // Optional per FE's BASIC-KYC-UPDATE (2026-07-23): regulated
  // institutions are verified off-platform, so we no longer require the
  // GA to enter a license number at onboarding. May be filled in later
  // via PATCH /admin/financiers/:id.
  @IsOptional() @IsString() @MaxLength(64) licenseNumber?: string;
  @IsOptional() @IsString() logoUrl?: string;

  // Optional URL of the signed license certificate / master agreement PDF
  // — uploaded via POST /storage/upload?kind=LICENSE_DOC on the GA's Add
  // Financier drawer. Persists on FinancierOrg so the admin table can offer
  // a "view license" affordance later.
  @IsOptional() @IsString() licenseDocUrl?: string;

  // Basic-KYC block (all optional). Field names match FE
  // CreateFinancierOrgPayload verbatim (contactEmail / phoneNumber /
  // address) — no camel/snake remapping in the service layer.
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(32) phoneNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;

  // Extra fields NOT in the current FE form but retained in the schema
  // for future admin surfaces (regulator directory, TIN report, external
  // linkouts). Optional; ignored by today's FE.
  @IsOptional() @IsString() @MaxLength(32) tin?: string;
  @IsOptional() @IsString() @MaxLength(64) regulator?: string;
  @IsOptional() @IsString() @MaxLength(200) website?: string;

  @ValidateNested()
  @Type(() => FinancierOrgFirstUserDto)
  firstUser!: FinancierOrgFirstUserDto;
}

/**
 * Payload for PATCH /admin/financiers/:id — edit the org's basic-KYC
 * profile. All fields optional; only the ones present are updated. Name
 * is editable (rebrand support) but must remain globally unique.
 * Reactivation, suspension, and offboarding go through their dedicated
 * verb endpoints, not this patch.
 */
export class UpdateFinancierOrgDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(64) licenseNumber?: string;
  @IsOptional() @IsString() logoUrl?: string;
  @IsOptional() @IsString() licenseDocUrl?: string;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(32) phoneNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(32) tin?: string;
  @IsOptional() @IsString() @MaxLength(64) regulator?: string;
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}

/**
 * Payload for POST /admin/financiers/:id/offboard. Reason is mandatory
 * so the audit trail carries the *why* of the terminal action. The
 * endpoint refuses to proceed if any active liens exist (see service).
 */
export class OffboardFinancierOrgDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
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
