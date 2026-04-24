import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getMe(userId?: string) {
    const email = userId ? undefined : 'demo@securestore.com';
    const user = await this.prisma.user.findFirst({
        where: userId ? { id: userId } : { email }
    });
    if (!user) throw new NotFoundException('User not found');
    
    return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        roleId: user.roleId
    };
  }

  async updateMe(dto: any, userId?: string) {
    const email = userId ? undefined : 'demo@securestore.com';
    const user = await this.prisma.user.findFirst({ where: userId ? { id: userId } : { email } });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: dto
    });
    
    return {
        id: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
        roleId: updated.roleId
    };
  }
}