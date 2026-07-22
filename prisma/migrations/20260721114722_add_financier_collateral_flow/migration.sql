-- CreateEnum
CREATE TYPE "FinancierOrgStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "WarehouseLinkStatus" AS ENUM ('PENDING', 'ACTIVE', 'OFFBOARDED');

-- CreateEnum
CREATE TYPE "PledgeStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LienStatus" AS ENUM ('ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED', 'FORCE_RELEASED');

-- CreateEnum
CREATE TYPE "ReleaseRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PLEDGE_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'PLEDGE_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE 'PLEDGE_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'PLEDGE_EXPIRED';
ALTER TYPE "NotificationType" ADD VALUE 'RELEASE_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'RELEASE_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'RELEASE_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'LIEN_FORCE_RELEASED';
ALTER TYPE "NotificationType" ADD VALUE 'DEPOSIT_LINKED_WAREHOUSE';
ALTER TYPE "NotificationType" ADD VALUE 'WITHDRAWAL_BLOCKED_BY_LIEN';
ALTER TYPE "NotificationType" ADD VALUE 'WAREHOUSE_LINK_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'WAREHOUSE_LINK_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'WAREHOUSE_LINK_REJECTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReceiptStatus" ADD VALUE 'HELD_PLEDGE_PENDING';
ALTER TYPE "ReceiptStatus" ADD VALUE 'HELD_LIEN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionOtpPurpose" ADD VALUE 'PLEDGE_ACCEPT';
ALTER TYPE "TransactionOtpPurpose" ADD VALUE 'RELEASE_APPROVE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "financier_org_id" TEXT;

