# SecureStore Backend — Tenant Admin Module

> Implementation spec for the Tenant Admin role, plus carry-over hardening from Phase 1 (Client).

## Context for the implementer

Phase 1 (Client role) is live: receipts, withdrawals, loans, trades, atomic transactions, and receipt lineage are all functional. This phase builds the **Tenant Admin** layer that sits above the client.

The system is **multi-tenant**: a tenant admin owns one or more warehouses, the managers within them, and the clients those managers serve. Today the codebase has no tenant scoping — every authenticated user can see every record. Adding tenant scoping is the most important architectural change in this phase. Every read and most writes must filter by the requesting user's tenant.

Read this whole document before writing code. The phases are ordered by dependency, not priority.

### Decisions already made

These came up during planning — don't re-debate them, just implement:

1. **A warehouse manager can be assigned to multiple warehouses.** The relation is many-to-many via a join table, not a single `managerId` foreign key on Warehouse.
2. **No public tenant signup.** `GLOBAL_ADMIN` creates tenants out-of-band. For now, the existing seeded `demo@securestore.com` user gets the `TENANT_ADMIN` role added (in addition to `CLIENT`) so we can develop and test without standing up a separate user.
3. **Approval rules engine deferred.** Skip `/admin/approval-rules` entirely. We'll revisit when business rules are concrete.
4. **Bag-count storage.** Quantity is always stored in the commodity's declared unit (KG, LITRE, METRIC_TON, BAG, UNIT, METER). The fee resolver converts to whatever unit the policy requires. No separate `bagCount` column.

### Roles & permissions matrix

| Action | Global Admin | Tenant Admin | Warehouse Manager | Client |
|---|---|---|---|---|
| Create tenant | ✓ | — | — | — |
| Create warehouse | — | ✓ | — | — |
| Create warehouse manager | — | ✓ | — | — |
| Create commodity & grading | — | ✓ | — | — |
| Create storage fee policy | — | ✓ | — | — |
| Approve/reject receipt | — | ✓ | — | — |
| Approve/reject withdrawal | — | ✓ | — | — |
| Issue receipt (deposit) | — | — | ✓ | — |
| Dispatch withdrawal | — | — | ✓ | — |
| Request withdrawal | — | — | — | ✓ |
| Pledge for loan | — | — | — | ✓ |
| List for trade | — | — | — | ✓ |

Tenant Admin sees everything in their tenant. Warehouse Manager sees only their assigned warehouses. Client sees only their own receipts.

---

## Phase 0 — Foundation (must come first)

These are carry-overs from Phase 1 plus the multi-tenancy substrate. Don't start any role-specific work until this is done — every Tenant Admin endpoint depends on at least the tenant-scoping piece.

### 0.1 Multi-tenancy

Add a `Tenant` model and a `tenantId` foreign key on every business entity (`User`, `Warehouse`, `Commodity`, `Receipt`, `Withdrawal`, `Loan`, `Trade`, `Financier`, `WarehouseCommodity`, `GradingParameter`, `StorageFeePolicy`).

```prisma
model Tenant {
  id        String   @id @default(uuid())
  name      String   @unique
  slug      String   @unique
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  users        User[]
  warehouses   Warehouse[]
  commodities  Commodity[]
  // ...back-relations on every tenant-scoped model

  @@map("tenants")
}
```

Every tenant-scoped model gets:

```prisma
tenantId String @map("tenant_id")
tenant   Tenant @relation(fields: [tenantId], references: [id])

@@index([tenantId])
```

**Service layer**: every Prisma query gets `where: { tenantId: req.user.tenantId, ...rest }`. The cleanest pattern is a `TenantScopedPrismaService` that wraps PrismaClient and auto-injects the tenant filter. If that's too much refactoring right now, the minimum bar is: every `findMany`, `findFirst`, `findUnique`, `update`, and `delete` includes `tenantId` in the `where` clause — no exceptions.

`GLOBAL_ADMIN` is the one role that bypasses tenant scoping (used for cross-tenant admin operations).

### 0.2 JWT hardening

In `src/auth/auth.service.ts`:

```ts
const token = this.jwt.sign(
  {
    sub: user.id,
    email: user.email,
    roles: user.roles.map(r => r.name),  // ← array, not single
    tenantId: user.tenantId,             // ← new
  },
  { expiresIn: '24h' },                  // ← was missing
);
```

Add a refresh-token endpoint (`POST /auth/refresh`) that issues a new access token from a long-lived refresh token. Store refresh tokens in a `RefreshToken` model with `userId`, `tokenHash` (bcrypt-hashed, never raw), `expiresAt`, `revokedAt`. Refresh tokens last 30 days; access tokens 24h.

Rotate `JWT_SECRET` on Render: `openssl rand -hex 64` → set new value in env vars → all existing tokens invalidated (everyone re-logs in once).

### 0.3 Multi-role support

The demo user needs both `CLIENT` and `TENANT_ADMIN` roles. Switch User → Role to many-to-many via `UserRole` join table:

```prisma
model UserRole {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  user      User     @relation(fields: [userId], references: [id])
  roleId    String   @map("role_id")
  role      Role     @relation(fields: [roleId], references: [id])
  createdAt DateTime @default(now()) @map("created_at")

  @@unique([userId, roleId])
  @@map("user_roles")
}

model User {
  // remove: roleId, role
  // add:
  roles UserRole[]
}

model Role {
  // existing fields...
  users UserRole[]
}
```

JWT carries `roles: string[]`. The auth service includes `{ roles: { include: { role: true } } }` on the user lookup and maps to names.

### 0.4 Role-based guards

Create a `RolesGuard` and a `@Roles(...)` decorator:

```ts
@Roles('TENANT_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Post('warehouses')
createWarehouse(...) {}
```

Roles already exist as table rows from Phase 1: `GLOBAL_ADMIN`, `TENANT_ADMIN`, `WAREHOUSE_MANAGER`, `FINANCIER`, `CLIENT`. The guard reads `req.user.roles` (set by `JwtStrategy.validate`) and checks intersection with the decorator's allowlist.

### 0.5 Pull `clientId` / `tenantId` from JWT, not query params

Remove all the `clientId?: string` parameters and the demo-user fallback in services. Read identity from `req.user` only. The current pattern:

```ts
const user = clientId
  ? { id: clientId }
  : await this.prisma.user.findFirst({ where: { email: 'demo@securestore.com' } });
```

…becomes simply: `req.user.id`. This is a security hole right now — anyone can pass any `clientId` and act as that user.

### 0.6 Rate limiting on auth endpoints

```bash
npm install @nestjs/throttler
```

Apply `ThrottlerGuard` globally with stricter limits on `/auth/login` (5 attempts per minute per IP) and `/auth/refresh` (10/min). Without this, login is brute-forceable.

