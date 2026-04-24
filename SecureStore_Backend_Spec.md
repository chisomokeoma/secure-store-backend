# SecureStore — Backend Specification (Demo Build)

**Stack:** Node.js · NestJS · PostgreSQL · TypeORM (or Prisma) · JWT Auth · BullMQ (optional, for async receipt generation)
**Primary Goal:** Power a client-side demo where a logged-in Client can view seeded commodities, view receipts, and complete a full **Request Withdrawal** flow that generates a real receipt and updates dashboard figures in real time.

---

## 1. Product Context (Required Reading for Backend Devs)

SecureStore is a **commodity storage and inventory management platform**. Clients bring physical commodities (grains, cement, ironrods, etc.) to warehouses operated under the SecureStore network. Once deposited and graded, each commodity deposit is represented digitally by a **Warehouse Receipt (WR)**. That receipt is the unit of truth for every downstream action.

From a WR, a Client can:

- **Request a Withdrawal** — take their commodity (or a portion of it) out of storage.
- **Take a Loan** — pledge one or more WRs as collateral to a Financier.
- **Trade the Commodity** — sell the commodity (or the WR) on the marketplace.

Every action — deposit, withdrawal, loan/pledge, trade, release, cancel — **must produce a receipt/transaction record**. Receipts are the audit backbone.

Revenue model: the platform earns storage fees (per unit, per month), handling fees on withdrawal, and transaction fees on loans/trades.

### Measurement Units
Commodities are measured in **one of three units**, chosen per commodity at creation time by the Tenant Admin:

- `KG` (Kilograms)
- `MT` (Metric Tonnes)
- `L` (Litres)

The dashboard aggregates "Total Volume Held" **per unit** — i.e. a client holding rice (MT), cement (KG), and palm oil (L) should see three separate totals, not a fake unified number.

---

## 2. Role & Permission Hierarchy

Permissions cascade top-down. Each role can create the role immediately below it.

| Role | Created By | Scope | Can Create |
|------|-----------|-------|------------|
| `GLOBAL_ADMIN` | System seed | Platform-wide | `TENANT_ADMIN` |
| `TENANT_ADMIN` | Global Admin | Their tenant (organisation) | Warehouses, Commodity definitions, `WAREHOUSE_MANAGER`, `FINANCIER` |
| `WAREHOUSE_MANAGER` | Tenant Admin | A single warehouse | `CLIENT`, Deposits, Warehouse Receipts |
| `FINANCIER` | Tenant Admin | Loan offerings | Loan products, approvals |
| `CLIENT` | Warehouse Manager | Their own receipts only | Withdrawal/Loan/Trade requests |

> **Demo scope:** We will only expose and exercise the `CLIENT` role in the UI. All other roles' users and their data are **seeded** to make the Client flow work.

### Permission Enforcement
- Every endpoint must be guarded by a `@Roles(...)` decorator + `RolesGuard`.
- Every resource read/write must additionally enforce **ownership** — a Client can only see *their own* receipts, transactions, balances. Use a `tenantId` + `ownerId` scope check on every query.

---

## 3. Database Schema

All tables use UUID primary keys, `created_at` / `updated_at` timestamps, and soft deletes where noted. All monetary fields are `DECIMAL(18,2)` in NGN (kobo optional). All quantity fields are `DECIMAL(18,4)` to allow fractional MT/KG/L.

### 3.1 `users`
```
id (uuid, pk)
email (unique)
password_hash
first_name
last_name
phone
role (enum: GLOBAL_ADMIN | TENANT_ADMIN | WAREHOUSE_MANAGER | FINANCIER | CLIENT)
tenant_id (fk → tenants.id, nullable for GLOBAL_ADMIN)
warehouse_id (fk → warehouses.id, nullable — only for WAREHOUSE_MANAGER & CLIENT)
is_active (bool)
last_login_at
created_by (fk → users.id, nullable)
```

### 3.2 `tenants`
```
id (uuid, pk)
name
slug
logo_url
is_active
```

