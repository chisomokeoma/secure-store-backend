import { IsString } from 'class-validator';

// Reworked flow: clients do NOT set trade terms here — they just push the
// selected receipt to the exchange. Pricing is fully exchange-driven and
// arrives via the (deferred) settlement webhook. Payload is just the receipt.
export class CreateTradeDto {
  @IsString()
  receiptId!: string;
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