### 0.7 Input validation gaps

Audit every DTO. Several Phase 1 DTOs use `@IsString()` for fields that should be `@IsUUID()`, no `@IsPositive()` on quantities, no `@MaxLength` on free-text fields. Tighten all of them — then enable `forbidNonWhitelisted: true` on the global `ValidationPipe` so unknown fields throw 400 instead of being silently dropped.

### 0.8 Env vars to add on Render

| Key | Value | Purpose |
|---|---|---|
| `JWT_REFRESH_SECRET` | `openssl rand -hex 64` | Separate secret for refresh tokens |
| `JWT_ACCESS_EXPIRY` | `24h` | Access token lifetime |
| `JWT_REFRESH_EXPIRY` | `30d` | Refresh token lifetime |
| `THROTTLE_TTL` | `60` | Rate limit window in seconds |
| `THROTTLE_LIMIT` | `100` | Default requests per window |
| `TEMP_PASSWORD_LENGTH` | `12` | Length of generated temporary passwords |

---

## Phase 1 — Schema additions for Tenant Admin

```prisma
enum GradingLogic {
  PERCENTAGE
  SCORE
  PASS_FAIL
}

enum FeeType {
  PER_MT_PER_MONTH
  PER_BAG_PER_WEEK
  PER_MT_PER_DAY
  FLAT_RATE
}

enum BillingFrequency {
  DAILY
  WEEKLY
  MONTHLY
  QUARTERLY
  ANNUALLY
}

enum WarehouseStatus {
  ACTIVE
  INACTIVE
  MAINTENANCE
}

enum UserStatus {
  ACTIVE
  INACTIVE
  SUSPENDED
  DEACTIVATED
}

model Commodity {
  // existing fields...
  gradingLogic        GradingLogic @default(PERCENTAGE) @map("grading_logic")
  numberOfGrades      Int          @default(3) @map("number_of_grades")
  code                String?      @unique  // human-readable, e.g. "MAIZE-001"
  standardBagWeightKg Float?       @map("standard_bag_weight_kg")  // for PER_BAG fees

  gradingParameters GradingParameter[]
}

model GradingParameter {
  id           String    @id @default(uuid())
  tenantId     String    @map("tenant_id")
  tenant       Tenant    @relation(fields: [tenantId], references: [id])
  commodityId  String    @map("commodity_id")
  commodity    Commodity @relation(fields: [commodityId], references: [id])

  name         String     // "Foreign Matter", "Moisture", etc.
  unit         String     // "%", "ppb", "Nil"
  isDefective  Boolean    @default(false) @map("is_defective")
  thresholds   Json       // { "Grade 1": 0.5, "Grade 2": 1.0, "Grade 3": 1.5 }

  createdAt    DateTime   @default(now()) @map("created_at")
  updatedAt    DateTime   @updatedAt @map("updated_at")

  @@unique([commodityId, name])
  @@index([tenantId])
  @@index([commodityId])
  @@map("grading_parameters")
}

model StorageFeePolicy {
  id               String           @id @default(uuid())
  tenantId         String           @map("tenant_id")
  tenant           Tenant           @relation(fields: [tenantId], references: [id])
  warehouseId      String?          @map("warehouse_id")  // null = applies to all warehouses
  warehouse        Warehouse?       @relation(fields: [warehouseId], references: [id])
  commodityId      String?          @map("commodity_id")  // null = applies to all commodities
  commodity        Commodity?       @relation(fields: [commodityId], references: [id])

  feeType          FeeType          @map("fee_type")
  rate             Float
  billingFrequency BillingFrequency @map("billing_frequency")
  gracePeriodDays  Int              @map("grace_period_days")  // 3, 7, 14, 30
  latePenaltyPct   Float            @map("late_penalty_pct")   // 1, 2, 3, 4, 5, 10
  currency         String           @default("NGN")

  isActive         Boolean          @default(true) @map("is_active")

  createdAt        DateTime         @default(now()) @map("created_at")
  updatedAt        DateTime         @updatedAt @map("updated_at")

  @@index([tenantId])
  @@index([warehouseId])
  @@index([commodityId])
  @@index([isActive])
  @@map("storage_fee_policies")
}

model Warehouse {
  // existing fields...
  code        String?          @unique @map("code")  // human-readable, e.g. "WHS-001"
  type        String?          // storage facility type — DRY_GOODS, COLD_STORAGE, etc.
  state       String?          // "Lagos State"
  capacityMt  Float?           @map("capacity_mt")
  status      WarehouseStatus  @default(ACTIVE)

  managerAssignments WarehouseManagerAssignment[]
  storageFeePolicies StorageFeePolicy[]
}

// Many-to-many: a manager can run multiple warehouses; a warehouse can have multiple managers.
model WarehouseManagerAssignment {
  id          String   @id @default(uuid())
  tenantId    String   @map("tenant_id")
  tenant      Tenant   @relation(fields: [tenantId], references: [id])
  warehouseId String   @map("warehouse_id")
  warehouse   Warehouse @relation(fields: [warehouseId], references: [id])
  managerId   String   @map("manager_id")
  manager     User     @relation("ManagerAssignments", fields: [managerId], references: [id])

  assignedAt   DateTime  @default(now()) @map("assigned_at")
  assignedBy   String    @map("assigned_by")  // userId of the tenant admin who made the assignment
  unassignedAt DateTime? @map("unassigned_at")

  @@unique([warehouseId, managerId])
  @@index([tenantId])
  @@index([managerId])
  @@map("warehouse_manager_assignments")
}

model User {
  // existing fields...
  phoneNumber        String?    @map("phone_number")
  middleName         String?    @map("middle_name")
  dateOfBirth        DateTime?  @map("date_of_birth")
  gender             String?
  residentialAddress String?    @map("residential_address")
  employmentDate     DateTime?  @map("employment_date")
  managerCode        String?    @unique @map("manager_code")  // "MNG-2025-001"
  profilePhotoUrl    String?    @map("profile_photo_url")
  contactEmail       String?    @map("contact_email")  // optional real inbox, separate from login email
  status             UserStatus @default(ACTIVE)
  permissions        Json?      // { manageClients: true, manageReceipts: true, viewReports: true, approveDeposit: true }
  notificationPrefs  Json?      @map("notification_prefs") // { email: true, sms: true, inApp: true }

  managerAssignments  WarehouseManagerAssignment[] @relation("ManagerAssignments")
  approvedReceipts    Receipt[]    @relation("ReceiptApprover")
  approvedWithdrawals Withdrawal[] @relation("WithdrawalApprover")
}

model Receipt {
  // existing fields...
  approvalStatus       String?   @default("PENDING") @map("approval_status")
  // PENDING | APPROVED | REJECTED — for the tenant-admin approval flow
  approvedById         String?   @map("approved_by_id")
  approvedBy           User?     @relation("ReceiptApprover", fields: [approvedById], references: [id])
  approvedAt           DateTime? @map("approved_at")
  rejectionReason      String?   @map("rejection_reason")

  gradingScores        Json?     @map("grading_scores")
  // { "Foreign Matter": 0.3, "Moisture": 12, ... } — populated at deposit time
  computedGrade        String?   @map("computed_grade")
  totalDefectivePct    Float?    @map("total_defective_pct")
  standardDeductionPct Float?    @map("standard_deduction_pct")
}

model Withdrawal {
  // existing fields...
  approvedById    String?   @map("approved_by_id")
  approvedBy      User?     @relation("WithdrawalApprover", fields: [approvedById], references: [id])
  approvedAt      DateTime? @map("approved_at")
  rejectionReason String?   @map("rejection_reason")
  feesBilledAt    DateTime? @map("fees_billed_at")  // null until completion — see §6.1
  currency        String    @default("NGN")
}

model Loan {
  // existing fields...
  currency String @default("NGN")
}

model Trade {
  // existing fields...
  currency String @default("NGN")
}
```

