import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { WarehouseAuthService } from './warehouse-auth.service';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'supersecret',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, WarehouseAuthService, JwtStrategy],
  exports: [AuthService, WarehouseAuthService],
})
export class AuthModule {}
