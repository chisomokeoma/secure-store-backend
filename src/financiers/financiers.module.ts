import { Module } from '@nestjs/common';
import { FinanciersController } from './financiers.controller';
import { FinanciersService } from './financiers.service';

@Module({
  controllers: [FinanciersController],
  providers: [FinanciersService]
})
export class FinanciersModule {}
