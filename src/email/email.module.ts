import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EmailService } from './email.service';
import { EmailProcessor } from './email.processor';
import { EmailController } from './email.controller';
import { EMAIL_QUEUE_NAME } from './email.types';

// @Global — every module that needs to send transactional email injects
// EmailService without listing this in its imports[]. Same pattern as
// NotificationsModule.
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: EMAIL_QUEUE_NAME })],
  controllers: [EmailController],
  providers: [EmailService, EmailProcessor],
  exports: [EmailService],
})
export class EmailModule {}
