import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;
}

export class AuthResponseDto {
  success!: boolean;
  message!: string;
  accessToken?: string;
}

export class UserProfileDto {
  id!: string;
  email!: string;
  firstName!: string;
  lastName!: string;
  roles!: string[];
}

export class BaseResponseDto {
  success!: boolean;
  message!: string;
}
