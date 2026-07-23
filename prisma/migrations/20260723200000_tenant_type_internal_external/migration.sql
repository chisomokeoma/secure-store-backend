-- ─────────────────────────────────────────────────────────────────────────
-- Tenant.type: INTERNAL vs EXTERNAL
-- ─────────────────────────────────────────────────────────────────────────
--
-- Product-owner decision (2026-07-23): tenants come in two flavours.
-- INTERNAL = SecureStore's own operations (our own WMs / clients);
-- EXTERNAL = paying customer collateral managers (Sahel etc.).
--
-- Only EXTERNAL tenants are subject to commercial-lever suspension.
-- INTERNAL tenants cannot be suspended (we don't bill ourselves) — the
-- service rejects the call defensively and the GA UI hides / disables
-- the button.
--
-- Existing rows: the first tenant on the platform is our own seeded
-- SecureStore, which we backfill as INTERNAL. Any others (unlikely but
-- possible) stay at the EXTERNAL default. Adjust manually if wrong.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantType') THEN
    CREATE TYPE "TenantType" AS ENUM ('INTERNAL', 'EXTERNAL');
  END IF;
END $$;

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "type" "TenantType" NOT NULL DEFAULT 'EXTERNAL';

-- Backfill: SecureStore is our own operational tenant.
UPDATE "tenants" SET "type" = 'INTERNAL' WHERE "slug" = 'securestore';
