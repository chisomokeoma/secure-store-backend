-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING_PAYMENT', 'PAID_PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'COMPLETED');

-- AlterEnum
ALTER TYPE "MeasurementUnit" ADD VALUE 'LITRE';

-- AlterTable
ALTER TABLE "receipts" ADD COLUMN     "quantity_available" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "warehouse_commodities" (
    "id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "commodity_id" TEXT NOT NULL,
    "storage_fee_per_unit" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_commodities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "planned_date" TIMESTAMP(3) NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "storage_fee" DOUBLE PRECISION NOT NULL,
    "handling_fee" DOUBLE PRECISION NOT NULL,
    "total_fee" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_commodities_warehouse_id_commodity_id_key" ON "warehouse_commodities"("warehouse_id", "commodity_id");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_reference_key" ON "withdrawals"("reference");

-- CreateIndex
CREATE INDEX "withdrawals_client_id_idx" ON "withdrawals"("client_id");

-- CreateIndex
CREATE INDEX "withdrawals_receipt_id_idx" ON "withdrawals"("receipt_id");

-- CreateIndex
CREATE INDEX "withdrawals_status_idx" ON "withdrawals"("status");

-- AddForeignKey
ALTER TABLE "warehouse_commodities" ADD CONSTRAINT "warehouse_commodities_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_commodities" ADD CONSTRAINT "warehouse_commodities_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
