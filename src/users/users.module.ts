import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [UsersController],
  providers: [UsersService],
  // Export UsersService so MeModule (and any other module that wants the
  // canonical "update my own profile" code path) can inject it instead of
  // duplicating the validation + ClientProfile mirror logic.
  exports: [UsersService],
})
export class UsersModule {}
