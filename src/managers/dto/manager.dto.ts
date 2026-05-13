import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsUUID,
  IsArray,
  IsDateString,
  IsEnum,
  IsBoolean,
  ValidateNested,
} from 'class-validator';

export enum ManagerGender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
}

export class ManagerPermissionsDto {
  @ApiProperty({ default: true })
  @IsOptional()
  @IsBoolean()
  manageClients?: boolean;

  @ApiProperty({ default: true })
  @IsOptional()
  @IsBoolean()
  manageReceipts?: boolean;

  @ApiProperty({ default: true })
  @IsOptional()
  @IsBoolean()
  viewReports?: boolean;

  @ApiProperty({ default: true })
  @IsOptional()
  @IsBoolean()
  approveDeposit?: boolean;
}

export class ManagerNotificationPrefsDto {
  @ApiProperty({ default: true })
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @ApiProperty({ default: true })
  @IsOptional()
  @IsBoolean()
  sms?: boolean;

  @ApiProperty({ default: true })
  @IsOptional()
  @IsBoolean()
  inApp?: boolean;
}

export class PersonalInfoDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  middleName?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  lastName!: string;

  @ApiProperty({ enum: ManagerGender, required: false })
  @IsOptional()
  @IsEnum(ManagerGender)
  gender?: ManagerGender;

  @ApiProperty({ required: false, example: '1990-01-15' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  residentialAddress?: string;

  @ApiProperty({ required: false, example: '+2348012345678' })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({ required: false, example: 'amina.bello@gmail.com' })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiProperty({ required: false, example: '2025-01-01' })
  @IsOptional()
  @IsDateString()
  employmentDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  profilePhotoUrl?: string;
}

export class AccountSetupDto {
  @ApiProperty({ type: ManagerPermissionsDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => ManagerPermissionsDto)
  permissions?: ManagerPermissionsDto;

  @ApiProperty({ type: ManagerNotificationPrefsDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => ManagerNotificationPrefsDto)
  notificationPrefs?: ManagerNotificationPrefsDto;
}

export class CreateManagerDto {
  @ApiProperty({ type: PersonalInfoDto })
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => PersonalInfoDto)
  personalInfo!: PersonalInfoDto;

  @ApiProperty({ type: AccountSetupDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => AccountSetupDto)
  accountSetup?: AccountSetupDto;

  @ApiProperty({
    type: [String],
    required: false,
    example: ['uuid-warehouse-1', 'uuid-warehouse-2'],
  })
  @IsOptional()
  @IsArray()
  @IsUUID(4, { each: true })
  warehouseIds?: string[];
}

export class UpdateManagerDto {
  @ApiProperty({ type: PersonalInfoDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => PersonalInfoDto)
  personalInfo?: Partial<PersonalInfoDto>;

  @ApiProperty({ type: AccountSetupDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => AccountSetupDto)
  accountSetup?: AccountSetupDto;
}

export class AssignWarehousesDto {
  @ApiProperty({ type: [String], example: ['uuid-1', 'uuid-2'] })
  @IsArray()
  @IsUUID(4, { each: true })
  warehouseIds!: string[];
}
