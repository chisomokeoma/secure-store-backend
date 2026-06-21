import { Global, Module } from '@nestjs/common';
import { SecurityService } from './security.service';

// @Global — every transaction service (withdrawals, loans, trades) and the
// /me + /manager controllers need to call SecurityService. Globalising it
// keeps the imports[] clean across all those modules.
@Global()
@Module({
  providers: [SecurityService],
  exports: [SecurityService],
})
export class SecurityModule {}
