import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class MeService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        middleName: true,
        phoneNumber: true,
        gender: true,
        dateOfBirth: true,
        residentialAddress: true,
        contactEmail: true,
        profilePhotoUrl: true,
        managerCode: true,
        status: true,
        permissions: true,
        notificationPrefs: true,
        createdAt: true,
        roles: { include: { role: { select: { name: true } } } },
      },
    });
  }

  async updateProfile(
    userId: string,
    dto: {
      firstName?: string;
      lastName?: string;
      middleName?: string;
      phoneNumber?: string;
      contactEmail?: string;
      profilePhotoUrl?: string;
    },
  ) {
    return this.prisma.user.update({
      where: { id: userId },
      data: dto,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        middleName: true,
        phoneNumber: true,
        contactEmail: true,
        profilePhotoUrl: true,
        updatedAt: true,
      },
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    if (!currentPassword || !newPassword) {
      throw new BadRequestException('currentPassword and newPassword are required');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    if (newPassword === currentPassword) {
      throw new BadRequestException('New password must be different from the current password');
    }

    // Minimum 8 chars, uppercase, lowercase, digit
    const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
    if (!strongPassword.test(newPassword)) {
      throw new BadRequestException(
        'New password must be at least 8 characters with at least one uppercase letter, one lowercase letter, and one digit',
      );
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hashed } });

    return { message: 'Password changed successfully' };
  }

  async updateNotificationPrefs(
    userId: string,
    prefs: { email?: boolean; sms?: boolean; inApp?: boolean },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const current = (user.notificationPrefs as Record<string, boolean>) ?? {};
    const updated = { ...current, ...prefs };

    return this.prisma.user.update({
      where: { id: userId },
      data: { notificationPrefs: updated },
      select: { id: true, notificationPrefs: true },
    });
  }
}
