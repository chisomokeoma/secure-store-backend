import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async getNotifications() {
    return [
      { id: 'N-001', title: 'New Receipt Issued', message: 'Warehouse Receipt WR-2025-0015 has been issued.', isRead: false, createdAt: new Date() },
      { id: 'N-002', title: 'Loan Approved', message: 'Your loan from Zenith Bank is approved.', isRead: true, createdAt: new Date(Date.now() - 86400000) }
    ];
  }
}
