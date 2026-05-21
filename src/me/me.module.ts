import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  imports: [InventoryModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
