import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/users.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      contactEmail: user.contactEmail,
      phoneNumber: user.phoneNumber,
      status: user.status,
      roles: user.roles.map((ur) => ur.role.name),
    };
  }

  async updateMe(dto: UpdateProfileDto, userId: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
      include: { roles: { include: { role: true } } },
    });
    return {
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      contactEmail: updated.contactEmail,
      phoneNumber: updated.phoneNumber,
      roles: updated.roles.map((ur) => ur.role.name),
    };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    if (!currentPassword || !newPassword) {
      throw new BadRequestException(
        'currentPassword and newPassword are required',
      );
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (newPassword === currentPassword) {
      throw new BadRequestException(
        'New password must be different from the current password',
      );
    }
    const strong = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
    if (!strong.test(newPassword)) {
      throw new BadRequestException(
        'New password must be at least 8 characters with uppercase, lowercase, and digit',
      );
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashed },
    });
    return { success: true, message: 'Password changed successfully' };
  }

  async getPreferences(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const prefs = (user.notificationPrefs as Record<string, boolean>) ?? {};
    return {
      emailNotifications: prefs.email ?? true,
      smsNotifications: prefs.sms ?? false,
      inAppNotifications: prefs.inApp ?? true,
    };
  }

  async updatePreferences(
    userId: string,
    body: { emailNotifications?: boolean; smsNotifications?: boolean; inAppNotifications?: boolean },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const current = (user.notificationPrefs as Record<string, boolean>) ?? {};
    const updated = {
      ...current,
      ...(body.emailNotifications !== undefined && { email: body.emailNotifications }),
      ...(body.smsNotifications !== undefined && { sms: body.smsNotifications }),
      ...(body.inAppNotifications !== undefined && { inApp: body.inAppNotifications }),
    };
    await this.prisma.user.update({
      where: { id: userId },
      data: { notificationPrefs: updated },
    });
    return {
      emailNotifications: updated.email ?? true,
      smsNotifications: updated.sms ?? false,
      inAppNotifications: updated.inApp ?? true,
    };
  }
}
