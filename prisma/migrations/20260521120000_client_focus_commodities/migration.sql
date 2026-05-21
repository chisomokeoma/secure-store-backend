-- Multi-focus commodities for clients.
--
-- Drops the single `focus_commodity_id` FK on `client_profiles` and replaces
-- it with a `client_focus_commodities` join table so a client can target
-- multiple commodities. Existing single-FK rows are backfilled into the
-- join before the column is dropped, so no data is lost.

BEGIN;

-- Needed by the backfill below; cheap no-op if already present.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Create the join table.
CREATE TABLE "client_focus_commodities" (
  "id"                TEXT        NOT NULL,
  "tenant_id"         TEXT        NOT NULL,
  "client_profile_id" TEXT        NOT NULL,
  "commodity_id"      TEXT        NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_focus_commodities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_focus_commodities_client_profile_id_commodity_id_key"
  ON "client_focus_commodities" ("client_profile_id", "commodity_id");

CREATE INDEX "client_focus_commodities_tenant_id_idx"
  ON "client_focus_commodities" ("tenant_id");

CREATE INDEX "client_focus_commodities_commodity_id_idx"
  ON "client_focus_commodities" ("commodity_id");

ALTER TABLE "client_focus_commodities"
  ADD CONSTRAINT "client_focus_commodities_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "client_focus_commodities"
  ADD CONSTRAINT "client_focus_commodities_client_profile_id_fkey"
  FOREIGN KEY ("client_profile_id") REFERENCES "client_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_focus_commodities"
  ADD CONSTRAINT "client_focus_commodities_commodity_id_fkey"
  FOREIGN KEY ("commodity_id") REFERENCES "commodities"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2) Backfill from the legacy single-FK column. UUID v4 via pgcrypto's
--    gen_random_uuid(); the extension is already enabled by the init
--    migration. Skip nulls.
INSERT INTO "client_focus_commodities"
  ("id", "tenant_id", "client_profile_id", "commodity_id", "created_at")
SELECT
  gen_random_uuid()::text,
  cp."tenant_id",
  cp."id",
  cp."focus_commodity_id",
  NOW()
FROM "client_profiles" cp
WHERE cp."focus_commodity_id" IS NOT NULL
ON CONFLICT ("client_profile_id", "commodity_id") DO NOTHING;

-- 3) Drop the legacy FK + column.
ALTER TABLE "client_profiles"
  DROP CONSTRAINT IF EXISTS "client_profiles_focus_commodity_id_fkey";

ALTER TABLE "client_profiles"
  DROP COLUMN IF EXISTS "focus_commodity_id";

COMMIT;