### 3.3 `warehouses`
```
id (uuid, pk)
tenant_id (fk)
name                   e.g. "Funtua Grain Storage", "Lagos State Warehouse"
location               city/state
address
capacity_total         DECIMAL
capacity_used          DECIMAL
manager_id (fk → users.id, nullable)
is_active
```

### 3.4 `commodities` (commodity definitions per tenant)
```
id (uuid, pk)
tenant_id (fk)
name                   e.g. "Maize", "Cement", "Ironrods", "Bag of rice", "Tanks", "Doors"
unit                   enum: KG | MT | L
storage_fee_per_unit   DECIMAL   -- e.g. 500 (naira per MT per month)
storage_fee_period     enum: DAILY | WEEKLY | MONTHLY
handling_fee_flat      DECIMAL   -- e.g. 10000
accepted_grades        JSON      -- ["Grade A", "Grade B", "Grade C"]
description
icon_url
is_active
```

### 3.5 `warehouse_commodities` (join — which warehouse accepts which commodity)
```
id, warehouse_id (fk), commodity_id (fk), is_active
```

### 3.6 `warehouse_receipts` (the core entity)
```
id (uuid, pk)
receipt_number         unique, human-readable, e.g. "WR-2025-0001"
tenant_id (fk)
client_id (fk → users.id)
warehouse_id (fk)
commodity_id (fk)
quantity               DECIMAL — original quantity at deposit
quantity_available     DECIMAL — remaining after partial withdrawals/pledges/trades
unit                   denormalised from commodity for historical accuracy
grade                  e.g. "Grade A"
status                 enum: ACTIVE | PLEDGED | LIEN | WITHDRAWN | PARTIALLY_WITHDRAWN
                              | TRADED | CANCELLED | EXPIRED
date_of_deposit        date
expiry_date            date
issued_by (fk → users.id)   — the warehouse manager
notes
metadata               JSON
```

> **Status semantics for the dashboard counters:**
> - *Total Available* = receipts with status `ACTIVE` or `PARTIALLY_WITHDRAWN` and `quantity_available > 0`.
> - *Total Pledged* = receipts with status `PLEDGED` or `LIEN`.
> - *Total Traded* = receipts with status `TRADED`.
> - *Total Volume Held* = SUM(`quantity_available`) GROUPED BY `unit`.

### 3.7 `transactions` (umbrella ledger)
```
id (uuid, pk)
transaction_number     unique, e.g. "TXN-2025-000123"
tenant_id (fk)
client_id (fk)
type                   enum: DEPOSIT | WITHDRAWAL | LOAN | TRADE | FEE_PAYMENT
                              | LIEN_PLACED | LIEN_RELEASED
status                 enum: PENDING | APPROVED | REJECTED | COMPLETED | CANCELLED
amount                 DECIMAL — NGN (fees, loan amount, trade value)
reference_id           uuid — points to withdrawal_requests / loans / trades / deposits
metadata               JSON
initiated_at
completed_at
```

### 3.8 `receipts` (transaction receipts — the PDF-able proof)
```
id (uuid, pk)
receipt_number         unique, e.g. "RCT-WD-2025-0001", "RCT-DP-2025-0001"
tenant_id (fk)
client_id (fk)
transaction_id (fk → transactions.id)
type                   enum: DEPOSIT | WITHDRAWAL | LOAN | TRADE | FEE
warehouse_receipt_id   (fk, nullable)
warehouse_id           (fk, nullable)
commodity_id           (fk, nullable)
quantity               DECIMAL
unit                   enum
amount                 DECIMAL
fee_breakdown          JSON   -- [{ label, amount }, ...]
status                 enum: ISSUED | VOIDED
issued_at
pdf_url                (nullable — populated after async PDF generation)
metadata               JSON
```

### 3.9 `withdrawal_requests`
```
id (uuid, pk)
tenant_id, client_id
warehouse_receipt_id (fk)
warehouse_id (fk)
commodity_id (fk)
quantity_requested      DECIMAL
unit
reason                  text
planned_date            date
storage_fee             DECIMAL   -- snapshot at request time
handling_fee            DECIMAL
total_fee               DECIMAL
payment_status          enum: UNPAID | PAID | FAILED
payment_method          enum: BANK_TRANSFER | CARD (BANK_TRANSFER for demo)
payment_reference       string    -- generated account number / ref
status                  enum: DRAFT | PENDING_PAYMENT | PAID_PENDING_APPROVAL
                               | APPROVED | COMPLETED | REJECTED | CANCELLED
approved_by (fk → users.id, nullable)
approved_at
completed_at
receipt_id (fk → receipts.id, nullable)
```

