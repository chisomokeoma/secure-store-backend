-- =====================================================================
-- Phase 1 (3c) — Tightening. APPLY ONLY AFTER the backfill script (3b)
-- has run successfully:  npm run phase1:backfill && npm run phase1:verify
--
-- The guard below makes this migration SAFE even if `prisma migrate deploy`
-- runs it prematurely: it aborts (whole migration rolls back) instead of
-- corrupting data. See prisma/backfill/README.md for the runbook.
-- =====================================================================

-- ---------- Safety guard: backfill must be complete ----------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "receipts" WHERE "root_receipt_id" IS NULL) THEN
    RAISE EXCEPTION
      'Phase 1 backfill incomplete: receipts.root_receipt_id has NULLs. Run "npm run phase1:backfill" (then phase1:verify) BEFORE applying this migration.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "receipts" p
    JOIN "receipts" c ON c."parent_receipt_id" = p."id"
    WHERE p."is_parent" = true
    GROUP BY p."id", p."quantity"
    HAVING p."quantity" <> COALESCE(SUM(c."quantity"), 0)
  ) THEN
    RAISE EXCEPTION
      'Phase 1 invariant violated: a parent receipt does not equal the sum of its children. Resolve via the backfill/verify scripts before tightening.';
  END IF;
END $$;

-- ---------- root_receipt_id: NOT NULL + self FK ----------
ALTER TABLE "receipts" ALTER COLUMN "root_receipt_id" SET NOT NULL;

ALTER TABLE "receipts" ADD CONSTRAINT "receipts_root_receipt_id_fkey"
  FOREIGN KEY ("root_receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receipts" ADD CONSTRAINT "receipts_source_event_id_fkey"
  FOREIGN KEY ("source_event_id") REFERENCES "inventory_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- New / composite indexes ----------
CREATE INDEX "receipts_root_receipt_id_idx" ON "receipts"("root_receipt_id");
CREATE INDEX "receipts_parent_receipt_id_idx" ON "receipts"("parent_receipt_id");
CREATE INDEX "receipts_source_event_id_idx" ON "receipts"("source_event_id");
CREATE INDEX "receipts_tenant_id_status_idx" ON "receipts"("tenant_id", "status");
CREATE INDEX "receipts_client_id_status_commodity_id_idx" ON "receipts"("client_id", "status", "commodity_id");
CREATE INDEX "receipts_status_is_parent_idx" ON "receipts"("status", "is_parent");

-- ---------- Drop the now-unused mutable balance column ----------
ALTER TABLE "receipts" DROP COLUMN "quantity_available";

-- ---------- OPTIONAL append-only hardening for the ledger ----------
-- Enable per ops policy (the app role must never UPDATE/DELETE inventory_events).
-- Replace <app_role> with the runtime DB role before enabling.
-- REVOKE UPDATE, DELETE ON "inventory_events" FROM <app_role>;
