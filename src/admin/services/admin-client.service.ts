import { Injectable, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
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

  /** System-issued login: firstname.lastname@securestore.com (collision-suffixed). */
  private async deriveLoginEmail(
    firstName: string,
    lastName: string,
  ): Promise<string> {
    const base = `${firstName}.${lastName}`.toLowerCase().replace(/\s+/g, '');
    const domain = 'securestore.com';
    for (const cand of [
      `${base}@${domain}`,
      ...Array.from({ length: 98 }, (_, i) => `${base}${i + 2}@${domain}`),
    ]) {
      if (!(await this.prisma.user.findUnique({ where: { email: cand } })))
        return cand;
    }
    throw new BadRequestException('Cannot generate a unique login email');
  }

  async createClient(
    tenantId: string,
    dto: {
      email?: string;
      firstName: string;
      lastName: string;
      password?: string;
    },
  ) {
    const clientRole = await this.prisma.role.findUnique({
      where: { name: 'CLIENT' },
    });
    if (!clientRole) throw new BadRequestException('CLIENT role not found');

    // Login email is ALWAYS @securestore.com; any provided email is contact-only.
    const loginEmail = await this.deriveLoginEmail(
      dto.firstName,
      dto.lastName,
    );
    const passwordHash = await bcrypt.hash(dto.password || 'ChangeMe123!', 10);

    return this.prisma.user.create({
      data: {
        email: loginEmail,
        contactEmail: dto.email ?? null,
        firstName: dto.firstName,
        lastName: dto.lastName,
        password: passwordHash,
        tenantId,
        status: UserStatus.ACTIVE,
        roles: {
          create: {
            roleId: clientRole.id,
          },
        },
      },
    });
  }
}