Run after schema is in place:

```bash
npx prisma migrate dev --name tenant_admin_module
npx prisma generate
```

---

## Phase 2 — Module structure

```
src/
  tenants/
    tenants.module.ts
    tenants.controller.ts
    tenants.service.ts
    dto/tenant.dto.ts
  managers/
    managers.module.ts
    managers.controller.ts
    managers.service.ts
    dto/manager.dto.ts
  warehouses/                    ← already exists, extend
    ...
  commodities/                   ← already exists, extend
    ...
  grading/
    grading.module.ts            ← new
    grading.controller.ts
    grading.service.ts
    grading.scorer.ts            ← pure function, easy to unit-test
    dto/grading.dto.ts
  storage-fees/
    storage-fees.module.ts       ← new
    storage-fees.controller.ts
    storage-fees.service.ts
    storage-fees.resolver.ts     ← lookup logic, used by withdrawals
    dto/storage-fee.dto.ts
  approvals/
    approvals.module.ts          ← new (just receipt + withdrawal approvals for now)
    approvals.controller.ts
    approvals.service.ts
    dto/approval.dto.ts
  notifications/
    notifications.module.ts      ← new
    notifications.controller.ts
    notifications.service.ts     ← exposes notify() / notifyMany()
    dto/notification.dto.ts
```

---

## Phase 3 — Tenant Admin endpoints

All require `@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')` and JWT auth. All routes mounted under `/store/v1/admin/*`.

### 3.1 Dashboard

```
GET  /store/v1/admin/dashboard/summary
GET  /store/v1/admin/dashboard/recent-activities?limit=10
```

`/summary` returns:

```json
{
  "totalWarehouses": 102,
  "totalClients": 255,
  "totalCommodity": { "value": 4556, "unit": "METRIC_TON" },
  "pendingRequests": 23
}
```

`pendingRequests` = receipts with `approvalStatus = PENDING` + withdrawals with `status = PAID_PENDING_APPROVAL`. Both counts are tenant-scoped.

`/recent-activities` aggregates the last N events across receipts created, withdrawals completed, loans approved, trades settled, etc. — same unified-feed pattern as the existing `/transactions` endpoint, but unfiltered by type.

### 3.2 Managers

```
GET    /store/v1/admin/managers?status=&search=&page=&limit=
GET    /store/v1/admin/managers/:id
GET    /store/v1/admin/managers/:id/clients?status=&page=&limit=
GET    /store/v1/admin/managers/:id/warehouses
POST   /store/v1/admin/managers
PATCH  /store/v1/admin/managers/:id
POST   /store/v1/admin/managers/:id/deactivate
POST   /store/v1/admin/managers/:id/activate
POST   /store/v1/admin/managers/:id/suspend
POST   /store/v1/admin/managers/:id/assign-warehouses
DELETE /store/v1/admin/managers/:id/warehouses/:warehouseId
POST   /store/v1/admin/managers/:id/reset-password
```

`POST /admin/managers` body:

```json
{
  "personalInfo": {
    "firstName": "Amina",
    "middleName": "...",
    "lastName": "Bello",
    "gender": "FEMALE",
    "dateOfBirth": "1990-01-01",
    "residentialAddress": "...",
    "phoneNumber": "+234...",
    "contactEmail": "amina.bello@gmail.com",
    "employmentDate": "2025-01-01",
    "profilePhotoUrl": "..."
  },
  "accountSetup": {
    "permissions": {
      "manageClients": true,
      "manageReceipts": true,
      "viewReports": true,
      "approveDeposit": true
    },
    "notificationPrefs": { "email": true, "sms": true, "inApp": true }
  },
  "warehouseIds": ["...", "..."]
}
```

`contactEmail` is optional and stored separately from the login email — useful for sending welcome emails or password-reset links to a real inbox the manager actually checks. The login email (`firstName.lastName@securestore.com`) is platform-internal and may not have a real mailbox behind it.

**Email and password are server-handled, not free-form.** The email follows the platform convention `firstname.lastname@securestore.com` (lowercase, dots between name parts, with a numeric suffix on collision: `amina.bello@securestore.com`, `amina.bello2@securestore.com`...). The `email` field in `personalInfo` above is **derived server-side** from `firstName` + `lastName`, not accepted from the request — strip it from the DTO. If the admin needs a contact email different from the login email, store it in a separate `contactEmail` column on User (optional field).

The temporary password is a 12-character random string with mixed case, digits, and one symbol — generated via `crypto.randomBytes`, never reused, never logged. Bcrypt-hashed before storage. `managerCode` (`MNG-2025-XXXX`) is also auto-generated server-side.

**Password change is user-initiated, not forced.** The manager logs in with the temp password and can keep using it indefinitely. When they want to change it, they go to Settings → Change Password (existing endpoint or new — see §3.9). No `mustChangePassword` flag, no first-login interception, no UI gate.

The whole creation runs in `prisma.$transaction`: user row, role assignment (UserRole join row with `WAREHOUSE_MANAGER`), warehouse-manager assignments, all succeed together or all roll back.

#### Response — credentials returned ONCE

```json
{
  "manager": {
    "id": "...",
    "managerCode": "MNG-2025-0001",
    "firstName": "Amina",
    "lastName": "Bello",
    "email": "amina.bello@securestore.com",
    "status": "ACTIVE",
    "assignedWarehouses": [ { "id": "...", "name": "Kano Central Depot" } ]
  },
  "credentials": {
    "email": "amina.bello@securestore.com",
    "temporaryPassword": "Xk7$mP2nR9qL",
    "loginUrl": "https://secure-store-indol.vercel.app/sign-in"
  }
}
```

