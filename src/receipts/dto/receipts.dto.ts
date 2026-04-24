export class ReceiptDetailsDto {
  id!: string;
  receiptNumber!: string;
  commodityName!: string;
  quantity!: number;
  status!: string;
}

export class ReceiptStatsDto {
  totalIssued!: number;
  totalPledged!: number;
  totalWithdrawn!: number;
}
