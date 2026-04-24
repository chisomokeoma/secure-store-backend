import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/users.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getMe(userId?: string) {
    const user = await this.prisma.user.findFirst({
      where: userId ? { id: userId } : { email: 'demo@securestore.com' },
      include: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role?.name,
    };
  }

  async updateMe(dto: UpdateProfileDto, userId?: string) {
    const user = await this.prisma.user.findFirst({
      where: userId ? { id: userId } : { email: 'demo@securestore.com' },
    });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: dto,
      include: { role: true },
    });

    return {
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      role: updated.role?.name,
    };
  }
}
