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
  IsIn,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  ClientType,
  ClientMode,
  CompanyCategory,
  IdType,
  MaritalStatus,
  ClientDocumentType,
  ClientDocumentScope,
} from '@prisma/client';

// Time bucket size for the commodity-movement chart.
// `day` and `week` are useful for short horizons (last week / last month);
// `month` is the existing default; `quarter` and `year` are for long-range views.
export const MOVEMENT_GRANULARITIES = [
  'day',
  'week',
  'month',
  'quarter',
  'year',
] as const;
export type MovementGranularity = (typeof MOVEMENT_GRANULARITIES)[number];

// Convenience period presets so the FE doesn't have to compute date ranges
// for the common cases. `custom` requires `from`/`to` to be supplied.
export const MOVEMENT_PERIODS = [
  '7d',
  '30d',
  '90d',
  '6m',
  '1y',
  'ytd',
  'all',
  'custom',
] as const;
export type MovementPeriod = (typeof MOVEMENT_PERIODS)[number];

export class GetMovementDto {
  /** Preset window — overridden by from/to when `custom`. Defaults to `6m`. */
  @IsOptional()
  @IsIn(MOVEMENT_PERIODS as unknown as string[])
  period?: MovementPeriod;

  /** ISO date (YYYY-MM-DD). Only honoured when `period=custom` or omitted. */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  /** Bucket size. Defaults to `month`. */
  @IsOptional()
  @IsIn(MOVEMENT_GRANULARITIES as unknown as string[])
  granularity?: MovementGranularity;

