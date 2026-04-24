import { IsString, IsNotEmpty, MinLength, IsOptional } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  oldPassword!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;
}

export class UserPreferencesDto {
  emailNotifications!: boolean;
  smsNotifications!: boolean;
}
