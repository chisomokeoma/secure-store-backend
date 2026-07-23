-- ─────────────────────────────────────────────────────────────────────────
-- Tenant: add status + commercial contact block for the Global Admin module
-- ─────────────────────────────────────────────────────────────────────────
--
-- Introduces:
--   • TenantStatus enum (ACTIVE | SUSPENDED)
--   • status column, defaulted to ACTIVE for all existing rows
--   • logoUrl / contactEmail / phoneNumber / address (all optional)
--
-- All operations idempotent (IF EXISTS / IF NOT EXISTS) so a partial
-- re-run is safe.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantStatus') THEN
    CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
  END IF;
END $$;

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "logo_url" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "contact_email" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "phone_number" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "address" TEXT;