-- CreateTable
CREATE TABLE "financier_orgs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "license_number" TEXT,
    "logo_url" TEXT,
    "status" "FinancierOrgStatus" NOT NULL DEFAULT 'ACTIVE',
    "pledge_ttl_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financier_orgs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_links" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "financier_org_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "status" "WarehouseLinkStatus" NOT NULL DEFAULT 'PENDING',
    "agreement_doc_url" TEXT,
    "signed_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pledges" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "held_receipt_id" TEXT,
    "client_id" TEXT NOT NULL,
    "financier_org_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "quantity" DECIMAL(20,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "valuation_at_pledge" DECIMAL(20,2),
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "PledgeStatus" NOT NULL DEFAULT 'PENDING',
    "client_note" TEXT,
    "decision_reason" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pledges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liens" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "pledge_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "financier_org_id" TEXT NOT NULL,
    "quantity" DECIMAL(20,4) NOT NULL,
    "remaining_quantity" DECIMAL(20,4) NOT NULL,
    "status" "LienStatus" NOT NULL DEFAULT 'ACTIVE',
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "liens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "financier_org_id" TEXT NOT NULL,
    "requested_date" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "status" "ReleaseRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decision_reason" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "release_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_request_lines" (
    "id" TEXT NOT NULL,
    "release_request_id" TEXT NOT NULL,
    "lien_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "quantity" DECIMAL(20,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_request_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "force_releases" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "lien_id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "court_order_doc_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "force_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commodity_prices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "commodity_id" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "price_per_unit" DECIMAL(20,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "set_by_id" TEXT NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commodity_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "financier_orgs_tenant_id_idx" ON "financier_orgs"("tenant_id");

-- CreateIndex
CREATE INDEX "financier_orgs_status_idx" ON "financier_orgs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "financier_orgs_tenant_id_name_key" ON "financier_orgs"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "warehouse_links_financier_org_id_warehouse_id_status_idx" ON "warehouse_links"("financier_org_id", "warehouse_id", "status");

-- CreateIndex
CREATE INDEX "warehouse_links_warehouse_id_status_idx" ON "warehouse_links"("warehouse_id", "status");

-- CreateIndex
CREATE INDEX "warehouse_links_tenant_id_status_idx" ON "warehouse_links"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pledges_held_receipt_id_key" ON "pledges"("held_receipt_id");

-- CreateIndex
CREATE INDEX "pledges_tenant_id_idx" ON "pledges"("tenant_id");

-- CreateIndex
CREATE INDEX "pledges_client_id_status_idx" ON "pledges"("client_id", "status");

-- CreateIndex
CREATE INDEX "pledges_financier_org_id_status_idx" ON "pledges"("financier_org_id", "status");

-- CreateIndex
CREATE INDEX "pledges_status_expires_at_idx" ON "pledges"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "liens_pledge_id_key" ON "liens"("pledge_id");

-- CreateIndex
CREATE INDEX "liens_tenant_id_idx" ON "liens"("tenant_id");

-- CreateIndex
CREATE INDEX "liens_client_id_status_idx" ON "liens"("client_id", "status");

-- CreateIndex
CREATE INDEX "liens_financier_org_id_status_idx" ON "liens"("financier_org_id", "status");

-- CreateIndex
CREATE INDEX "liens_receipt_id_idx" ON "liens"("receipt_id");

-- CreateIndex
CREATE INDEX "release_requests_tenant_id_idx" ON "release_requests"("tenant_id");

-- CreateIndex
CREATE INDEX "release_requests_client_id_status_idx" ON "release_requests"("client_id", "status");

-- CreateIndex
CREATE INDEX "release_requests_financier_org_id_status_idx" ON "release_requests"("financier_org_id", "status");

-- CreateIndex
CREATE INDEX "release_request_lines_release_request_id_idx" ON "release_request_lines"("release_request_id");

-- CreateIndex
CREATE INDEX "release_request_lines_lien_id_idx" ON "release_request_lines"("lien_id");

-- CreateIndex
CREATE UNIQUE INDEX "force_releases_lien_id_key" ON "force_releases"("lien_id");

-- CreateIndex
CREATE INDEX "force_releases_tenant_id_idx" ON "force_releases"("tenant_id");

-- CreateIndex
CREATE INDEX "force_releases_admin_id_idx" ON "force_releases"("admin_id");

-- CreateIndex
CREATE INDEX "commodity_prices_tenant_id_commodity_id_effective_at_idx" ON "commodity_prices"("tenant_id", "commodity_id", "effective_at" DESC);

-- CreateIndex
CREATE INDEX "users_financier_org_id_idx" ON "users"("financier_org_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_financier_org_id_fkey" FOREIGN KEY ("financier_org_id") REFERENCES "financier_orgs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financier_orgs" ADD CONSTRAINT "financier_orgs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_links" ADD CONSTRAINT "warehouse_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_links" ADD CONSTRAINT "warehouse_links_financier_org_id_fkey" FOREIGN KEY ("financier_org_id") REFERENCES "financier_orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_links" ADD CONSTRAINT "warehouse_links_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_links" ADD CONSTRAINT "warehouse_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_links" ADD CONSTRAINT "warehouse_links_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_held_receipt_id_fkey" FOREIGN KEY ("held_receipt_id") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_financier_org_id_fkey" FOREIGN KEY ("financier_org_id") REFERENCES "financier_orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liens" ADD CONSTRAINT "liens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liens" ADD CONSTRAINT "liens_pledge_id_fkey" FOREIGN KEY ("pledge_id") REFERENCES "pledges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liens" ADD CONSTRAINT "liens_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liens" ADD CONSTRAINT "liens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liens" ADD CONSTRAINT "liens_financier_org_id_fkey" FOREIGN KEY ("financier_org_id") REFERENCES "financier_orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_requests" ADD CONSTRAINT "release_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_requests" ADD CONSTRAINT "release_requests_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_requests" ADD CONSTRAINT "release_requests_financier_org_id_fkey" FOREIGN KEY ("financier_org_id") REFERENCES "financier_orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_requests" ADD CONSTRAINT "release_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_request_lines" ADD CONSTRAINT "release_request_lines_release_request_id_fkey" FOREIGN KEY ("release_request_id") REFERENCES "release_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_request_lines" ADD CONSTRAINT "release_request_lines_lien_id_fkey" FOREIGN KEY ("lien_id") REFERENCES "liens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_request_lines" ADD CONSTRAINT "release_request_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "force_releases" ADD CONSTRAINT "force_releases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "force_releases" ADD CONSTRAINT "force_releases_lien_id_fkey" FOREIGN KEY ("lien_id") REFERENCES "liens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "force_releases" ADD CONSTRAINT "force_releases_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commodity_prices" ADD CONSTRAINT "commodity_prices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commodity_prices" ADD CONSTRAINT "commodity_prices_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commodity_prices" ADD CONSTRAINT "commodity_prices_set_by_id_fkey" FOREIGN KEY ("set_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
