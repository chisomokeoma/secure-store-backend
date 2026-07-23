import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload for POST /admin/users/:userId/disable. `reason` is optional
 * but strongly encouraged — it lands on the audit trail so future
 * operators can see why the account was disabled.
 */
export class DisableUserDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