### 3.10 `loans`
```
id (uuid, pk)
loan_number            unique
tenant_id, client_id
financier_id (fk → financiers.id)
loan_amount            DECIMAL
collateral_value       DECIMAL
ltv_ratio              DECIMAL   -- e.g. 0.70
interest_rate          DECIMAL   -- e.g. 8.5
tenure_min_months, tenure_max_months
selected_tenure_months
repayment_schedule     JSON
status                 enum: DRAFT | PENDING | APPROVED | DISBURSED
                              | ACTIVE | REPAID | DEFAULTED | CANCELLED
requested_at, approved_at, disbursed_at, closed_at
receipt_id (fk)
```

### 3.11 `loan_pledges` (receipts attached as collateral to a loan)
```
id, loan_id (fk), warehouse_receipt_id (fk), pledged_quantity, pledge_amount_ngn
```

### 3.12 `financiers`
```
id, tenant_id, name ("First Bank Plc", etc.), logo_color, logo_url
interest_rate, tenure_min_months, tenure_max_months
approval_time_hours, max_ltv, is_active
```

### 3.13 `trades` (placeholder — out of demo scope, but seeded table)
```
id, trade_number, tenant_id, seller_id, buyer_id, warehouse_receipt_id,
quantity, unit, price_per_unit, total_amount, status, receipt_id
```

### 3.14 `notifications`
```
id, user_id, title, body, type, is_read, metadata, created_at
```

### 3.15 `audit_logs`
```
id, user_id, action, entity_type, entity_id, before, after, ip, created_at
```

---

## 4. Seed Data (Non-Negotiable for the Demo)

Run seeds in this order so FK dependencies resolve.

### 4.1 Tenant
```
Tenant: "SecureStore Demo"  (id fixed in seed for deterministic FKs)
```

### 4.2 Users
| Role | Email | Password | Notes |
|------|-------|----------|-------|
| GLOBAL_ADMIN | `admin@securestore.com` | `Admin@123` | |
| TENANT_ADMIN | `tenant@securestore.com` | `Tenant@123` | |
| WAREHOUSE_MANAGER | `manager@securestore.com` | `Manager@123` | Assigned to Funtua Grain Storage |
| WAREHOUSE_MANAGER | `manager2@securestore.com` | `Manager@123` | Assigned to Lagos State Warehouse |
| FINANCIER (user) | `firstbank@securestore.com` | `Finance@123` | |
| **CLIENT (demo)** | **`demo@securestore.com`** | **`Demo@123`** | **`John Doe` — this is the user shown in the UI** |

### 4.3 Warehouses
- `Funtua Grain Storage` — Funtua, Katsina — capacity 50,000 MT — manager: manager@
- `Lagos State Warehouse` — Lagos — capacity 30,000 MT — manager: manager2@
- `Kano Dry Goods Warehouse` — Kano — capacity 20,000 MT

### 4.4 Commodities (tenant-level definitions — match screenshots)
| Name | Unit | Storage Fee/Unit | Period | Handling Fee | Grades |
|------|------|------------------|--------|--------------|--------|
| Maize | MT | 500 | MONTHLY | 10,000 | Grade A, B, C |
| Rice (Bag of rice) | KG | 50 | MONTHLY | 5,000 | Grade A, B |
| Cement | KG | 20 | MONTHLY | 8,000 | Grade A |
| Ironrods | KG | 100 | MONTHLY | 15,000 | Grade A, B |
| Tanks | L | 10 | MONTHLY | 12,000 | Standard |
| Doors | KG | 30 | MONTHLY | 7,500 | Grade A |
| Wheat | MT | 450 | MONTHLY | 10,000 | Grade A, B |
| Palm Oil | L | 15 | MONTHLY | 6,000 | Grade A |

Link each commodity to at least one warehouse via `warehouse_commodities`.

