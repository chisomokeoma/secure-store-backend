/**
 * Slim production seed — the minimum a fresh tenant needs to be usable:
 *   1. The five role rows (UserRole foreign keys point at these by name).
 *   2. One tenant, slug "securestore".
 *   3. One TENANT_ADMIN user (tenant@securestore.com / Password@1) so the
 *      operator can sign in immediately and configure everything else from
 *      the UI (warehouses, commodities, managers, clients, policies, …).
 *
 * Run with:
 *   npx ts-node prisma/seed.prod.ts
 *
 * Re-running is safe — every write is upsert-ed against a natural key.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import 'dotenv/config';
import * as bcrypt from 'bcrypt';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log('Slim seed — connecting to:', maskDbUrl(process.env.DATABASE_URL));

  // 1. Roles ───────────────────────────────────────────────────────────────
  const roles = [
    { name: 'GLOBAL_ADMIN', description: 'Platform-wide administrator' },
    { name: 'TENANT_ADMIN', description: 'Organisation administrator' },
    { name: 'WAREHOUSE_MANAGER', description: 'Manages a single warehouse' },
    { name: 'FINANCIER', description: 'Loan offering provider' },
    { name: 'CLIENT', description: 'Platform user' },
  ];
  for (const r of roles) {
    await prisma.role.upsert({
      where: { name: r.name },
      update: {},
      create: r,
    });
  }
  console.log(`✓ Roles ensured (${roles.length})`);

  // 2. Tenant ──────────────────────────────────────────────────────────────
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'securestore' },
    update: {},
    create: { name: 'SecureStore', slug: 'securestore' },
  });
  console.log(`✓ Tenant: ${tenant.name} (${tenant.id})`);

  // 3. Tenant admin user ───────────────────────────────────────────────────
  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'TENANT_ADMIN' },
  });
  const passwordHash = await bcrypt.hash('Password@1', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'tenant@securestore.com' },
    update: {},
    create: {
      email: 'tenant@securestore.com',
      password: passwordHash,
      firstName: 'Tenant',
      lastName: 'Admin',
      tenantId: tenant.id,
      status: 'ACTIVE',
      roles: { create: { roleId: adminRole.id } },
    },
  });
  console.log(`✓ TENANT_ADMIN: ${admin.email} (${admin.id})`);
  console.log('  Sign in with:  email=tenant@securestore.com  password=Password@1');

  console.log('\nDone.');
}

function maskDbUrl(url?: string): string {
  if (!url) return '(no DATABASE_URL set)';
  return url.replace(/:[^@]*@/, ':****@');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
