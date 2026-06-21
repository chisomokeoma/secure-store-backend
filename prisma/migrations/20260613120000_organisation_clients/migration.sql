-- Organisation clients. ClientProfile gains a `mode` discriminator
-- (INDIVIDUAL | ORGANIZATION), a corporate-info block, an authorised-rep
-- KYC block, and two child tables (client_directors + client_documents).
--
-- All new columns are nullable / default-INDIVIDUAL so existing rows stay
-- valid. The INDIVIDUAL flow's behaviour is unchanged.

BEGIN;

-- ── New enums ────────────────────────────────────────────────────────────
CREATE TYPE "ClientMode" AS ENUM (
  'INDIVIDUAL',
  'ORGANIZATION'
);

CREATE TYPE "CompanyCategory" AS ENUM (
  'PARTNERSHIP',
  'PLC',
  'LLC',
  'COOPERATIVE',
  'OTHER'
);

CREATE TYPE "IdType" AS ENUM (
  'NIN',
  'INTERNATIONAL_PASSPORT',
  'DRIVERS_LICENSE',
  'VOTERS_CARD'
);

CREATE TYPE "MaritalStatus" AS ENUM (
  'SINGLE',
  'MARRIED',
  'DIVORCED',
  'WIDOWED'
);

CREATE TYPE "ClientDocumentType" AS ENUM (
  'CERTIFICATE_OF_INCORPORATION',
  'MEMORANDUM_AND_ARTICLES',
  'CAC_FORM_2_OR_7',
  'CAC_STATUS_REPORT',
  'TIN_CERTIFICATE',
  'BOARD_RESOLUTION',
  'COMPANY_UTILITY_BILL',
  'PASSPORT_PHOTO',
  'MEANS_OF_ID',
  'UTILITY_BILL',
  'OTHER'
);

CREATE TYPE "ClientDocumentScope" AS ENUM (
  'COMPANY',
  'REPRESENTATIVE',
  'DIRECTOR'
);

-- ── ClientProfile extensions ─────────────────────────────────────────────
ALTER TABLE "client_profiles"
  ADD COLUMN "mode" "ClientMode" NOT NULL DEFAULT 'INDIVIDUAL',
  -- Organisation
  ADD COLUMN "rc_number"              TEXT,
  ADD COLUMN "company_name"           TEXT,
  ADD COLUMN "company_category"       "CompanyCategory",
  ADD COLUMN "company_category_other" TEXT,
  ADD COLUMN "date_of_incorporation"  TIMESTAMP(3),
  ADD COLUMN "nature_of_business"     TEXT,
  ADD COLUMN "sector_industry"        TEXT,
  ADD COLUMN "business_address"       TEXT,
  ADD COLUMN "tin"                    TEXT,
  -- Authorised Rep / extended KYC
  ADD COLUMN "representative_designation" TEXT,
  ADD COLUMN "other_names"                TEXT,
  ADD COLUMN "mothers_maiden_name"        TEXT,
  ADD COLUMN "marital_status"             "MaritalStatus",
  ADD COLUMN "id_type"                    "IdType",
  ADD COLUMN "id_number"                  TEXT,
  ADD COLUMN "id_issue_date"              TIMESTAMP(3),
  ADD COLUMN "id_expiry_date"             TIMESTAMP(3);

-- ── client_directors ─────────────────────────────────────────────────────
CREATE TABLE "client_directors" (
  "id"                  TEXT NOT NULL,
  "tenant_id"           TEXT NOT NULL,
  "client_profile_id"   TEXT NOT NULL,
  "first_name"          TEXT NOT NULL,
  "last_name"           TEXT NOT NULL,
  "other_names"         TEXT,
  "designation"         TEXT,
  "residential_address" TEXT,
  "phone_number"        TEXT,
  "email"               TEXT,
  "mothers_maiden_name" TEXT,
  "gender"              TEXT,
  "date_of_birth"       TIMESTAMP(3),
  "nationality"         TEXT,
  "state_of_origin"     TEXT,
  "marital_status"      "MaritalStatus",
  "bvn"                 TEXT,
  "nin"                 TEXT,
  "id_type"             "IdType",
  "id_number"           TEXT,
  "id_issue_date"       TIMESTAMP(3),
  "id_expiry_date"      TIMESTAMP(3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "client_directors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_directors_client_profile_id_idx"
  ON "client_directors" ("client_profile_id");
CREATE INDEX "client_directors_tenant_id_idx"
  ON "client_directors" ("tenant_id");

ALTER TABLE "client_directors"
  ADD CONSTRAINT "client_directors_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "client_directors"
  ADD CONSTRAINT "client_directors_client_profile_id_fkey"
  FOREIGN KEY ("client_profile_id") REFERENCES "client_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── client_documents ─────────────────────────────────────────────────────
CREATE TABLE "client_documents" (
  "id"                TEXT NOT NULL,
  "tenant_id"         TEXT NOT NULL,
  "client_profile_id" TEXT NOT NULL,
  "type"              "ClientDocumentType"  NOT NULL,
  "scope"             "ClientDocumentScope" NOT NULL,
  "scope_ref_id"      TEXT,
  "url"               TEXT NOT NULL,
  "file_name"         TEXT,
  "file_size"         INTEGER,
  "mime_type"         TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_documents_client_profile_id_scope_idx"
  ON "client_documents" ("client_profile_id", "scope");
CREATE INDEX "client_documents_tenant_id_idx"
  ON "client_documents" ("tenant_id");

ALTER TABLE "client_documents"
  ADD CONSTRAINT "client_documents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "client_documents"
  ADD CONSTRAINT "client_documents_client_profile_id_fkey"
  FOREIGN KEY ("client_profile_id") REFERENCES "client_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