### 4.5 Financiers (for loan UI)
Five financiers, as shown in Image 8. Give each a distinct colour accent.
- First Bank Plc — 8.5% p.a — 3–12 months — 24 hr approval — max_ltv 0.70
- Zenith Bank — 9.0% — 3–12 — 24 hr — 0.70
- Access Bank — 8.75% — 3–12 — 24 hr — 0.65
- GTBank — 8.0% — 3–12 — 48 hr — 0.70
- UBA — 9.25% — 3–12 — 24 hr — 0.65

### 4.6 Warehouse Receipts for `demo@securestore.com` (John Doe) — THE KEY SEED

This is what populates every dashboard figure, the receipt table, and the commodity management view. Seed **at least these receipts**, all owned by the demo client:

| Receipt No. | Commodity | Qty | Unit | Grade | Warehouse | Status | Deposit | Expiry |
|---|---|---|---|---|---|---|---|---|
| WR-2025-0001 | Maize | 500 | MT | Grade A | Funtua Grain Storage | ACTIVE | 2025-01-15 | 2026-01-15 |
| WR-2025-0002 | Maize | 100 | MT | Grade A | Lagos State Warehouse | ACTIVE | 2025-02-10 | 2026-02-10 |
| WR-2025-0003 | Maize | 100 | MT | Grade A | Funtua Grain Storage | ACTIVE | 2025-03-05 | 2026-03-05 |
| WR-2025-0004 | Maize | 100 | MT | Grade B | Funtua Grain Storage | PLEDGED | 2025-03-12 | 2026-03-12 |
| WR-2025-0005 | Maize | 100 | MT | Grade A | Funtua Grain Storage | LIEN | 2025-04-01 | 2026-04-01 |
| WR-2025-0006 | Cement | 1,000 | KG | Grade A | Lagos State Warehouse | ACTIVE | 2025-01-01 | 2026-01-01 |
| WR-2025-0007 | Cement | 1,000 | KG | Grade A | Lagos State Warehouse | ACTIVE | 2025-01-01 | 2026-01-01 |
| WR-2025-0008 | Cement | 1,000 | KG | Grade A | Kano Dry Goods | PLEDGED | 2025-01-01 | 2026-01-01 |
| WR-2025-0009 | Rice | 500 | KG | Grade A | Lagos State Warehouse | ACTIVE | 2025-02-01 | 2026-02-01 |
| WR-2025-0010 | Wheat | 100 | MT | Grade A | Funtua Grain Storage | ACTIVE | 2025-02-15 | 2026-02-15 |
| WR-2025-0011 | Ironrods | 200 | KG | Grade A | Kano Dry Goods | ACTIVE | 2025-03-01 | 2026-03-01 |
| WR-2025-0012 | Tanks | 500 | L | Standard | Lagos State Warehouse | TRADED | 2025-02-20 | 2026-02-20 |
| WR-2025-0013 | Doors | 200 | KG | Grade A | Lagos State Warehouse | ACTIVE | 2025-03-10 | 2026-03-10 |
| WR-2025-0014 | Palm Oil | 12,500 | L | Grade A | Lagos State Warehouse | ACTIVE | 2025-01-20 | 2026-01-20 |

> **Seed `quantity_available = quantity`** for ACTIVE receipts. For PLEDGED/LIEN receipts, `quantity_available` may be 0 (fully pledged) or partial — your choice. Make sure the resulting dashboard numbers match the look of Image 2 (non-zero, mixed statuses).

### 4.7 Historical Transactions & Receipts
Seed ~30–50 past transactions (mix of deposits, a few old withdrawals, one or two old loans) spread over the last 6 months. This populates:
- "Recent Receipts" table on dashboard
- "Total Deposits / Total Withdrawals" in System Status
- Activity Trend chart (NGN 12.7K) — 12 data points over the last year
- Transaction Reports page

---

## 5. API Endpoints

All endpoints are prefixed with `/api/v1`. Responses follow:
```json
{ "success": true, "data": { ... }, "message": "..." }
{ "success": false, "error": { "code": "...", "message": "..." } }
```
Auth: JWT Bearer token in `Authorization` header. Token payload: `{ sub, email, role, tenantId, warehouseId? }`.

