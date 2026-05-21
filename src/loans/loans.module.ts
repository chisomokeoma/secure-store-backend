import { Module } from '@nestjs/common';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryModule],
  controllers: [LoansController],
  providers: [LoansService],
  exports: [LoansService],
})
export class LoansModule {}
