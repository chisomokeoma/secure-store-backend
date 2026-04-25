import { IsString, IsNumber, IsPositive } from 'class-validator';

export class CreateTradeDto {
  @IsString()
  receiptId!: string;

  @IsNumber()
  @IsPositive()
  pricePerUnit!: number;
}

export class SettleTradeDto {
  @IsString()
  buyerId!: string;
}

export class TradeListingDto {
  id!: string;
  reference!: string;
  receiptNumber!: string;
  commodityName!: string;
  quantity!: number;
  pricePerUnit!: number;
  totalPrice!: number;
  seller!: string;
}

export class TradeResponseDto {
  id!: string;
  reference!: string;
  status!: string;
  quantity?: number;
  pricePerUnit?: number;
  totalPrice?: number;
  listedReceipt?: string;
}
