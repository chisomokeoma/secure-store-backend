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
  status!: string;
  createdAt!: Date;
}

export class PaginationMetaDto {
  total!: number;
  page!: number;
  limit!: number;
  totalPages!: number;
}

export class PaginatedTradeResponseDto {
  data!: TradeListingDto[];
  meta!: PaginationMetaDto;
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
