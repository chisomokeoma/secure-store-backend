import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

// @Global so every domain module (warehouse-manager, withdrawals, loans,
// trades, admin) can inject NotificationsService without listing this in
// their imports[]. There's no per-module config we'd want overridden.
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
