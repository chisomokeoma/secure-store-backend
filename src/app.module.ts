import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
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

@Module({
  imports: [PrismaModule, UsersModule, WarehousesModule, CommoditiesModule, ReceiptsModule, FinanciersModule, AuthModule, RolesModule, TenantsModule, WarehouseReceiptsModule, TransactionsModule, WithdrawalsModule, LoansModule, TradesModule, NotificationsModule, DashboardModule, ReportsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
