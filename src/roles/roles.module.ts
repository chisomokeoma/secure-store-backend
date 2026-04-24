import { Module } from '@nestjs/common';
import { RolesService } from './roles.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RolesController } from './roles.controller';

@Module({
  imports: [PrismaModule],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
