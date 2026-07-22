import {
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * POST /admin/liens/:id/force-release. Both fields mandatory per §4.
 *
 * `reason`  — free text; captured on the ForceRelease audit row.
 * `courtOrderDocUrl` — URL of the court order PDF the admin uploaded via
 * POST /storage/upload?kind=COURT_ORDER before hitting this endpoint.
 * The admin controller does NOT re-verify the URL (already validated by
 * the storage layer at upload time); it just persists the reference.
 */
export class ForceReleaseDto {
  @IsString() @IsNotEmpty() @MinLength(1) @MaxLength(2000) reason!: string;

  @IsString() @IsNotEmpty() courtOrderDocUrl!: string;
}
