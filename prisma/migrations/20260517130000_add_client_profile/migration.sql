-- Additive only: client KYC profile. Safe to `prisma migrate deploy` on the
-- branch (baseline already resolved; Phase 1 applied) — no backfill/guard.

CREATE TYPE "ClientType" AS ENUM ('FARMER', 'TRADER', 'COMPANY', 'OTHER');

CREATE TABLE "client_profiles" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "client_code" TEXT NOT NULL,
  "type" "ClientType" NOT NULL DEFAULT 'FARMER',
  "occupation" TEXT,
  "description" TEXT,
  "nationality" TEXT,
  "state_of_origin" TEXT,
  "lga" TEXT,
  "national_id" TEXT,
  "focus_commodity_id" TEXT,
  "profile_photo_url" TEXT,
  "id_document_url" TEXT,
  "bank_account_name" TEXT,
  "bank_account_number" TEXT,
  "bank_name" TEXT,
  "nok_full_name" TEXT,
  "nok_address" TEXT,
  "nok_phone" TEXT,
  "nok_email" TEXT,
  "nok_relationship" TEXT,
  "registered_by_manager_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "client_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_profiles_user_id_key" ON "client_profiles"("user_id");
CREATE UNIQUE INDEX "client_profiles_client_code_key" ON "client_profiles"("client_code");
CREATE INDEX "client_profiles_tenant_id_idx" ON "client_profiles"("tenant_id");
CREATE INDEX "client_profiles_registered_by_manager_id_idx" ON "client_profiles"("registered_by_manager_id");

ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_focus_commodity_id_fkey"
  FOREIGN KEY ("focus_commodity_id") REFERENCES "commodities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_registered_by_manager_id_fkey"
  FOREIGN KEY ("registered_by_manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
