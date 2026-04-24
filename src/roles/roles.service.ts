import { Injectable, OnModuleInit, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppRole } from './role.enum';

@Injectable()
export class RolesService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedRoles();
  }

  private async seedRoles() {
    const roles = Object.values(AppRole);

    for (const roleName of roles) {
      const exists = await this.prisma.role.findUnique({
        where: { name: roleName },
      });

      if (!exists) {
        await this.prisma.role.create({
          data: {
            name: roleName,
            description: `System defined role for ${roleName}`
          },
        });
      }
    }
  }

  async assignRole(userId: string, roleName: AppRole) {
    const role = await this.prisma.role.findUnique({
      where: { name: roleName },
    });

    if (!role) {
      throw new NotFoundException(`Role ${roleName} does not exist in the database`);
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { roleId: role.id },
    });
  }
}
