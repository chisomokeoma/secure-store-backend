import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) { }

  async login(email: string, password: string) {
    // 1. Find user by email — include roles
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { roles: true },
    });
    if (!user) throw new BadRequestException('Invalid email or password');

    // 2. Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) throw new BadRequestException('Invalid email or password');

    // 3. Extract role data
    const roleNames = user.roles.map((r) => r.name);
    const rolesDetail = user.roles.map((r) => ({ id: r.id, name: r.name }));

    // 4. Generate JWT token
    const token = this.jwt.sign({
      sub: user.id,
      email: user.email,
      roles: roleNames,
    });

    return {
      access_token: token,
      user: {
        id: user.id,
        email: user.email,
        roles: rolesDetail,
      },
    };
  }
}
