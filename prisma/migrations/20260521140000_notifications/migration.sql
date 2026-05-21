-- Per-user notification surface.
--
-- One row per recipient — broadcasting to a role/group fans out service-side
-- so the read path stays a single indexed lookup. `data` is a JSON blob for
-- light-weight extras the FE may render (counterparty name, amount, …)
-- without dragging another migration.

BEGIN;

CREATE TYPE "NotificationType" AS ENUM (
  'CLIENT_REGISTERED',
  'CLIENT_CREDENTIALS_ISSUED',
  'DEPOSIT_PENDING_APPROVAL',
  'DEPOSIT_APPROVED',
  'DEPOSIT_REJECTED',
  'WITHDRAWAL_REQUESTED',
  'WITHDRAWAL_PAYMENT_CONFIRMED',
  'WITHDRAWAL_APPROVED',
  'WITHDRAWAL_REJECTED',
  'WITHDRAWAL_DISPATCHED',
  'LOAN_REQUESTED',
  'LOAN_APPROVED',
  'LOAN_REJECTED',
  'LOAN_REPAID',
  'LOAN_DEFAULTED',
  'TRADE_LISTED',
  'TRADE_SOLD',
  'TRADE_CANCELLED'
);

CREATE TABLE "notifications" (
  "id"                  TEXT             NOT NULL,
  "tenant_id"           TEXT             NOT NULL,
  "user_id"             TEXT             NOT NULL,
  "type"                "NotificationType" NOT NULL,
  "title"               TEXT             NOT NULL,
  "body"                TEXT,
  "related_entity_type" TEXT,
  "related_entity_id"   TEXT,
  "data"                JSONB,
  "is_read"             BOOLEAN          NOT NULL DEFAULT false,
  "read_at"             TIMESTAMP(3),
  "created_at"          TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_user_id_is_read_created_at_idx"
  ON "notifications" ("user_id", "is_read", "created_at" DESC);

CREATE INDEX "notifications_tenant_id_idx"
  ON "notifications" ("tenant_id");

CREATE INDEX "notifications_user_id_type_created_at_idx"
  ON "notifications" ("user_id", "type", "created_at" DESC);

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
