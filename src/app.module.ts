import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { FinancierOrgsModule } from './financier-orgs/financier-orgs.module';
import { FinancierModule } from './financier/financier.module';
import { WarehouseLinksModule } from './warehouse-links/warehouse-links.module';
import { CommodityPricesModule } from './commodity-prices/commodity-prices.module';
import { PledgesModule } from './pledges/pledges.module';
import { LiensModule } from './liens/liens.module';
import { ReleaseRequestsModule } from './release-requests/release-requests.module';
import { AdminLiensModule } from './admin-liens/admin-liens.module';
import { UsersModule } from './users/users.module';
import { WarehousesModule } from './warehouses/warehouses.module';
import { CommoditiesModule } from './commodities/commodities.module';
import { ReceiptsModule } from './receipts/receipts.module';
import { FinanciersModule } from './financiers/financiers.module';
import { AuthModule } from './auth/auth.module';
import { RolesModule } from './roles/roles.module';
import { TenantsModule } from './tenants/tenants.module';
import { WarehouseReceiptsModule } from './warehouse-receipts/warehouse-receipts.module';
import { TransactionsModule } from './transactions/transactions.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { LoansModule } from './loans/loans.module';
import { TradesModule } from './trades/trades.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ReportsModule } from './reports/reports.module';
import { AdminModule } from './admin/admin.module';
import { AdminTenantsModule } from './admin-tenants/admin-tenants.module';
import { AdminOverviewModule } from './admin-overview/admin-overview.module';
import { AdminUsersModule } from './admin-users/admin-users.module';
import { ManagersModule } from './managers/managers.module';
import { GradingModule } from './grading/grading.module';
import { StorageFeesModule } from './storage-fees/storage-fees.module';
import { MeModule } from './me/me.module';
import { InventoryModule } from './inventory/inventory.module';
import { WarehouseManagerModule } from './warehouse-manager/warehouse-manager.module';
import { ReferenceModule } from './reference/reference.module';
import { EmailModule } from './email/email.module';
import { SecurityModule } from './security/security.module';
import { StorageModule } from './storage/storage.module';

// Default BullMQ connection used by every queue in the app. Hostname/port
// come from REDIS_URL (see .env). Defining it at the root keeps every
// module's queue registration trivial — they only need to name the queue.
@Module({
  imports: [
    // In-process cron / interval / timeout scheduler. Used by background
    // cleanup tasks (e.g. WithdrawalsCleanupService). Add one decorator
    // and the framework wires it up; no extra infra beyond the running
    // Nest process. If we ever want distributed scheduling we'd promote
    // to BullMQ repeat jobs, but @nestjs/schedule fits the volume here.
    ScheduleModule.forRoot(),
    BullModule.forRoot({
      connection: (() => {
        const raw = process.env.REDIS_URL ?? 'redis://localhost:6379';
        const u = new URL(raw);
        return {
          host: u.hostname,
          port: Number(u.port || 6379),
          ...(u.password ? { password: u.password } : {}),
          ...(u.username && u.username !== 'default'
            ? { username: u.username }
            : {}),
        };
      })(),
    }),
    PrismaModule,
    UsersModule,
    WarehousesModule,
    CommoditiesModule,
    ReceiptsModule,
    FinanciersModule,
    AuthModule,
    RolesModule,
    TenantsModule,
    WarehouseReceiptsModule,
    TransactionsModule,
    WithdrawalsModule,
    LoansModule,
    TradesModule,
    NotificationsModule,
    DashboardModule,
    ReportsModule,
    AdminModule,
    AdminTenantsModule,
    AdminOverviewModule,
    AdminUsersModule,
    ManagersModule,
    GradingModule,
    StorageFeesModule,
    MeModule,
    InventoryModule,
    WarehouseManagerModule,
    ReferenceModule,
    EmailModule,
    SecurityModule,
    StorageModule,
    FinancierOrgsModule,
    FinancierModule,
    WarehouseLinksModule,
    CommodityPricesModule,
    PledgesModule,
    LiensModule,
    ReleaseRequestsModule,
    AdminLiensModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
