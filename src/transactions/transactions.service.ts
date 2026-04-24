import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TransactionsService {
  constructor(private prisma: PrismaService) {}

  async getTransactions(type?: string) {
    return [
      { id: 'TX-001', type: 'DEPOSIT', amount: 0, date: new Date() },
      { id: 'TX-002', type: 'WITHDRAWAL_FEE', amount: 1500, date: new Date(Date.now() - 86400000) }
    ].filter(tx => !type || tx.type === type);
  }
}
