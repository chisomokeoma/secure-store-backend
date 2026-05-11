import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserStatus } from '@prisma/client';

@Injectable()
export class AdminClientService {
  constructor(private prisma: PrismaService) {}

  async getClients(tenantId: string) {
    return this.prisma.user.findMany({
      where: {
        tenantId,
        roles: {
          some: {
            role: {
              name: 'CLIENT',
            },
          },
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        status: true,
        createdAt: true,
        _count: {
          select: {
            receipts: true,
            loans: true,
            tradesAsSeller: true,
            tradesAsBuyer: true,
          },
        },
      },
    });
  }

  async createClient(
    tenantId: string,
    dto: {
      email: string;
      firstName: string;
      lastName: string;
      password?: string;
    },
  ) {
    // 1. Check if user exists
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) throw new BadRequestException('User already exists');

    // 2. Get CLIENT role
    const clientRole = await this.prisma.role.findUnique({
      where: { name: 'CLIENT' },
    });
    if (!clientRole) throw new BadRequestException('CLIENT role not found');

    // 3. Create user and assign role
    return this.prisma.user.create({
      data: {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        password: dto.password || 'SecurePassword123!', // Hash this in production
        tenantId,
        status: UserStatus.ACTIVE,
        roles: {
          create: {
            roleId: clientRole.id,
            // tenantId removed here as it's not in the schema for UserRole
          },
        },
      },
    });
  }
}
