-- ─────────────────────────────────────────────────────────────────────────
-- FinancierOrg: drop tenantId (platform-level entity now) + add basic-KYC
-- ─────────────────────────────────────────────────────────────────────────
--
-- Product-owner decision (2026-07-22): Financiers are platform-level
-- entities, peer to Tenants. Both are created and administered by
-- GLOBAL_ADMIN, and a financier partners with warehouses across many
-- tenants — the tenant context flows via WarehouseLink.warehouse.tenantId.
--
-- Existing rows (Beige Bank, Crescent Bank) have their tenant_id dropped
-- but keep their identity — no orgs are deleted. The (tenant_id, name)
-- unique becomes (name) unique globally.
--
-- All operations are idempotent (IF EXISTS / IF NOT EXISTS) so a partial
-- re-run after a mid-migration failure is safe.

-- FK first (may already be dropped from a prior run), then the unique
-- index that references tenant_id (Prisma creates uniques as unique
-- indexes here, not table constraints), then the plain index, then the
-- column itself.
ALTER TABLE "financier_orgs" DROP CONSTRAINT IF EXISTS "financier_orgs_tenant_id_fkey";
DROP INDEX IF EXISTS "financier_orgs_tenant_id_name_key";
DROP INDEX IF EXISTS "financier_orgs_tenant_id_idx";
ALTER TABLE "financier_orgs" DROP COLUMN IF EXISTS "tenant_id";

-- Global name uniqueness — financier names are recognisable brands (CBN
-- publishes the list), so a collision within the platform is a bug not
-- a business case.
CREATE UNIQUE INDEX IF NOT EXISTS "financier_orgs_name_key" ON "financier_orgs"("name");

-- Basic-KYC columns. All nullable — the GA form only requires `name`;
-- the rest can be filled in over time as the financier submits paperwork.
ALTER TABLE "financier_orgs" ADD COLUMN IF NOT EXISTS "contact_email" TEXT;
ALTER TABLE "financier_orgs" ADD COLUMN IF NOT EXISTS "contact_phone" TEXT;
ALTER TABLE "financier_orgs" ADD COLUMN IF NOT EXISTS "registered_address" TEXT;
ALTER TABLE "financier_orgs" ADD COLUMN IF NOT EXISTS "tin" TEXT;
ALTER TABLE "financier_orgs" ADD COLUMN IF NOT EXISTS "regulator" TEXT;
ALTER TABLE "financier_orgs" ADD COLUMN IF NOT EXISTS "website" TEXT;
