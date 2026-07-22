-- CreateTable
CREATE TABLE "client_warehouse_attachments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "attached_by_id" TEXT NOT NULL,
    "attached_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detached_by_id" TEXT,
    "detached_at" TIMESTAMP(3),
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_warehouse_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_lookup_audits" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "manager_id" TEXT NOT NULL,
    "warehouse_id" TEXT,
    "identifier_type" TEXT NOT NULL,
    "identifier_hash" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "matched_client_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_lookup_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_warehouse_attachments_client_id_warehouse_id_detache_idx" ON "client_warehouse_attachments"("client_id", "warehouse_id", "detached_at");

-- CreateIndex
CREATE INDEX "client_warehouse_attachments_warehouse_id_tenant_id_detache_idx" ON "client_warehouse_attachments"("warehouse_id", "tenant_id", "detached_at");

-- CreateIndex
CREATE INDEX "client_warehouse_attachments_tenant_id_idx" ON "client_warehouse_attachments"("tenant_id");

-- CreateIndex
CREATE INDEX "client_lookup_audits_manager_id_created_at_idx" ON "client_lookup_audits"("manager_id", "created_at");

-- CreateIndex
CREATE INDEX "client_lookup_audits_tenant_id_created_at_idx" ON "client_lookup_audits"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "client_lookup_audits_identifier_hash_idx" ON "client_lookup_audits"("identifier_hash");

-- AddForeignKey
ALTER TABLE "client_warehouse_attachments" ADD CONSTRAINT "client_warehouse_attachments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_warehouse_attachments" ADD CONSTRAINT "client_warehouse_attachments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_warehouse_attachments" ADD CONSTRAINT "client_warehouse_attachments_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_warehouse_attachments" ADD CONSTRAINT "client_warehouse_attachments_attached_by_id_fkey" FOREIGN KEY ("attached_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_warehouse_attachments" ADD CONSTRAINT "client_warehouse_attachments_detached_by_id_fkey" FOREIGN KEY ("detached_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_lookup_audits" ADD CONSTRAINT "client_lookup_audits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_lookup_audits" ADD CONSTRAINT "client_lookup_audits_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_lookup_audits" ADD CONSTRAINT "client_lookup_audits_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
