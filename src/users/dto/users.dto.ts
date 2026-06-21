import { IsString, IsNotEmpty, MinLength, IsOptional } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  middleName?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  // The URL of an already-uploaded profile photo. The FE uploads the file
  // first via POST /storage/upload?kind=PROFILE_PHOTO, gets back a URL, and
  // sends it here. UsersService.updateMe runs the URL through
  // StorageService.assertOwnedUrls so we never persist a URL we didn't
  // issue ourselves. Pass an empty string to clear the photo.
  @IsOptional()
  @IsString()
  profilePhotoUrl?: string;

  // contactEmail is intentionally NOT here. It's the destination for all
  // password-reset links and transaction OTPs, so changing it must go
  // through a step-up flow (current password + OTP delivered to the
  // CURRENT contact email, same pattern as password rotation). Until that
  // flow is built, the FE should route email changes through support.
}

export class ChangePasswordDto {
  // Renamed from `oldPassword` to match the FE convention and the sibling
  // /me/change-password endpoint. `currentPassword` is the single name
  // across the whole codebase now.
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;

  // 6-digit OTP delivered to the user's contactEmail. The FE requests
  // it via POST /me/transactions/request-otp { purpose: 'CHANGE_PASSWORD' }
  // and surfaces the input on the form. Required regardless of whether
  // 2FA on transactions is enabled — this OTP is a step-up gate that
  // exists specifically to stop session-thieves and shared-kiosk WMs
  // from silently rotating someone else's password.
  @IsString()
  @IsNotEmpty()
  otp!: string;
}

export class UserPreferencesDto {
  emailNotifications!: boolean;
  smsNotifications!: boolean;
}
