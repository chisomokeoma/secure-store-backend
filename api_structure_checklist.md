# API Structure Modification Checklist

This checklist tracks the implementation of the API structure (Modules, Controllers, Services) as defined in the `SecureStore_Backend_Spec.md`.

## Modules to Scaffold
- [x] `tenants`
- [x] `warehouse-receipts`
- [x] `transactions`
- [x] `withdrawals`
- [x] `loans`
- [x] `trades`
- [x] `notifications`
- [x] `dashboard`
- [x] `reports`

## Endpoints Implementation
- [x] **Auth** (`/auth`)
  - [x] POST `/auth/login`
  - [x] POST `/auth/refresh`
  - [x] POST `/auth/logout`
  - [x] POST `/auth/forgot-password`
  - [x] POST `/auth/reset-password`
  - [x] GET `/auth/me`
- [x] **Dashboard** (`/dashboard`)
  - [x] GET `/dashboard/summary`
  - [x] GET `/dashboard/commodity-breakdown`
  - [x] GET `/dashboard/activity-trend`
  - [x] GET `/dashboard/system-status`
- [x] **Receipt Management** (`/receipts`)
  - [x] GET `/receipts`
  - [x] GET `/receipts/stats`
  - [x] GET `/receipts/:id`
  - [x] GET `/receipts/:id/pdf`
  - [x] GET `/receipts/:id/download`
- [x] **Commodity Management** (`/commodities`)
  - [x] GET `/commodities/mine`
  - [x] GET `/commodities/:id/overview`
  - [x] GET `/commodities/:id/receipts`
  - [x] GET `/commodities/:id/export`
- [x] **Withdrawals** (`/withdrawals`)
  - [x] GET `/withdrawals/eligible-receipts`
  - [x] GET `/withdrawals/receipts/:receiptId/prefill`
  - [x] POST `/withdrawals/calculate`
  - [x] POST `/withdrawals`
  - [x] POST `/withdrawals/:id/confirm-payment`
  - [x] GET `/withdrawals/:id`
  - [x] GET `/withdrawals/:id/summary.pdf`
- [x] **Loans** (`/loans`)
  - [x] GET `/loans/financiers`
  - [x] GET `/loans/pledgeable-receipts`
  - [x] POST `/loans/calculate`
  - [x] POST `/loans`
  - [x] GET `/loans/:id`
- [x] **Trades** (`/trades`)
  - [x] GET `/trades/listings`
  - [x] POST `/trades`
  - [x] GET `/trades/:id`
- [x] **Reports** (`/transactions`)
  - [x] GET `/transactions`
  - [x] GET `/transactions/:id`
  - [x] GET `/transactions/export`
- [x] **Settings** (`/users`)
  - [x] GET `/users/me`
  - [x] PATCH `/users/me`
  - [x] POST `/users/me/change-password`
  - [x] GET/PATCH `/users/me/preferences`
- [x] **Notifications** (`/notifications`)
  - [x] GET `/notifications`
  - [x] PATCH `/notifications/:id/read`
  - [x] PATCH `/notifications/mark-all-read`

## Database Schema & Seeding
- [x] Align Prisma Schema with Spec (Add missing fields/models)
- [x] Implement robust `prisma/seed.ts` script
- [x] Seed Tenants, Users, Warehouses, Commodities, Financiers, and Receipts

## Service Layer Business Logic Implementation
- [x] Implement PrismaModule globally
- [x] DashboardService (Metrics, Trends, Breakdowns)
- [x] ReceiptsService (Listing, Details, Stats)
- [x] CommoditiesService (Aggregating owned commodities from receipts)
- [x] WithdrawalsService (Fee calculations with WarehouseCommodities)
- [x] LoansService (Financiers fetching and Loan calculations)
- [x] TradesService (Trade listings derived from receipts)
- [x] TransactionsService (History and exporting)
- [x] UsersService (User profile fetching and updates)
- [x] NotificationsService (Mock notification delivery)
- [x] Wire all Controllers to their respective Services