### 5.1 Auth
| Method | Path | Description |
|---|---|---|
| POST | `/auth/login` | Email + password → access token + refresh token + user profile |
| POST | `/auth/refresh` | Refresh token → new access token |
| POST | `/auth/logout` | Invalidate session |
| POST | `/auth/forgot-password` | Email link (stub for demo) |
| POST | `/auth/reset-password` | Token + new password |
| GET | `/auth/me` | Current user profile |

### 5.2 Dashboard (Client scope)
| Method | Path | Description |
|---|---|---|
| GET | `/dashboard/summary` | Returns the four stat cards, grouped totals per unit, recent receipts |
| GET | `/dashboard/commodity-breakdown?period=this_month\|this_year` | Donut chart data |
| GET | `/dashboard/activity-trend?range=1Y\|6M\|3M\|1M` | Line chart data (NGN totals per period) |
| GET | `/dashboard/system-status` | Total deposits & withdrawals (lifetime) |

**`/dashboard/summary` response shape:**
```json
{
  "totalVolumeHeld": {
    "byUnit": [
      { "unit": "MT", "amount": 800 },
      { "unit": "KG", "amount": 3400 },
      { "unit": "L", "amount": 13000 }
    ],
    "headlineUnit": "L",
    "headlineAmount": 12500,
    "deltaFromLastMonth": 10
  },
  "totalAvailable": { "count": 8, "deltaFromLastMonth": 5 },
  "totalPledged":   { "count": 3, "deltaFromLastMonth": -2 },
  "totalTraded":    { "count": 5, "deltaFromLastMonth": 12 },
  "systemStatus": { "totalDeposits": "100 MT", "totalWithdrawals": "100 MT" },
  "recentReceipts": [ /* last 10 warehouse receipts */ ]
}
```

### 5.3 Receipt Management
| Method | Path | Description |
|---|---|---|
| GET | `/receipts?status=all\|active\|cancelled\|lien&page=&limit=&search=` | Paginated receipts with filters |
| GET | `/receipts/stats` | Totals: total, active, liened, cancelled (for the top cards) |
| GET | `/receipts/:id` | Single receipt detail |
| GET | `/receipts/:id/pdf` | Stream PDF of the warehouse receipt |
| GET | `/receipts/:id/download` | Download original deposit receipt |

### 5.4 Commodity Management (Client view)
| Method | Path | Description |
|---|---|---|
| GET | `/commodities/mine` | List of commodity types the client actually holds — drives the left panel (Maize, Cement, Ironrods...) |
| GET | `/commodities/:id/overview` | The four stat cards for the selected commodity + receipt cards |
| GET | `/commodities/:id/receipts?view=cards\|table&page=&search=&filter=` | Receipts for that commodity |
| GET | `/commodities/:id/export?format=csv\|xlsx` | Export Data button |

### 5.5 Request Withdrawal — **PRIMARY DEMO FLOW**
| Method | Path | Description |
|---|---|---|
| GET | `/withdrawals/eligible-receipts` | Receipts that can currently be withdrawn (status ACTIVE or PARTIALLY_WITHDRAWN, `quantity_available > 0`, not pledged/liened) |
| GET | `/withdrawals/receipts/:receiptId/prefill` | Given a receipt, return commodity, available qty, unit, warehouse — for the Step-1 form autofill |
| POST | `/withdrawals/calculate` | **Step 1 → Step 2 transition.** Accepts `{ receiptId, quantity, reason, plannedDate }` and returns the full fee breakdown + summary object. **Does NOT persist yet.** |
| POST | `/withdrawals` | Creates the withdrawal request (status `PENDING_PAYMENT`) and returns payment details (bank name, account number, account name, amount, reference). |
| POST | `/withdrawals/:id/confirm-payment` | Client clicks "Yes, I have made payment" — moves to `PAID_PENDING_APPROVAL`, triggers receipt generation. In demo mode auto-approve and auto-complete. |
| GET | `/withdrawals/:id` | Full withdrawal detail + linked receipt |
| GET | `/withdrawals/:id/summary.pdf` | Download PDF from Step 2 |

