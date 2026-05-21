-- =====================================================================
-- Phase 1 (3a) — Receipt-tree + ledger DDL
-- Non-destructive structural changes only. New columns are added NULLABLE;
-- root_receipt_id NOT NULL + FK, composite indexes, and dropping
-- quantity_available are DEFERRED to 3c, AFTER the backfill script runs.
-- This file is transaction-safe (no ALTER TYPE ... ADD VALUE / CONCURRENTLY).
-- =====================================================================

-- ---------- New enums ----------
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TYPE "TxnType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'LOAN', 'TRADE', 'ADJUSTMENT');

CREATE TYPE "InventoryEventType" AS ENUM (
  'DEPOSIT', 'APPROVED', 'REJECTED', 'HOLD_PLACED', 'HOLD_RELEASED',
  'CONSUMED', 'OWNERSHIP_TRANSFERRED', 'SEIZED', 'EXPIRED', 'CANCELLED',
  'LEGACY_RECONCILIATION'
);

-- ---------- Reshape ReceiptStatus (static value remap) ----------
-- LIEN -> HELD_TRADE, PLEDGED -> HELD_LOAN. ACTIVE/CANCELLED/EXPIRED/WITHDRAWN
-- carry over unchanged. Promotion of split parents to SPLIT is data-dependent
-- and handled by the backfill script (3b), not here.
CREATE TYPE "ReceiptStatus_new" AS ENUM (
  'ACTIVE', 'PENDING_APPROVAL', 'HELD_WITHDRAWAL', 'HELD_LOAN', 'HELD_TRADE',
  'WITHDRAWN', 'TRADED_OUT', 'SEIZED', 'EXPIRED', 'CANCELLED', 'SPLIT'
);

ALTER TABLE "receipts" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "receipts" ALTER COLUMN "status" TYPE "ReceiptStatus_new" USING (
  CASE "status"::text
    WHEN 'LIEN' THEN 'HELD_TRADE'
    WHEN 'PLEDGED' THEN 'HELD_LOAN'
    ELSE "status"::text
  END::"ReceiptStatus_new"
);

DROP TYPE "ReceiptStatus";
ALTER TYPE "ReceiptStatus_new" RENAME TO "ReceiptStatus";

ALTER TABLE "receipts" ALTER COLUMN "status" SET DEFAULT 'PENDING_APPROVAL';

-- ---------- approval_status: TEXT -> ApprovalStatus enum (NOT NULL) ----------
UPDATE "receipts"
  SET "approval_status" = 'PENDING'
  WHERE "approval_status" IS NULL
     OR "approval_status" NOT IN ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "receipts" ALTER COLUMN "approval_status" DROP DEFAULT;

ALTER TABLE "receipts"
  ALTER COLUMN "approval_status" TYPE "ApprovalStatus"
  USING ("approval_status"::"ApprovalStatus");

ALTER TABLE "receipts" ALTER COLUMN "approval_status" SET DEFAULT 'PENDING';
ALTER TABLE "receipts" ALTER COLUMN "approval_status" SET NOT NULL;

-- ---------- quantity: DOUBLE PRECISION -> DECIMAL(18,3) ----------
-- Locked decision: exact reconciliation. quantity_available is left in place
-- through 3b and dropped in 3c.
ALTER TABLE "receipts"
  ALTER COLUMN "quantity" TYPE DECIMAL(18,3) USING ("quantity"::numeric(18,3));

-- ---------- New nullable receipt columns (tightened in 3c) ----------
ALTER TABLE "receipts"
  ADD COLUMN "root_receipt_id" TEXT,
  ADD COLUMN "is_parent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "superseded_at" TIMESTAMP(3),
  ADD COLUMN "source_txn_type" "TxnType",
  ADD COLUMN "source_txn_id" TEXT,
  ADD COLUMN "source_event_id" TEXT;

-- ---------- Append-only inventory ledger ----------
CREATE TABLE "inventory_events" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "root_receipt_id" TEXT NOT NULL,
  "from_receipt_id" TEXT,
  "event_type" "InventoryEventType" NOT NULL,
  "txn_type" "TxnType",
  "txn_id" TEXT,
  "quantity" DECIMAL(18,3) NOT NULL,
  "actor_user_id" TEXT,
  "idempotency_key" TEXT,
  "reversal_of_event_id" TEXT,
  "metadata" JSONB,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_events_idempotency_key_key" ON "inventory_events"("idempotency_key");
CREATE INDEX "inventory_events_root_receipt_id_idx" ON "inventory_events"("root_receipt_id");
CREATE INDEX "inventory_events_txn_type_txn_id_idx" ON "inventory_events"("txn_type", "txn_id");
CREATE INDEX "inventory_events_tenant_id_occurred_at_idx" ON "inventory_events"("tenant_id", "occurred_at");
CREATE INDEX "inventory_events_from_receipt_id_idx" ON "inventory_events"("from_receipt_id");

ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_from_receipt_id_fkey"
  FOREIGN KEY ("from_receipt_id") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_reversal_of_event_id_fkey"
  FOREIGN KEY ("reversal_of_event_id") REFERENCES "inventory_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
