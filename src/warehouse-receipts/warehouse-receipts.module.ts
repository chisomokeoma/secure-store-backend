import { Module } from '@nestjs/common';
import { WarehouseReceiptsController } from './warehouse-receipts.controller';
import { WarehouseReceiptsService } from './warehouse-receipts.service';

@Module({
  controllers: [WarehouseReceiptsController],
  providers: [WarehouseReceiptsService]
})
export class WarehouseReceiptsModule {}
