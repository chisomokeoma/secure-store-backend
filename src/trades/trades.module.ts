import { Module } from '@nestjs/common';
import { TradesController } from './trades.controller';
import { TradesService } from './trades.service';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryModule],
  controllers: [TradesController],
  providers: [TradesService],
  exports: [TradesService],
})
export class TradesModule {}
