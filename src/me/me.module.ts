import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { UsersModule } from '../users/users.module';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  // Import UsersModule so we can inject UsersService — `PATCH /me` now
  // delegates to UsersService.updateMe, which is the canonical
  // profile-update path with DTO validation, photo-URL whitelist check,
  // and ClientProfile mirroring all in one place.
  imports: [InventoryModule, UsersModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
