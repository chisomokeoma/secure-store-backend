/*
  Warnings:

  - Made the column `quantity_available` on table `receipts` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('PENDING', 'APPROVED', 'ACTIVE', 'REPAID', 'DEFAULTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('LISTED', 'PENDING_SETTLEMENT', 'SETTLED', 'CANCELLED');

-- AlterTable
ALTER TABLE "receipts" ADD COLUMN     "parent_receipt_id" TEXT,
ALTER COLUMN "quantity_available" SET NOT NULL;

-- CreateTable
CREATE TABLE "loans" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "financier_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "interest_rate" DOUBLE PRECISION NOT NULL,
    "tenure_months" INTEGER NOT NULL,
    "total_interest" DOUBLE PRECISION NOT NULL,
    "monthly_payment" DOUBLE PRECISION NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "approved_at" TIMESTAMP(3),
    "repaid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "buyer_id" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "price_per_unit" DOUBLE PRECISION NOT NULL,
    "total_price" DOUBLE PRECISION NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'LISTED',
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loans_reference_key" ON "loans"("reference");

-- CreateIndex
CREATE INDEX "loans_client_id_idx" ON "loans"("client_id");

-- CreateIndex
CREATE INDEX "loans_receipt_id_idx" ON "loans"("receipt_id");

-- CreateIndex
CREATE INDEX "loans_financier_id_idx" ON "loans"("financier_id");

-- CreateIndex
CREATE INDEX "loans_status_idx" ON "loans"("status");

-- CreateIndex
CREATE UNIQUE INDEX "trades_reference_key" ON "trades"("reference");

-- CreateIndex
CREATE INDEX "trades_seller_id_idx" ON "trades"("seller_id");

-- CreateIndex
CREATE INDEX "trades_buyer_id_idx" ON "trades"("buyer_id");

-- CreateIndex
CREATE INDEX "trades_receipt_id_idx" ON "trades"("receipt_id");

-- CreateIndex
CREATE INDEX "trades_status_idx" ON "trades"("status");

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_parent_receipt_id_fkey" FOREIGN KEY ("parent_receipt_id") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_financier_id_fkey" FOREIGN KEY ("financier_id") REFERENCES "financiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
