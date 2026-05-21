import { Module } from '@nestjs/common';
import { WarehouseManagerModule } from '../warehouse-manager/warehouse-manager.module';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [WarehouseManagerModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
