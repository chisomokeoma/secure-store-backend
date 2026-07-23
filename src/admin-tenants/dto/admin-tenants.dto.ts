import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  MinLength,
  MaxLength,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TenantType } from '@prisma/client';

/**
 * First tenant admin, created inline with the tenant so someone can sign
 * in and start operating the day the org is onboarded. `email` is the
 * person's REAL inbox (welcome mail + future OTPs delivered here); the
 * server derives a system-issued login alias
 * (`firstname.lastname@securestore.com`) internally, same convention as
 * WMs and financier users.
 */
export class TenantFirstAdminDto {
  @IsString() @MinLength(1) firstName!: string;
  @IsString() @MinLength(1) lastName!: string;
  @IsEmail()  email!: string;
}

/**
 * Payload for POST /admin/tenants. Matches the FE's CreateTenantPayload
 * verbatim (src/api/types/admin-global.ts). Only `name` and `firstAdmin`
 * are enforced; slug is derived from `name` when omitted; the commercial
 * contact block is entirely optional.
 */
export class CreateTenantDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;

  // Slug is URL-safe (lowercase + dashes). If the client submits one, we
  // validate its shape; otherwise the service derives one from `name`.
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    message: 'slug must be lowercase alphanumeric with optional dashes',
  })
  slug?: string;

  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(32) phoneNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() logoUrl?: string | null;

  // INTERNAL = SecureStore's own operations (rare; only set for tenants
  // we operate ourselves); EXTERNAL = paying customer collateral managers
  // (the default). Only EXTERNAL tenants are suspendable.
  @IsOptional() @IsEnum(TenantType) type?: TenantType;

  @ValidateNested()
  @Type(() => TenantFirstAdminDto)
  firstAdmin!: TenantFirstAdminDto;
}

/**
 * Payload for POST /admin/tenants/:id/suspend. Reason is optional per
 * the FE spec but strongly encouraged — it lands on the audit trail.
 */
export class SuspendTenantDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