  /**
   * Restrict the chart to a subset of commodities. Accept either an array
   * (POST-style) or a comma-separated string (?commodityIds=a,b,c).
   * Empty / omitted = all commodities.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  commodityIds?: string[];
}

// ── Director sub-DTO (organisation mode only) ──────────────────────────────
// One per director on the corporate-onboarding form's "Director Details + ADD"
// repeatable block. All fields optional except the name pair so an admin can
// add a stub director and complete KYC later if needed.
export class CreateDirectorDto {
  // Optional client-side ref used only at create time: the FE assigns a
  // stable string (e.g. 'd1') to each director, then references it on the
  // matching DIRECTOR-scoped documents via `directorRef`. The service
  // maps refs to the newly-minted director ids and never persists the ref
  // itself. Ignored on update.
  @IsOptional() @IsString() ref?: string;

  @IsString() firstName!: string;
  @IsString() lastName!: string;

  @IsOptional() @IsString() otherNames?: string;
  @IsOptional() @IsString() designation?: string;
  @IsOptional() @IsString() residentialAddress?: string;
  @IsOptional() @IsString() phoneNumber?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() mothersMaidenName?: string;
  @IsOptional() @IsString() gender?: string;
  @IsOptional() @IsDateString() dateOfBirth?: string;
  @IsOptional() @IsString() nationality?: string;
  @IsOptional() @IsString() stateOfOrigin?: string;
  @IsOptional() @IsEnum(MaritalStatus) maritalStatus?: MaritalStatus;
  @IsOptional() @IsString() bvn?: string;
  @IsOptional() @IsString() nin?: string;
  @IsOptional() @IsEnum(IdType) idType?: IdType;
  @IsOptional() @IsString() idNumber?: string;
  @IsOptional() @IsDateString() idIssueDate?: string;
  @IsOptional() @IsDateString() idExpiryDate?: string;
}

// ── Document reference sub-DTO ─────────────────────────────────────────────
// FE uploads the file to its configured storage (S3/Spaces/etc.) and POSTs
// just the resulting URL + type + scope. We don't host files.
export class CreateClientDocumentDto {
  @IsEnum(ClientDocumentType) type!: ClientDocumentType;
  @IsEnum(ClientDocumentScope) scope!: ClientDocumentScope;
  @IsString() url!: string;
  // Required for scope = DIRECTOR: identifies WHICH director this doc
  // belongs to. The FE supplies a stable id it generated during create
  // (e.g. an index or temp uuid); the service maps it to the new director
  // row before persisting. For COMPANY / REPRESENTATIVE scopes this is
  // ignored.
  @IsOptional() @IsString() directorRef?: string;
  @IsOptional() @IsString() fileName?: string;
  @IsOptional() @IsNumber() fileSize?: number;
  @IsOptional() @IsString() mimeType?: string;
}

export class CreateClientDto {
  // Discriminator. Omit / null defaults to INDIVIDUAL, preserving the
  // existing payload shape exactly.
  @IsOptional() @IsEnum(ClientMode) mode?: ClientMode;

  // For INDIVIDUAL: the client's own name. For ORGANIZATION: the
  // Authorized Representative's name (the rep becomes the User row).
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

  // ── ORGANIZATION-only fields ─────────────────────────────────────────────
  // Ignored when mode = INDIVIDUAL (or unset). For ORGANIZATION, rcNumber +
  // companyName are functionally required at the service layer; the DTO
  // keeps them optional so a partial draft can still validate.
  @IsOptional() @IsString() rcNumber?: string;
  @IsOptional() @IsString() companyName?: string;
  @IsOptional() @IsEnum(CompanyCategory) companyCategory?: CompanyCategory;
  @IsOptional() @IsString() companyCategoryOther?: string;
  @IsOptional() @IsDateString() dateOfIncorporation?: string;
  @IsOptional() @IsString() natureOfBusiness?: string;
  @IsOptional() @IsString() sectorIndustry?: string;
  @IsOptional() @IsString() businessAddress?: string;
  @IsOptional() @IsString() tin?: string;

  // Authorised-Rep / extended KYC fields. For INDIVIDUAL clients these
  // are optional self-KYC; for ORGANIZATION clients they describe the rep
  // whose name is already in firstName/lastName.
  @IsOptional() @IsString() representativeDesignation?: string;
  @IsOptional() @IsString() otherNames?: string;
  @IsOptional() @IsString() mothersMaidenName?: string;
  @IsOptional() @IsEnum(MaritalStatus) maritalStatus?: MaritalStatus;
  @IsOptional() @IsEnum(IdType) idType?: IdType;
  @IsOptional() @IsString() idNumber?: string;
  @IsOptional() @IsDateString() idIssueDate?: string;
  @IsOptional() @IsDateString() idExpiryDate?: string;

  // Directors block. Empty / omitted is valid even in ORGANIZATION mode
  // (the admin can add directors later via the update endpoint).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateDirectorDto)
  directors?: CreateDirectorDto[];

  // Document URLs (uploaded elsewhere). Per-director docs use
  // `directorRef` to identify which director they belong to.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateClientDocumentDto)
  documents?: CreateClientDocumentDto[];
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

  // File URLs — both must come from POST /storage/upload. The WM-side
  // edit form lets the warehouse manager replace the client's profile
  // photo and the ID document scan on the client's behalf. The service
  // mirrors `profilePhotoUrl` onto BOTH the User row (where /me reads
  // from) AND the ClientProfile row (where the WM's client-detail view
  // reads from) so both surfaces stay in sync. Empty string clears the
  // value; omit to leave untouched.
  @IsOptional() @IsString() profilePhotoUrl?: string;
  @IsOptional() @IsString() idDocumentUrl?: string;

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

  // ── Organisation-mode patches ────────────────────────────────────────────
  // `mode` itself is intentionally not updatable — switching between modes
  // changes too much downstream semantics. Recreate the client instead.
  @IsOptional() @IsString() rcNumber?: string;
  @IsOptional() @IsString() companyName?: string;
  @IsOptional() @IsEnum(CompanyCategory) companyCategory?: CompanyCategory;
  @IsOptional() @IsString() companyCategoryOther?: string;
  @IsOptional() @IsDateString() dateOfIncorporation?: string;
  @IsOptional() @IsString() natureOfBusiness?: string;
  @IsOptional() @IsString() sectorIndustry?: string;
  @IsOptional() @IsString() businessAddress?: string;
  @IsOptional() @IsString() tin?: string;

  @IsOptional() @IsString() representativeDesignation?: string;
  @IsOptional() @IsString() otherNames?: string;
  @IsOptional() @IsString() mothersMaidenName?: string;
  @IsOptional() @IsEnum(MaritalStatus) maritalStatus?: MaritalStatus;
  @IsOptional() @IsEnum(IdType) idType?: IdType;
  @IsOptional() @IsString() idNumber?: string;
  @IsOptional() @IsDateString() idIssueDate?: string;
  @IsOptional() @IsDateString() idExpiryDate?: string;

  // Directors + documents on PATCH: when supplied, fully replaces the
  // existing set (same semantics as focusCommodityIds). Omit to leave the
  // current rows untouched; pass `[]` to clear.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateDirectorDto)
  directors?: CreateDirectorDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateClientDocumentDto)
  documents?: CreateClientDocumentDto[];
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

/**
 * Patch payload for editing a previously-filed deposit. Every field is
 * optional — omit a field to leave the existing value untouched. Same field
 * names as `CreateDepositDto` so the FE can re-use form components.
 *
 * Authorisation + state restrictions live in the service:
 *   • WM edit endpoint  → only when the receipt is PENDING_APPROVAL
 *   • TA edit endpoint  → any non-terminal state, with extra restrictions
 *                         on ACTIVE (no quantity / commodityId / warehouseId)
 *   • HELD_* states     → refused; release the hold first
 *   • SPLIT internal    → refused (it's a superseded parent, not editable)
 *
 * If `measurements` is supplied and `grade` is NOT, the service re-runs the
 * commodity's grading algorithm and stamps the computed grade. If `grade`
 * is supplied it wins as a manual override (audit log records the override).
 */
export class EditDepositDto {
  @IsOptional() @IsString() commodityId?: string;
  @IsOptional() @IsString() warehouseId?: string;
  @IsOptional() @IsNumber() @IsPositive() quantity?: number;
  @IsOptional() @IsObject() measurements?: Record<string, number>;
  @IsOptional() @IsString() grade?: string;
  @IsOptional() @IsDateString() dateOfDeposit?: string;
  // Free-text reason — surfaces in the ActivityLog metadata so the audit
  // trail records WHY the edit happened, not just what changed.
  @IsOptional() @IsString() editReason?: string;
}
