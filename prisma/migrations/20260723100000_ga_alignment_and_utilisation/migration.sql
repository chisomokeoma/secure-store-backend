-- ─────────────────────────────────────────────────────────────────────────
-- Three related changes bundled since they share the same operational
-- window and no ordering constraint:
--   1. Rename FinancierOrg columns to match the FE contract exactly
--      (contact_phone → phone_number, registered_address → address).
--   2. Make ActivityLog.tenant_id nullable so platform-level events
--      (financier.created, lien.force_released, warehouse_link.approved
--      when a specific tenant isn't the subject) can be logged.
--   3. Add Commodity.standard_density_kg_per_litre so warehouse
--      utilisation math can convert LITRE stock to MT for the
--      utilisationPct display. Nullable — LITRE commodities without a
--      density set are skipped from utilisation rather than approximated.
--
-- All operations idempotent (IF EXISTS / IF NOT EXISTS clauses).

-- ── 1. FinancierOrg column renames ─────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'financier_orgs' AND column_name = 'contact_phone'
  ) THEN
    ALTER TABLE "financier_orgs" RENAME COLUMN "contact_phone" TO "phone_number";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'financier_orgs' AND column_name = 'registered_address'
  ) THEN
    ALTER TABLE "financier_orgs" RENAME COLUMN "registered_address" TO "address";
  END IF;
END $$;

-- ── 2. ActivityLog.tenant_id → nullable ────────────────────────────────
ALTER TABLE "activity_logs" ALTER COLUMN "tenant_id" DROP NOT NULL;

-- ── 3. Commodity.standard_density_kg_per_litre ─────────────────────────
ALTER TABLE "commodities"
  ADD COLUMN IF NOT EXISTS "standard_density_kg_per_litre" DOUBLE PRECISION;
