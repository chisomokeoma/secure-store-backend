import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FinancierOrgsController } from './financier-orgs.controller';
import { FinancierOrgsService } from './financier-orgs.service';

/**
 * TA-facing management of FinancierOrgs. EmailModule is @Global so it's
 * injectable here without listing in imports; NotificationsModule needs
 * the explicit import.
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [FinancierOrgsController],
  providers: [FinancierOrgsService],
  exports: [FinancierOrgsService],
})
export class FinancierOrgsModule {}
