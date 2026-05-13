# Analysis of Implementation Spec vs. Current Codebase

## 1. Architectural Discrepancies (Phase 0)

| Requirement | Spec (IMPLEMENTATION_SPEC.md) | Current Status |
| :--- | :--- | :--- |
| **Multi-Tenancy** | Requires `Tenant` model and `tenantId` on all business entities. | **Implemented.** Added to schema and auth. |
| **User-Role Link** | Requires explicit `UserRole` join table. | **Implemented.** Migrated from implicit relation. |
| **JWT Payload** | Must include `tenantId` and `roles` array. | **Implemented.** Updated AuthService and JwtStrategy. |
| **Tenant Scoping** | All queries must filter by `tenantId`. | **In Progress.** Dashboard is scoped; other services pending. |

## 2. Model & Enum Discrepancies (Phase 1)

The following models and enums were missing but have now been added to `schema.prisma`:
- **Models**: `Tenant`, `GradingParameter`, `StorageFeePolicy`, `WarehouseManagerAssignment`.
- **Enums**: `GradingLogic`, `FeeType`, `BillingFrequency`, `WarehouseStatus`, `UserStatus`.

## 3. Dashboard Module — Full Data Coverage (Phases 3.1 & 3.2)

> All dashboard endpoints are tenant-scoped via the JWT `tenantId` claim. Every query filters by `tenantId` so data is fully isolated per tenant.

### 3.1 — General Endpoints (All Authenticated Users)

| Endpoint | Method | Guard | Handler | Data Source | Response Shape |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/dashboard/summary` | `GET` | `TENANT_ADMIN` / `GLOBAL_ADMIN` | `getSummary()` | `Warehouse`, `User` (role=CLIENT), `Receipt` (ACTIVE/PLEDGED/LIEN), `Withdrawal` (PAID_PENDING_APPROVAL) — **totals + 2-month deltas** | `DashboardSummaryDto` |
| `/dashboard/commodity-breakdown` | `GET` | JWT | `getCommodityBreakdown()` | `Receipt.groupBy(commodityId)` → joins `Commodity` | `CommodityBreakdownDto[]` |
| `/dashboard/activity-trend?range=` | `GET` | JWT | `getActivityTrend()` | `Receipt` + `Withdrawal` aggregated by date | `ActivityTrendDto[]` |
| `/dashboard/recent-activities` | `GET` | JWT | `getRecentActivities()` | `Receipt`, `Withdrawal`, `Loan`, `Trade` (latest 5 each, sorted by `createdAt`) | `RecentActivityDto[]` |

### 3.2 — Summary Stat Details (`DashboardSummaryDto`)

| Field | DB Source | Logic | UI Label |
| :--- | :--- | :--- | :--- |
| `totalWarehouses` | `warehouse.count` | All warehouses for tenant | Main number |
| `warehousesDelta` | `warehouse.count(createdAt ≥ 2mo ago)` | Warehouses added in last 2 months | `+N registered last 2 months` |
| `totalClients` | `user.count` (role=CLIENT) | All clients for tenant | Main number |
| `clientsDelta` | `user.count(createdAt ≥ 2mo ago)` | Clients registered in last 2 months | `+N registered last 2 months` |
| `totalCommodity` | `receipt._sum(quantityAvailable)` | Sum across ACTIVE, PLEDGED, LIEN receipts | Main number |
| `commodityDelta` | `receipt._sum(quantityAvailable, createdAt ≥ 2mo ago)` | Commodity collected in last 2 months | `+N collected last 2 months` |
| `pendingRequests` | `withdrawal.count` (PAID_PENDING_APPROVAL) | All pending requests | Main number |
| `pendingRequestsDelta` | `withdrawal.count(createdAt ≥ 2mo ago)` | New pending requests in last 2 months | `+N request last 2 months` |

### 3.3 — Activity Trend (`ActivityTrendDto`)

| Field | Description |
| :--- | :--- |
| `date` | ISO date string (YYYY-MM-DD), day-level granularity |
| `deposits` | Sum of `receipt.quantity` for that day |
| `withdrawals` | Sum of `withdrawal.quantity` for that day |
| `activityCount` | `deposits + withdrawals` (total throughput) |

**Supported ranges:** `7d` · `1m` · `6m` (default) · `1y`

### 3.4 — Recent Activities Feed (`RecentActivityDto`)

The unified feed merges 4 data sources, takes the top 5 from each, sorts all by `createdAt` descending, and returns the latest **10 items**.

| `ActivityType` | DB Model | `title` | `description` Pattern | `reference` |
| :--- | :--- | :--- | :--- | :--- |
| `DEPOSIT` | `Receipt` | "New Deposit" | `New deposit: {qty} {commodity}` | `receiptNumber` |
| `WITHDRAWAL` | `Withdrawal` | "Withdrawal Request" | `Withdrawal of {qty} {commodity} requested` | `reference` |
| `LOAN` | `Loan` | "Loan Approved" | `Loan of {amount} {currency} approved` | `reference` |
| `TRADE` | `Trade` | "Trade Settled" | `Trade for {qty} {commodity} completed` | `reference` |

### 3.5 — Drill-down Endpoints (Admin Only: `TENANT_ADMIN` / `GLOBAL_ADMIN`)

| Endpoint | Handler | Data Sources | Response |
| :--- | :--- | :--- | :--- |
| `GET /dashboard/clients/:id/summary` | `getClientDrilldown()` | `Receipt._sum(quantityAvailable)`, `Loan` (ACTIVE), `Receipt` (last 10) | Client profile + stock total + loan summary + recent receipts |
| `GET /dashboard/commodities/:id/summary` | `getCommodityDrilldown()` | `Receipt.groupBy(warehouseId)`, `Receipt.groupBy(grade)` | Commodity info + distribution by warehouse + distribution by grade |

#### Client Drill-down Response Shape
```json
{
  "client": { "id", "name", "email" },
  "summary": { "totalStock", "activeLoansCount", "totalLoanAmount" },
  "recentReceipts": [{ "id", "number", "commodity", "quantity", "status", "date" }]
}
```

#### Commodity Drill-down Response Shape
```json
{
  "commodity": { "id", "name", "unit" },
  "distributionByWarehouse": [{ "warehouse", "quantity" }],
  "distributionByGrade": [{ "grade", "quantity" }]
}
```

## 4. Observations
The system is now "Multi-Tenant ready" at the database and authentication levels. All dashboard endpoints are fully implemented with real database queries — no mock/placeholder data. The remaining work involves ensuring the individual CRUD services consistently respect the `tenantId` context provided by the JWT across all modules.