### 5.6 Take a Loan
| Method | Path | Description |
|---|---|---|
| GET | `/loans/financiers` | List of available financiers with their terms |
| GET | `/loans/pledgeable-receipts?commodity=` | Receipts available to pledge, grouped by commodity (tabs in Step 2) |
| POST | `/loans/calculate` | Accepts `{ financierId, pledges: [{ receiptId, quantity }] }` → returns `{ collateralValue, loanAmount, ltvRatio, repaymentPeriod }` |
| POST | `/loans` | Create loan request, lock pledged receipts to `PLEDGED`/`LIEN` status, generate lien receipts |
| GET | `/loans/:id` | Loan detail |

### 5.7 Trade Commodity (stub endpoints — demo doesn't exercise deeply)
- `GET /trades/listings`, `POST /trades`, `GET /trades/:id`

### 5.8 Transaction Reports
| Method | Path | Description |
|---|---|---|
| GET | `/transactions?type=&from=&to=&page=` | Full history |
| GET | `/transactions/:id` | Detail |
| GET | `/transactions/export?format=csv\|xlsx` | Export |

### 5.9 Settings
- `GET /users/me`, `PATCH /users/me`, `POST /users/me/change-password`, `GET/PATCH /users/me/preferences`

### 5.10 Notifications
- `GET /notifications`, `PATCH /notifications/:id/read`, `PATCH /notifications/mark-all-read`

---

## 6. The Withdrawal Flow — Step-by-Step Backend Contract

This section documents the exact backend behaviour for the three UI screens (Images 5 → 6 → 7). Follow it literally.

### Step 1 — Client fills the form (Image 5)
Frontend calls:
1. `GET /withdrawals/eligible-receipts` → populates the **Select receipt** dropdown.
2. When user picks a receipt, `GET /withdrawals/receipts/:receiptId/prefill` → autofills Commodity, Available Quantity, Unit, Warehouse.
3. User types quantity, reason, planned date → clicks **Continue**.
4. Frontend calls `POST /withdrawals/calculate`:

**Request:**
```json
{
  "receiptId": "uuid",
  "quantity": 500,
  "reason": "For onward sale to off-taker",
  "plannedDate": "2025-05-01"
}
```

**Backend logic:**
- Load receipt, verify ownership and status.
- Validate `quantity <= receipt.quantity_available`.
- Compute storage months held: `ceil((plannedDate - receipt.date_of_deposit) / 30 days)` — or use commodity's `storage_fee_period`.
- `storage_fee = quantity * commodity.storage_fee_per_unit * months_held`.
- `handling_fee = commodity.handling_fee_flat`.
- `total_fee = storage_fee + handling_fee`.

**Response (Step-2 summary shape, mirrors Image 6):**
```json
{
  "receiptNumber": "WR-2025-0001",
  "commodity": { "type": "Maize", "quantity": 500, "unit": "MT", "quality": "Grade A" },
  "storage":   {
    "warehouse": "Lagos State Warehouse",
    "dateDeposited": "2025-01-01",
    "expiryDate": "2026-01-01"
  },
  "reason": "For onward sale to off-taker",
  "feeBreakdown": [
    { "label": "Storage fee (500 naira per metric tons, Monthly)", "amount": 25000 },
    { "label": "Handling fee", "amount": 10000 }
  ],
  "total": 35000,
  "notice": "Storage fee is calculated based on the duration your commodities have been stored. Fees will continue to accrue if withdrawal is not completed within 48 hours of approval.",
  "calculationToken": "signed-jwt-so-step-3-cant-be-tampered-with"
}
```

> The `calculationToken` is a short-lived signed JWT containing `{ receiptId, quantity, totalFee, expiresIn: 15min }`. Step 3 requires it — prevents the client from tampering with fees in devtools.

### Step 2 — Summary screen (Image 6)
Pure display. "Download PDF" and "Print summary" both hit:
`GET /withdrawals/calculate-pdf?token=<calculationToken>` → streams a PDF of the summary.

User clicks **Continue** → frontend calls:

### Step 3 — Create the withdrawal request & show payment
`POST /withdrawals`

