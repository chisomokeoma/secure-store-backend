import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsBoolean,
  IsUUID,
  IsNotEmpty,
  IsObject,
} from 'class-validator';

export class GradingParameterDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  commodityId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  unit!: string;

  @ApiProperty()
  isDefective!: boolean;

  @ApiProperty()
  thresholds!: any;
}

export class CreateGradingParameterDto {
  @ApiProperty()
  @IsUUID()
  commodityId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty()
  @IsString()
  unit!: string;

  @ApiProperty()
  @IsBoolean()
  isDefective!: boolean;

  @ApiProperty()
  @IsObject()
  thresholds!: any;
}
