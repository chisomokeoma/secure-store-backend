import { IsString, IsNumber } from 'class-validator';

export class CreateTradeDto {
  @IsString()
  receiptId!: string;

  @IsNumber()
  price!: number;
}

export class TradeListingDto {
  id!: string;
  commodityName!: string;
  quantity!: number;
  price!: number;
}

export class TradeResponseDto {
  id!: string;
  status!: string;
}