**Request:**
```json
{ "calculationToken": "..." }
```

**Backend logic:**
- Validate token, decode payload.
- Create `withdrawal_requests` row with `status=PENDING_PAYMENT`, snapshot all fees.
- Create a matching `transactions` row with `type=WITHDRAWAL, status=PENDING, amount=total_fee`.
- Generate a **virtual bank account** (for demo: a static seeded account — Fairmoney Microfinance Bank LTD / 1234567890 / John Doe — per Image 7).
- Return:
```json
{
  "withdrawalId": "uuid",
  "transactionNumber": "TXN-2025-000124",
  "amount": 35000,
  "paymentMethod": "BANK_TRANSFER",
  "paymentDetails": {
    "bankName": "Fairmoney Microfinance Bank LTD",
    "accountNumber": "1234567890",
    "accountName": "John Doe",
    "reference": "SS-WD-ABC123"
  },
  "expiresAt": "2025-04-24T15:00:00Z"
}
```

### Step 4 — Client confirms payment (Image 7)
Client clicks **"Yes, I have made payment"** → frontend calls:
`POST /withdrawals/:id/confirm-payment`

**Backend logic (all in a DB transaction):**
1. Move withdrawal to `PAID_PENDING_APPROVAL`.
2. **Demo shortcut:** auto-approve → `APPROVED` → immediately `COMPLETED`.
3. Decrement `warehouse_receipt.quantity_available` by `quantity_requested`.
4. If `quantity_available == 0` → set receipt status to `WITHDRAWN`. Else `PARTIALLY_WITHDRAWN`.
5. Update `transactions` row: `status=COMPLETED, completed_at=now`.
6. **Generate a `receipts` row:**
   - `receipt_number = "RCT-WD-{YYYY}-{seq}"`
   - `type = WITHDRAWAL`
   - Links to `transaction_id`, `warehouse_receipt_id`, `client_id`.
   - `fee_breakdown` snapshot from the withdrawal.
   - `status = ISSUED`.
7. Fire-and-forget: generate PDF, upload to storage, backfill `receipts.pdf_url`.
8. Create a `notifications` row for the client: "Withdrawal receipt RCT-WD-2025-0004 is ready."
9. Return the fully populated receipt so the frontend can route to a success screen / toast and refresh the dashboard.

**Response:**
```json
{
  "status": "COMPLETED",
  "receipt": {
    "receiptNumber": "RCT-WD-2025-0004",
    "type": "WITHDRAWAL",
    "issuedAt": "...",
    "pdfUrl": "/api/v1/receipts/:id/pdf",
    "summary": { /* same shape as Step 2 summary */ }
  },
  "updatedWarehouseReceipt": {
    "receiptNumber": "WR-2025-0001",
    "newStatus": "WITHDRAWN",
    "quantityAvailable": 0
  }
}
```

### Reload behaviour
After Step 4 the frontend refetches `/dashboard/summary` and `/receipts` — all counters (Total Volume Held, Total Available, Total Withdrawals, Recent Receipts) update in real time. **This is the demo's punchline — confirm it works end-to-end before the live presentation.**

---

## 7. Receipt Numbering & Generation Rules

Two receipt families, never mix them:

- **Warehouse Receipts** (the asset): `WR-{YYYY}-{4-digit sequence}` — e.g. `WR-2025-0001`. Created at deposit time by the Warehouse Manager.
- **Transaction Receipts** (the proof of action): `RCT-{TYPE}-{YYYY}-{4-digit sequence}` where TYPE ∈ `DP` (deposit), `WD` (withdrawal), `LN` (loan), `TR` (trade), `FE` (fee). e.g. `RCT-WD-2025-0004`.

Sequences are **per tenant, per year**. Use a Postgres sequence or a row-locked counter table to avoid race conditions.

### PDF generation
- Use `pdfkit`, `puppeteer`, or `@react-pdf/renderer`.
- Template must include: SecureStore logo, receipt number, date, client name, warehouse, commodity, quantity & unit, fee breakdown, total, digital signature/hash for tamper detection (`sha256(receipt_number + issued_at + total + secret)` stored in `metadata`).
- Do PDF generation in a BullMQ job to avoid blocking the API response. Frontend can poll `pdfUrl` or subscribe via websocket. For demo simplicity you may generate synchronously — just keep it under 2s.

