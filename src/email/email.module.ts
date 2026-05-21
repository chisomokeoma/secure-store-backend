import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';

// @Global — every module that needs to send transactional email can inject
// EmailService without listing this in its imports[]. Same pattern as
// NotificationsModule.
@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
