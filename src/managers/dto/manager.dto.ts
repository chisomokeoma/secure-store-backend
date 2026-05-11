import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsUUID,
  IsArray,
  IsDateString,
  IsEnum,
  IsObject,
} from 'class-validator';

export enum ManagerGender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
}

export class ManagerPermissionsDto {
  @ApiProperty({ default: true })
  manageClients!: boolean;

  @ApiProperty({ default: true })
  manageReceipts!: boolean;

  @ApiProperty({ default: true })
  viewReports!: boolean;

  @ApiProperty({ default: true })
  approveDeposit!: boolean;
}

export class ManagerNotificationPrefsDto {
  @ApiProperty({ default: true })
  email!: boolean;

  @ApiProperty({ default: true })
  sms!: boolean;

  @ApiProperty({ default: true })
  inApp!: boolean;
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
  @IsObject()
  permissions?: ManagerPermissionsDto;

  @ApiProperty({ type: ManagerNotificationPrefsDto, required: false })
  @IsOptional()
  @IsObject()
  notificationPrefs?: ManagerNotificationPrefsDto;
}

export class CreateManagerDto {
  @ApiProperty({ type: PersonalInfoDto })
  personalInfo!: PersonalInfoDto;

  @ApiProperty({ type: AccountSetupDto, required: false })
  @IsOptional()
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
  personalInfo?: Partial<PersonalInfoDto>;

  @ApiProperty({ type: AccountSetupDto, required: false })
  @IsOptional()
  accountSetup?: AccountSetupDto;
}

export class AssignWarehousesDto {
  @ApiProperty({ type: [String], example: ['uuid-1', 'uuid-2'] })
  @IsArray()
  @IsUUID(4, { each: true })
  warehouseIds!: string[];
}