---

## 8. Validation & Business Rules (Enforce Server-Side Always)

- Client can only withdraw from their own receipts.
- Withdrawal quantity must be `> 0` and `<= quantity_available`.
- A PLEDGED or LIEN receipt **cannot** be withdrawn or traded — return `409 RECEIPT_LOCKED`.
- A WITHDRAWN receipt cannot be pledged.
- Loans: `sum(pledge_amounts * price_per_unit) * financier.max_ltv >= loan_amount`.
- Fee calculations must be recomputed server-side on `POST /withdrawals` using the token-carried inputs — never trust the client's numbers.
- Planned withdrawal date must be today or future.

---

## 9. Security

- `bcrypt` for password hashing (cost ≥ 12).
- JWT access token TTL = 15 min, refresh token TTL = 7 days, rotate on use.
- All role/ownership checks in a central `RolesGuard` + `OwnershipInterceptor`.
- Rate-limit `/auth/*` endpoints (5/min/IP).
- Audit-log every state-changing action.
- CORS: allow only the frontend origin.
- Validate every DTO with `class-validator`. Reject unknown fields.

---

## 10. NestJS Module Layout

```
src/
  auth/              (AuthModule, JwtStrategy, RolesGuard)
  users/
  tenants/
  warehouses/
  commodities/
  warehouse-receipts/
  transactions/
  receipts/          (PDF generation, numbering service)
  withdrawals/       ← primary demo module
  loans/
  trades/
  financiers/
  notifications/
  dashboard/         (aggregation service reading from the above)
  reports/
  common/
    decorators/  (@Roles, @CurrentUser, @Tenant)
    guards/      (JwtAuthGuard, RolesGuard, OwnershipGuard)
    interceptors/
    filters/     (global exception filter → { success, error })
    dto/
  database/
    migrations/
    seeds/       (00-tenants, 01-users, 02-warehouses, 03-commodities,
                  04-financiers, 05-warehouse-receipts, 06-history)
```

---

## 11. Demo-Day Smoke-Test Checklist

Run through this immediately before the demo.

1. ☐ `POST /auth/login` with `demo@securestore.com / Demo@123` returns a token.
2. ☐ `GET /dashboard/summary` returns non-zero figures matching Image 2 shape.
3. ☐ `GET /receipts?status=all` returns the seeded WR list.
4. ☐ `GET /commodities/mine` returns exactly [Maize, Cement, Ironrods, Rice, Tanks, Doors, Wheat, Palm Oil].
5. ☐ `GET /commodities/{maize-id}/overview` returns 4 stat cards + receipt cards.
6. ☐ `POST /withdrawals/calculate` with a valid Maize receipt returns correct fees (verify math by hand: qty × rate × months + handling).
7. ☐ `POST /withdrawals` returns Fairmoney account details.
8. ☐ `POST /withdrawals/:id/confirm-payment` returns a `RCT-WD-...` receipt.
9. ☐ Dashboard reloads and `Total Volume Held` has decreased by the withdrawn quantity.
10. ☐ New receipt appears at the top of **Recent Receipts**.
11. ☐ PDF of the withdrawal receipt downloads and displays correctly.
12. ☐ `GET /transactions` includes the new WITHDRAWAL row with `status=COMPLETED`.

---

## 12. Post-Demo / Next Build

In priority order for after tomorrow:
1. Full Loan flow persistence + Financier approval workspace.
2. Warehouse Manager portal (deposit creation, WR issuance, client onboarding).
3. Tenant Admin portal (warehouses, commodities, user management).
4. Trade marketplace + escrow.
5. Real payment gateway (Paystack/Flutterwave) replacing the static bank detail stub.
6. Websocket push for real-time dashboard updates instead of refetch-on-action.
7. Multi-tenant theming (tenant-scoped logos/colours pulled from `tenants` table).

---

**End of spec.** Questions on ambiguous behaviour go to the product lead before the dev starts coding — especially around fee calculation periods and status transitions.
