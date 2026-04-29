// import { Injectable, OnModuleInit, NotFoundException } from '@nestjs/common';
// import { PrismaService } from '../prisma/prisma.service';
// import { AppRole } from './role.enum';

// @Injectable()
// export class RolesService implements OnModuleInit {
//   constructor(private readonly prisma: PrismaService) {}

//   async onModuleInit() {
//     await this.seedRoles();
//   }

//   private async seedRoles() {
//     const roles = Object.values(AppRole);

//     for (const roleName of roles) {
//       const exists = await this.prisma.role.findUnique({
//         where: { name: roleName },
//       });

//       if (!exists) {
//         await this.prisma.role.create({
//           data: {
//             name: roleName,
//             description: `System defined role for ${roleName}`
//           },
//         });
//       }
//     }
//   }

//   async assignRole(userId: string, roleName: AppRole) {
//     const role = await this.prisma.role.findUnique({
//       where: { name: roleName },
//     });

//     if (!role) {
//       throw new NotFoundException(`Role ${roleName} does not exist in the database`);
//     }

//     return this.prisma.user.update({
//       where: { id: userId },
//       data: { roleId: role.id },
//     });
//   }
// }
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async assignRole(userId: string, roleId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
    });
    if (!role) {
      throw new NotFoundException('Role not found');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        roles: {
          connect: { id: roleId },
        },
      },
      include: { roles: true },
    });
  }

  getRoles() {
    return this.prisma.role.findMany();
  }
}