**Critical** — this is the **only** time the plaintext password is returned. The frontend should display it on a one-time confirmation screen ("Copy these credentials and share them with the manager — you won't see this password again"). After this response is sent, only the bcrypt hash exists in the DB.

If the manager has `notificationPrefs.email: true`, the system also fires a "Welcome — your account has been created" notification (see Phase 4.5). The plaintext password is **not** emailed in this phase since email delivery isn't wired yet — the admin manually shares the temp password through their own channel.

`POST /admin/managers/:id/assign-warehouses` body:

```json
{ "warehouseIds": ["...", "..."] }
```

Additive: creates `WarehouseManagerAssignment` rows for any warehouseIds not already assigned. Idempotent. Use `DELETE /managers/:id/warehouses/:warehouseId` to remove one (sets `unassignedAt = now()`, doesn't hard-delete — preserves history).

`POST /admin/managers/:id/reset-password` — generates a fresh temporary password, returns the plaintext password once in the same shape as the create-manager response (just the `credentials` block). Use case: manager forgot their password, or admin needs to reset a compromised account. No request body required. The previous password hash is overwritten.

`GET /admin/managers/:id/clients` — list of clients whose receipts live in any warehouse this manager currently manages. Clients aren't directly assigned to managers; the relationship is transitive through receipts → warehouses → managers. Query:

```sql
-- conceptual
SELECT DISTINCT u.* FROM users u
JOIN receipts r ON r.client_id = u.id
JOIN warehouse_manager_assignments wma ON wma.warehouse_id = r.warehouse_id
WHERE wma.manager_id = :managerId
  AND wma.unassigned_at IS NULL
  AND u.tenant_id = :tenantId
```

### 3.3 Warehouses

```
GET    /store/v1/admin/warehouses?status=&search=&page=&limit=
GET    /store/v1/admin/warehouses/:id
GET    /store/v1/admin/warehouses/:id/receipts?status=&page=&limit=
GET    /store/v1/admin/warehouses/:id/transactions?type=&from=&to=&page=&limit=
GET    /store/v1/admin/warehouses/:id/managers
POST   /store/v1/admin/warehouses
PATCH  /store/v1/admin/warehouses/:id
POST   /store/v1/admin/warehouses/:id/assign-managers
POST   /store/v1/admin/warehouses/:id/commodities          ← link commodities accepted
DELETE /store/v1/admin/warehouses/:id/commodities/:commodityId
```

`POST /admin/warehouses` body:

```json
{
  "name": "Kano Central Depot",
  "code": "WHS-001",                  // optional, auto-generated if omitted
  "type": "DRY_GOODS",
  "state": "Kano State",
  "address": "Plot 24, Farm Road, Kano",
  "capacityMt": 5000,
  "commodityIds": ["...", "..."],     // commodities this warehouse accepts (creates WarehouseCommodity rows)
  "managerIds": ["..."]               // optional — managers can be assigned later via the dedicated endpoint
}
```

Creating commodity links uses `WarehouseCommodity.upsert` so re-creating doesn't error. The legacy `WarehouseCommodity.storageFeePerUnit` field is **deprecated** — fees come from `StorageFeePolicy` lookup at withdrawal time, not from this table. Leave the column in place for backward compatibility but stop reading it.

`GET /admin/warehouses/:id` returns:

```json
{
  "warehouse": { ...details },
  "managers": [ { "id": "...", "name": "...", "managerCode": "..." } ],
  "summary": {
    "totalClients": 23,
    "totalCommodityMt": 1000,
    "totalReceipts": 85,
    "totalStorageFee": 2500000,
    "currency": "NGN"
  },
  "recentReceipts": [ "...10 items" ],
  "recentTransactions": [ "...10 items" ]
}
```

### 3.4 Receipts (Tenant Admin view + approval)

```
GET    /store/v1/admin/receipts?status=&warehouseId=&approvalStatus=&clientId=&page=&limit=
GET    /store/v1/admin/receipts/:id
POST   /store/v1/admin/receipts/:id/approve
POST   /store/v1/admin/receipts/:id/reject
GET    /store/v1/admin/receipts/pending-approvals
```

The `warehouseId` filter is required functionality — tenant admin needs to slice the receipt list by warehouse from the UI.

Approve body (optional):

```json
{ "notes": "..." }
```

Reject body (required):

```json
{ "rejectionReason": "..." }
```

On approve: `approvalStatus = APPROVED`, `approvedById`, `approvedAt` set, `status` stays `ACTIVE`. The receipt becomes visible to the client and eligible for withdrawal.

On reject: `approvalStatus = REJECTED`, `rejectionReason` recorded. The receipt remains visible to admin and manager (for audit) but excluded from active queries — clients don't see rejected receipts.

### 3.5 Withdrawals (Tenant Admin view + approval)

The withdrawal approval flow currently lives in `withdrawals.service.ts` under generic routes. Move it to admin scope:

```
GET   /store/v1/admin/withdrawals/pending-approvals
GET   /store/v1/admin/withdrawals?status=&warehouseId=&clientId=&from=&to=&page=&limit=
GET   /store/v1/admin/withdrawals/:id
POST  /store/v1/admin/withdrawals/:id/approve     ← was on /withdrawals/:id/approve
POST  /store/v1/admin/withdrawals/:id/reject      ← was on /withdrawals/:id/reject
```

`POST /withdrawals/:id/complete` will move to the warehouse-manager scope when that role is built — for now, leave it where it is but tag it with a `// TODO: move to manager module` comment. The business rule is: **tenant admin approves, warehouse manager dispatches**.

Reject body (required):

```json
{ "rejectionReason": "..." }
```

On approve: `status = APPROVED`, `approvedById`, `approvedAt` set.
On reject: `status = REJECTED`, `rejectionReason` recorded. **No fee refund needed** because fees aren't billed until completion (see §6.1).

### 3.6 Transaction Reports

```
GET   /store/v1/admin/transactions?type=&warehouseId=&clientId=&from=&to=&page=&limit=
GET   /store/v1/admin/transactions/export?format=csv|json&warehouseId=&type=&from=&to=
```

Same shape as the existing `/transactions` endpoint, but tenant-scoped and with the `warehouseId` filter. Required filters: `type` (WITHDRAWAL | LOAN | TRADE), `warehouseId`, `from`, `to`. Pagination via `page` + `limit` (max 100).

**Also add the `warehouseId` filter to the existing `/transactions` endpoint and to `/admin/receipts`** — flagged in the prompt as needed.

CSV export streams the full result set without pagination but with all filters applied. Use a streaming response so a 50MB CSV doesn't buffer in memory.

### 3.7 Settings → Grading

```
GET    /store/v1/admin/grading/commodities
POST   /store/v1/admin/grading/commodities          ← creates a Commodity
PATCH  /store/v1/admin/grading/commodities/:id
GET    /store/v1/admin/grading/commodities/:id/parameters
POST   /store/v1/admin/grading/commodities/:id/parameters
PATCH  /store/v1/admin/grading/parameters/:id
DELETE /store/v1/admin/grading/parameters/:id
POST   /store/v1/admin/grading/apply-to-warehouses  ← bulk-link commodities to warehouses
POST   /store/v1/admin/grading/score                ← compute grade for a sample (preview)
```

Create commodity body:

```json
{
  "name": "Maize",
  "code": "MAIZE-001",
  "unitOfMeasure": "METRIC_TON",
  "gradingLogic": "PERCENTAGE",
  "numberOfGrades": 3,
  "standardBagWeightKg": 50,
  "description": "..."
}
```

Add parameter body:

```json
{
  "name": "Foreign Matter",
  "unit": "%",
  "isDefective": true,
  "thresholds": { "Grade 1": 0.5, "Grade 2": 1.0, "Grade 3": 1.5 }
}
```

`thresholds` keys must match the commodity's `numberOfGrades` (3 grades → 3 keys). Validate this on create/update — return 400 with the missing or extra keys.

**Apply-to-warehouses** — when a commodity's grading config is final, the admin clicks "Save & Apply to all Warehouses" in the UI. This endpoint:

```json
POST /admin/grading/apply-to-warehouses
{ "commodityId": "...", "warehouseIds": ["...", "..."] }  // omit warehouseIds to apply to all
```

…upserts `WarehouseCommodity` rows for each (warehouse, commodity) pair, making the commodity acceptable at those warehouses. No fee data — that's `StorageFeePolicy`.

#### Grading scorer

`POST /admin/grading/score` runs the scorer without persisting:

```json
{
  "commodityId": "...",
  "measurements": {
    "Foreign Matter": 0.3,
    "Moisture": 12.5,
    "Broken Kernels": 1.5,
    "Pest Damaged Grains": 0.5,
    "Discoloured Grains": 0.2
  }
}
```

Returns:

```json
{
  "commodity": "Maize",
  "computedGrade": "Grade 1",
  "totalDefectivePct": 2.5,
  "standardDeductionPct": 1.0,
  "perParameter": [
    { "name": "Foreign Matter", "value": 0.3, "grade": "Grade 1", "withinThreshold": true },
    { "name": "Moisture", "value": 12.5, "grade": "Grade 1", "withinThreshold": true }
  ]
}
```

**Algorithm** (per the PDF's structure for Maize / Sorghum / Rice / Soybeans / Ginger / Sesame):

1. For each measurement, find the **lowest grade tier** whose threshold the measurement does not exceed. (Lower grade number = better quality. Grade 1 has the strictest limits.)
2. The commodity's overall grade = the **worst** (highest-numbered) grade across all parameters. If any parameter exceeds even Grade N's limit, return `computedGrade: "REJECTED"` with the failing parameter listed.
3. `totalDefectivePct` = sum of measurements for parameters where `isDefective: true`. Compare against the commodity's "Total Defective Grains" threshold for the determined grade — if it exceeds, downgrade to next worse grade or reject.
4. `standardDeductionPct` = the "Standard Deduction" value for the determined grade (lookup, not computed).

Implement as a **pure function** in `grading.scorer.ts`:

```ts
type Thresholds = Record<string, number>;
type Parameter = { name: string; unit: string; isDefective: boolean; thresholds: Thresholds };
type ScoreInput = {
  parameters: Parameter[];
  measurements: Record<string, number>;
  numberOfGrades: number;
};
type ScoreResult = {
  computedGrade: string | 'REJECTED';
  totalDefectivePct: number;
  standardDeductionPct: number;
  perParameter: { name: string; value: number; grade: string; withinThreshold: boolean }[];
  failingParameters?: string[];
};

export function scoreSample(input: ScoreInput): ScoreResult { ... }
```

Pure function = trivially unit-testable. Required test cases (from the PDF):

- Maize, all measurements within Grade 1 limits → returns Grade 1.
- Maize, foreign matter 0.8 (within Grade 2) and rest within Grade 1 → returns Grade 2 (worst-of).
- Maize, foreign matter 2.0 (exceeds Grade 3 limit of 1.5) → returns REJECTED with `["Foreign Matter"]`.
- Soybeans with `Salmonella: nil`, `Escherichia Coli: nil` → handled (zero/Nil thresholds).

**Edge cases**:
- Missing measurements for required parameters → 400 with the list of missing parameter names.
- Measurement for a parameter not defined on the commodity → 400.
- "Live Infestation" threshold of "Nil" → represent as `0` numerically with `unit: "Nil"` for display.

**Hooking into deposits** — when the warehouse manager creates a deposit (next phase, not part of this spec), they call `scoreSample` server-side, persist `gradingScores`, `computedGrade`, `totalDefectivePct`, `standardDeductionPct` on the new Receipt. Tenant admin then approves or rejects in their dashboard.

### 3.8 Settings → Storage Fee

```
GET    /store/v1/admin/storage-fees?warehouseId=&commodityId=&isActive=
POST   /store/v1/admin/storage-fees
PATCH  /store/v1/admin/storage-fees/:id
POST   /store/v1/admin/storage-fees/:id/activate
POST   /store/v1/admin/storage-fees/:id/deactivate
```

Create body:

```json
{
  "feeType": "PER_MT_PER_MONTH",
  "warehouseId": "...",            // null = applies to all warehouses (tenant-wide default)
  "commodityId": "...",            // null = applies to all commodities
  "rate": 500,
  "billingFrequency": "MONTHLY",
  "gracePeriodDays": 7,
  "latePenaltyPct": 5,
  "currency": "NGN"
}
```

#### Resolution order at runtime

When a withdrawal needs to compute a fee, the resolver finds the **most specific** active policy in this order:

1. `warehouseId = X AND commodityId = Y` (both match)
2. `warehouseId = X AND commodityId IS NULL` (warehouse-specific, any commodity)
3. `warehouseId IS NULL AND commodityId = Y` (commodity-specific, any warehouse)
4. `warehouseId IS NULL AND commodityId IS NULL` (tenant-wide default)

Stop at the first match. If multiple active policies match at the same specificity level, use the most recently created. If **no policy** matches, return 400 from the withdrawal endpoint — refuse to compute fees from a hardcoded fallback. This is a deliberate guardrail: missing config should be loud.

Implement as `storage-fees.resolver.ts`:

```ts
async resolvePolicy({ tenantId, warehouseId, commodityId }): Promise<StorageFeePolicy> { ... }
```

Used by `WithdrawalsService.calculateWithdrawal`. Replace the current `wc?.storageFeePerUnit ?? 15` with this lookup.

#### Fee math by `feeType`

All quantities first converted to the unit the policy expects.

| `feeType` | Formula | Notes |
|---|---|---|
| `PER_MT_PER_MONTH` | `qty_in_mt × rate × months_stored` | Convert KG → MT (÷1000), BAG → MT (need bag weight) |
| `PER_MT_PER_DAY` | `qty_in_mt × rate × days_stored` | Same conversion |
| `PER_BAG_PER_WEEK` | `bag_count × rate × weeks_stored` | Convert quantity → bag count using commodity's bag weight |
| `FLAT_RATE` | `rate` | One-time, regardless of quantity or duration |

`days_stored` = days between `dateOfDeposit` and the withdrawal request date (or now). Recommend request date so fee is deterministic at calculation time.

#### Bag-count conversion

Per planning decision: quantity is always stored in the commodity's declared unit. Conversion happens at fee calculation. For `PER_BAG_PER_WEEK` to work, the commodity needs to know its standard bag weight — that's `Commodity.standardBagWeightKg`.

Conversion logic in the resolver:

```ts
function toBags(quantity: number, unit: MeasurementUnit, bagWeightKg: number): number {
  switch (unit) {
    case 'BAG':         return quantity;
    case 'KG':          return Math.ceil(quantity / bagWeightKg);
    case 'METRIC_TON':  return Math.ceil((quantity * 1000) / bagWeightKg);
    case 'LITRE':       throw new BadRequestException('Cannot convert LITRE to BAG');
    default:            throw new BadRequestException(`Cannot convert ${unit} to BAG`);
  }
}

function toMt(quantity: number, unit: MeasurementUnit, bagWeightKg?: number): number {
  switch (unit) {
    case 'METRIC_TON':  return quantity;
    case 'KG':          return quantity / 1000;
    case 'BAG':
      if (!bagWeightKg) throw new BadRequestException('Commodity missing standardBagWeightKg');
      return (quantity * bagWeightKg) / 1000;
    case 'LITRE':       throw new BadRequestException('Cannot convert LITRE to METRIC_TON');
    default:            throw new BadRequestException(`Cannot convert ${unit} to METRIC_TON`);
  }
}
```

If `feeType = PER_BAG_PER_WEEK` and the commodity has no `standardBagWeightKg`, refuse the policy creation with 400. Don't let admins create unusable policies.

### 3.9 User settings (all roles)

Mounted under `/store/v1/me/*` — every authenticated user, any role, can manage their own account.

```
GET    /store/v1/me                       ← profile
PATCH  /store/v1/me                       ← update profile fields (firstName, lastName, phone, contactEmail, profilePhotoUrl)
POST   /store/v1/me/change-password       ← user-initiated password change
PATCH  /store/v1/me/notification-prefs    ← toggle email/sms/inApp
```

`POST /me/change-password` body:

```json
{
  "currentPassword": "Xk7$mP2nR9qL",
  "newPassword": "MyNewSecurePassword!"
}
```

Service:
1. Look up user by `req.user.id`.
2. `bcrypt.compare(currentPassword, user.password)` — if it fails, 401 with "Current password is incorrect."
3. Validate `newPassword`: minimum 8 characters, at least one uppercase, one lowercase, one digit. Reject if same as current.
4. `bcrypt.hash(newPassword, 10)` and update.
5. Optional but recommended: revoke all of the user's refresh tokens (forces re-login on other devices).
6. Return 204 No Content (or 200 with `{ message: "Password changed successfully" }`).

Rate-limit this endpoint to prevent abuse (3 attempts per minute per user, on top of the global throttle).

This endpoint is the same one a manager uses after they're created with a temp password — there's no separate "first login flow" anymore. They log in normally, navigate to Settings → Change Password, and update it whenever they want.

---

## Phase 4 — Update existing modules for tenant scoping

The Phase 1 modules need surgery to enforce tenant boundaries:

### 4.1 `withdrawals.service.ts`

- Replace `clientId?` parameter with `req.user.id`.
- All Prisma queries get `tenantId: req.user.tenantId`.
- `calculateWithdrawal` and `createWithdrawalRequest` use `storageFeesResolver.resolvePolicy(...)` instead of `WarehouseCommodity.storageFeePerUnit`.
- Move `approveWithdrawal` and `rejectWithdrawal` to the admin module (they're under §3.5).
- Keep `completeWithdrawal` for now, tag it with `// TODO: move to manager module`.
- Add `feesBilledAt: new Date()` on completion (see §6.1).

### 4.2 `loans.service.ts`

- Replace `clientId?` with `req.user.id`.
- Tenant-scope all queries.
- `createLoan` validates the receipt's `approvalStatus = APPROVED` before pledging.

### 4.3 `trades.service.ts`

- Replace `sellerId?` with `req.user.id`.
- Tenant-scope all queries.
- `createTrade` validates the receipt's `approvalStatus = APPROVED`.

### 4.4 `transactions.service.ts`

- Tenant-scope all three sub-queries (withdrawals, loans, trades).
- Add `warehouseId` filter (joins through `receipt.warehouseId`).
- Add `clientId` filter (already supported, but ensure it's enforced for non-admin roles — clients can only filter to themselves).

### 4.5 `receipts.service.ts`

- Tenant-scope all queries.
- Filter `eligible-receipts` by `approvalStatus = APPROVED` (in addition to `status = ACTIVE`). Pending receipts shouldn't be visible to clients for withdrawal.
- Add `warehouseId` filter to `getReceipts`.

### 4.6 `dashboard.service.ts`

- Tenant-scope.
- Continue showing the client their own data (not all tenant data). The admin dashboard is a separate endpoint (§3.1).

---

## Phase 4.5 — Notifications (in-app + storage)

Captures system events for every role and surfaces them in-app. Email and SMS delivery are out of scope this phase, but the system writes notification rows so the bell icon, dropdown list, and unread counter all work end-to-end.

### Schema

```prisma
enum NotificationChannel {
  IN_APP
  EMAIL
  SMS
}

enum NotificationStatus {
  PENDING
  SENT
  FAILED
  READ
}

model Notification {
  id        String   @id @default(uuid())
  tenantId  String   @map("tenant_id")
  tenant    Tenant   @relation(fields: [tenantId], references: [id])

  recipientId String  @map("recipient_id")
  recipient   User    @relation("NotificationRecipient", fields: [recipientId], references: [id])

  type      String   // dotted-path event key, e.g. "receipt.approved", "withdrawal.requested"
  title     String
  body      String
  data      Json?    // structured payload, e.g. { receiptId, withdrawalId, amount }
  channel   NotificationChannel @default(IN_APP)
  status    NotificationStatus  @default(PENDING)

  readAt    DateTime? @map("read_at")
  sentAt    DateTime? @map("sent_at")
  failedReason String? @map("failed_reason")

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([tenantId])
  @@index([recipientId, status])
  @@index([recipientId, createdAt])
  @@map("notifications")
}

model User {
  // existing fields...
  notifications Notification[] @relation("NotificationRecipient")
}
```

### Endpoints (all roles, scoped to the requesting user)

```
GET   /store/v1/notifications?status=&type=&page=&limit=
GET   /store/v1/notifications/unread-count
POST  /store/v1/notifications/:id/read
POST  /store/v1/notifications/read-all
DELETE /store/v1/notifications/:id
```

Mounted globally — every authenticated user, regardless of role, hits the same routes. The service filters by `recipientId = req.user.id` always; users only see their own notifications.

`GET /notifications` returns:

```json
{
  "items": [
    {
      "id": "...",
      "type": "receipt.approved",
      "title": "Your receipt was approved",
      "body": "Receipt WR-2025-0014 (Palm Oil, 12,500 L) has been approved by the tenant administrator.",
      "data": { "receiptId": "...", "receiptNumber": "WR-2025-0014" },
      "status": "PENDING",
      "readAt": null,
      "createdAt": "2026-05-07T14:23:11.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}
```

`GET /notifications/unread-count` is the bell-icon badge — keep it cheap (single COUNT query, indexed). Front-end can poll this every 30s.

`POST /notifications/:id/read` flips `status: READ`, sets `readAt = now()`. `POST /notifications/read-all` does the same for every PENDING notification belonging to the user.

### Notifications service

`src/notifications/notifications.service.ts` exposes one main method that the rest of the codebase calls:

```ts
async notify({
  tenantId,
  recipientId,
  type,
  title,
  body,
  data,
}: NotifyInput): Promise<Notification>
```

Internally:
1. Look up the recipient's `notificationPrefs`.
2. If `inApp` is enabled (default `true`), insert a `Notification` row with `channel: IN_APP, status: PENDING`.
3. If `email` is enabled, insert a second row with `channel: EMAIL, status: PENDING`. **Don't actually send** — the row sits awaiting future email-delivery work.
4. Same for SMS.
5. Return the in-app row (the others are fire-and-forget).

This way: in-app works today, and when email/SMS adapters arrive later, a background worker processes `status: PENDING` rows on those channels — no application code changes needed.

### Multi-recipient notifications

Some events fan out to multiple users. Add a helper:

```ts
async notifyMany({ tenantId, recipientIds, type, title, body, data }): Promise<void>
```

Used for "this needs admin attention" — broadcast to all users in the tenant with the `TENANT_ADMIN` role.

### Event catalog

Wire `notify(...)` calls into the relevant service methods. Every event below should fire on its trigger:

| Event type | Trigger | Recipients |
|---|---|---|
| `manager.account_created` | `POST /admin/managers` succeeds | The new manager |
| `manager.password_reset` | `POST /admin/managers/:id/reset-password` | The manager |
| `manager.deactivated` | `POST /admin/managers/:id/deactivate` | The manager |
| `warehouse.assigned` | Manager assigned to a warehouse | The manager |
| `warehouse.unassigned` | Manager unassigned from a warehouse | The manager |
| `receipt.created` | New deposit receipt issued | Client (owner) + all tenant admins |
| `receipt.approved` | `POST /admin/receipts/:id/approve` | Client (owner) |
| `receipt.rejected` | `POST /admin/receipts/:id/reject` | Client (owner) |
| `withdrawal.requested` | `POST /withdrawals` | All tenant admins |
| `withdrawal.payment_confirmed` | `POST /withdrawals/:id/confirm-payment` | All tenant admins |
| `withdrawal.approved` | `POST /admin/withdrawals/:id/approve` | Client (requester) + warehouse manager |
| `withdrawal.rejected` | `POST /admin/withdrawals/:id/reject` | Client (requester) |
| `withdrawal.completed` | `POST /withdrawals/:id/complete` | Client (requester) |
| `loan.created` | `POST /loans` | All tenant admins + financier |
| `loan.approved` | Loan moved to ACTIVE | Client (borrower) |
| `loan.rejected` | Loan rejected | Client (borrower) |
| `loan.repaid` | `POST /loans/:id/repay` | Client (borrower) + financier |
| `trade.listed` | `POST /trades` | All tenant admins |
| `trade.settled` | Trade settled | Seller + buyer |
| `trade.cancelled` | Trade cancelled | Seller |

Title/body text are plain English; the front-end may template them further or override based on type. Keep them short — the in-app notification card is small.

### Tenant scoping

Every `notify()` call must include `tenantId`. The notifications endpoints then filter by `tenantId` AND `recipientId` — defense in depth so a bug in one filter doesn't leak across tenants.

### Cleanup

Old read notifications accumulate. Add a scheduled task (or document it as a future cron) to delete `READ` notifications older than 30 days. Out of scope for first implementation; mention in code comments as a TODO.

---

## Phase 5 — Seed updates

Update `prisma/seed.ts`:

1. Create one demo tenant: `{ name: "SecureStore Demo", slug: "demo" }`. Save its ID.
2. Set `tenantId` on every existing seed entity (users, warehouses, commodities, receipts).
3. Promote the seeded `demo@securestore.com` user — give them **both** `CLIENT` and `TENANT_ADMIN` roles via the new `UserRole` join table. This is the working test account for the new admin endpoints.
4. Create the `tenant@securestore.com` (TENANT_ADMIN only) and `manager@securestore.com` (WAREHOUSE_MANAGER) users, also linked to the demo tenant. Useful for testing role boundaries cleanly when needed.
5. Seed the Maize grading parameters from the PDF as a working example:

```ts
const maizeParameters = [
  { name: 'Foreign Matter',         unit: '%',  isDefective: true,  thresholds: { 'Grade 1': 0.5,  'Grade 2': 1.0,  'Grade 3': 1.5  }},
  { name: 'Inorganic Matter',       unit: '%',  isDefective: true,  thresholds: { 'Grade 1': 0.25, 'Grade 2': 0.5,  'Grade 3': 0.75 }},
  { name: 'Broken Kernels',         unit: '%',  isDefective: false, thresholds: { 'Grade 1': 2.0,  'Grade 2': 4.0,  'Grade 3': 6.0  }},
  { name: 'Pest Damaged Grains',    unit: '%',  isDefective: true,  thresholds: { 'Grade 1': 1.0,  'Grade 2': 3.0,  'Grade 3': 5.0  }},
  { name: 'Rotten & Diseased',      unit: '%',  isDefective: true,  thresholds: { 'Grade 1': 2.0,  'Grade 2': 4.0,  'Grade 3': 5.0  }},
  { name: 'Discoloured Grains',     unit: '%',  isDefective: true,  thresholds: { 'Grade 1': 0.5,  'Grade 2': 1.0,  'Grade 3': 1.5  }},
  { name: 'Moisture',               unit: '%',  isDefective: false, thresholds: { 'Grade 1': 13.0, 'Grade 2': 13.0, 'Grade 3': 13.0 }},
  { name: 'Total Defective Grains', unit: '%',  isDefective: false, thresholds: { 'Grade 1': 4.0,  'Grade 2': 5.0,  'Grade 3': 7.0  }},
  { name: 'Standard Deduction',     unit: '%',  isDefective: false, thresholds: { 'Grade 1': 1.0,  'Grade 2': 1.5,  'Grade 3': 2.5  }},
];
```

6. Seed the same for the other 5 commodities in the PDF (Soybeans, Sorghum, Paddy Rice, Ginger, Sesame). Ginger and Sesame have only 2 grades — set `numberOfGrades: 2` and provide thresholds with 2 keys.

7. Seed one storage fee policy (tenant-wide default) so existing withdrawals continue to work:

```ts
{
  feeType: 'PER_MT_PER_MONTH',
  warehouseId: null,
  commodityId: null,
  rate: 500,
  billingFrequency: 'MONTHLY',
  gracePeriodDays: 7,
  latePenaltyPct: 5,
  currency: 'NGN'
}
```

8. Set `approvalStatus: APPROVED` on all existing seeded receipts so they remain usable post-migration.

---

## Phase 6 — Carry-over hardening from Phase 1

Address these alongside the new work — they're cheap to do now and expensive to retrofit later.

### 6.1 Defer fee billing to completion

Withdrawal fees were being computed at request time. With the new state machine (request → confirm payment → approve → complete), fees should only be considered "billed" on completion. Schema field `feesBilledAt` added in Phase 1. Update `withdrawalsService.completeWithdrawal` to set `feesBilledAt = new Date()` inside the transaction. Rejection then has nothing to refund — we never charged anything.

### 6.2 Time-based storage fees

Phase 1 charged storage as `quantity × ratePerUnit`, ignoring duration. Real warehouses bill per time. With `StorageFeePolicy.billingFrequency` and `feeType` in place, the new resolver makes fees time-aware:

```ts
const days = Math.ceil((withdrawalRequestDate.getTime() - receipt.dateOfDeposit.getTime()) / 86_400_000);
// then apply per feeType formula above
```

### 6.3 Concurrency on hot receipts

If two requests touch the same receipt simultaneously, Prisma's default isolation can race. Wrap `completeWithdrawal`, `createLoan`, `createTrade`, `settleTrade`, `approveReceipt`, `approveWithdrawal` with serializable isolation:

```ts
prisma.$transaction(async (tx) => { ... }, { isolationLevel: 'Serializable' })
```

Postgres rejects one of two concurrent serializable transactions on conflict. Add a retry wrapper (max 3 attempts) for `serialization_failure` errors.

### 6.4 Currency

`currency: String @default("NGN")` added on `Withdrawal`, `Loan`, `Trade`, `StorageFeePolicy`. Frontend formats with the currency code; backend never assumes naira. No FX conversion in this phase — out of scope.

### 6.5 Unified Transaction table (deferred)

The current `/transactions` aggregator does up-to-3 DB lookups for detail. If transaction volume grows past ~100k rows, denormalize into a single `Transaction` table with a `type` discriminator and a polymorphic `referenceId`. Skip for now.

---

## Phase 7 — Testing & deployment

### End-to-end smoke test

After Phases 0–4 are done:

1. **Seed**: run `npx prisma migrate dev` then `npx prisma db seed`.
2. **Log in as `demo@securestore.com`** — JWT carries both `CLIENT` and `TENANT_ADMIN` roles.
3. **Create a commodity** via `POST /admin/grading/commodities` (e.g. "Test Maize"). Add 3 parameters via `POST /admin/grading/commodities/:id/parameters`.
4. **Preview the scorer** via `POST /admin/grading/score` with sample measurements. Verify the returned grade matches expectations.
5. **Create a warehouse** via `POST /admin/warehouses` with the commodity linked.
6. **Create a storage fee policy** via `POST /admin/storage-fees` for the warehouse + commodity.
7. **Approve a pending receipt** (manually create one in Prisma Studio with `approvalStatus: PENDING`, then approve via `POST /admin/receipts/:id/approve`).
8. **As the same user (now acting as client)**, request a withdrawal via existing `POST /withdrawals`. Confirm fee comes from the new policy resolver.
9. **As admin, approve the withdrawal** via `POST /admin/withdrawals/:id/approve`.
10. **Verify dashboards**: admin dashboard reflects the new state (warehouse count, pending requests = 0 after approvals, etc.). Transaction report shows the chain.
11. **Verify notifications**: hit `GET /notifications` as the client — should see `receipt.approved`, `withdrawal.approved` rows. Hit as the admin — should see `withdrawal.requested`. `GET /notifications/unread-count` returns the right number. Marking one read drops the count by one.
12. **Create a manager** via `POST /admin/managers` — verify the response includes `credentials.email` (formatted as `firstname.lastname@securestore.com`) and `credentials.temporaryPassword`. Log in with those credentials — should succeed normally with no forced password change. Then hit `POST /me/change-password` with the temp password as `currentPassword` and a new value as `newPassword` — verify the change works and subsequent logins use the new password.

### Migration order

```bash
npx prisma migrate dev --name phase_0_multi_tenancy_and_auth
npx prisma migrate dev --name phase_1_tenant_admin_schema
npx prisma migrate dev --name phase_6_currency_and_fees_billing
```

Each migration runs only after its phase is implemented and tested locally.

### Render deploy

Build command stays:

```
npm install && npx prisma migrate deploy && npm run build
```

Add the new env vars from §0.8. CORS_ORIGINS already covers the Vercel frontend.

---

## Out of scope (intentionally deferred)

- **Warehouse Manager module** — this spec is Tenant Admin only. Manager-facing endpoints (deposits, dispatches, manager dashboard) come next phase.
- **Multi-currency conversion logic** — added the field, didn't add FX handling.
- **PDF generation for receipts** — endpoint exists as a stub; real implementation is its own work item.
- **File upload for profile photos** — needs an object-storage decision (S3, Cloudinary, etc.). The schema field exists; persisting actual files is a separate task.
- **Audit log** — every approve/reject/dispatch should write to an audit table for production. Worth adding before going live but not blocking for this phase.
- **Two-factor auth** — recommended for tenant admins eventually. Not in this phase.
- **Approval rules engine** — `/admin/approval-rules` deferred. Static "admin approves everything" model for now; rules engine when business rules concretize.
- **Self-service tenant signup** — `GLOBAL_ADMIN` provisions tenants out-of-band for now.
- **Email and SMS notification delivery** — in-app notifications work end-to-end (see Phase 4.5). Email/SMS rows are created in the DB with `status: PENDING` but no adapter sends them yet. Wiring up Termii / Twilio / SES is a separate phase.
