export class ReceiptDetailsDto {
  id!: string;
  receiptNumber!: string;
  commodityName!: string;
  warehouseName!: string;
  quantity!: number;
  quantityAvailable!: number;
  status!: string;
}

export class PaginationMetaDto {
  total!: number;
  page!: number;
  limit!: number;
  totalPages!: number;
}

export class PaginatedReceiptResponseDto {
  data!: ReceiptDetailsDto[];
  meta!: PaginationMetaDto;
}

export class ReceiptStatsDto {
  totalIssued!: number;
  totalActive!: number;
  totalPledged!: number;
  totalWithdrawn!: number;
}
