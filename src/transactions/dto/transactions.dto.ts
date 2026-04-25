export class TransactionDto {
  id!: string;
  type!: string;
  reference!: string;
  status!: string;
  amount!: number;
  quantity?: number;
  receiptNumber?: string;
  commodity?: string;
  counterparty?: string;
  date!: Date;
}
