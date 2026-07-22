-- AlterTable
ALTER TABLE "client_profiles" ADD COLUMN     "bvn" TEXT,
ADD COLUMN     "nin" TEXT;

-- CreateIndex
CREATE INDEX "client_profiles_tenant_id_nin_idx" ON "client_profiles"("tenant_id", "nin");

-- CreateIndex
CREATE INDEX "client_profiles_tenant_id_bvn_idx" ON "client_profiles"("tenant_id", "bvn");
