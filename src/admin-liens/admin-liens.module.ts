import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminLiensService } from './admin-liens.service';
import { AdminLiensController } from './admin-liens.controller';

@Module({
  imports: [PrismaModule, InventoryModule, NotificationsModule],
  controllers: [AdminLiensController],
  providers: [AdminLiensService],
  exports: [AdminLiensService],
})
export class AdminLiensModule {}
