import {
  PrismaClient,
  MeasurementUnit,
  ReceiptStatus,
  Warehouse,
  Commodity,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL as string,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Starting seed...');

  // 0. Tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'securestore-demo' },
    update: {},
    create: {
      name: 'SecureStore Demo Tenant',
      slug: 'securestore-demo',
    },
  });

  console.log(`Using Tenant: ${tenant.name} (${tenant.id})`);

  // 1. Roles
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

  // 2. Users
  const passwordHash = await bcrypt.hash('Demo@123', 10);
  const users = [
    {
      email: 'admin@securestore.com',
      firstName: 'Admin',
      lastName: 'User',
      password: passwordHash,
      roleNames: ['GLOBAL_ADMIN'],
    },
    {
      email: 'tenant@securestore.com',
      firstName: 'Tenant',
      lastName: 'Admin',
      password: passwordHash,
      roleNames: ['TENANT_ADMIN'],
    },
    {
      email: 'manager@securestore.com',
      firstName: 'Funtua',
      lastName: 'Manager',
      password: passwordHash,
      roleNames: ['WAREHOUSE_MANAGER'],
    },
    {
      email: 'manager2@securestore.com',
      firstName: 'Lagos',
      lastName: 'Manager',
      password: passwordHash,
      roleNames: ['WAREHOUSE_MANAGER'],
    },
    {
      email: 'firstbank@securestore.com',
      firstName: 'First',
      lastName: 'Bank',
      password: passwordHash,
      roleNames: ['FINANCIER'],
    },
    {
      email: 'demo@securestore.com',
      firstName: 'John',
      lastName: 'Doe',
      password: passwordHash,
      roleNames: ['CLIENT', 'WAREHOUSE_MANAGER', 'TENANT_ADMIN'],
    },
  ];

  for (const u of users) {
    const roleIds = (
      await Promise.all(
        u.roleNames.map((name) => prisma.role.findUnique({ where: { name } })),
      )
    )
      .filter((r) => r !== null)
      .map((r) => ({ id: r!.id }));

    await prisma.user.upsert({
      where: { email: u.email },
      update: {
        tenantId: tenant.id,
        roles: {
          deleteMany: {},
          create: roleIds.map((rid) => ({ roleId: rid.id })),
        },
      },
      create: {
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        password: u.password,
        tenantId: tenant.id,
        roles: {
          create: roleIds.map((rid) => ({ roleId: rid.id })),
        },
      },
    });
  }

  const demoUser = await prisma.user.findUnique({
    where: { email: 'demo@securestore.com' },
  });

  // 3. Warehouses
  const warehousesData = [
    { name: 'Funtua Grain Storage', location: 'Funtua, Katsina', code: 'WHS-FNT-001' },
    { name: 'Lagos State Warehouse', location: 'Lagos', code: 'WHS-LAG-002' },
    { name: 'Kano Dry Goods Warehouse', location: 'Kano', code: 'WHS-KAN-003' },
  ];

  const warehouses: Warehouse[] = [];
  for (const w of warehousesData) {
    let wh = await prisma.warehouse.findFirst({ where: { name: w.name } });
    if (!wh) {
      wh = await prisma.warehouse.create({
        data: {
          ...w,
          tenantId: tenant.id,
        },
      });
    } else {
      wh = await prisma.warehouse.update({
        where: { id: wh.id },
        data: { tenantId: tenant.id, code: w.code },
      });
    }
    warehouses.push(wh);
  }

  // 4. Commodities
  const commoditiesData = [
    {
      name: 'Maize',
      unitOfMeasure: MeasurementUnit.METRIC_TON,
      description: 'Grade A, B, C',
      code: 'CMD-MAI-001',
    },
    {
      name: 'Rice',
      unitOfMeasure: MeasurementUnit.KILOGRAM,
      description: 'Grade A, B',
      code: 'CMD-RIC-002',
    },
    {
      name: 'Cement',
      unitOfMeasure: MeasurementUnit.KILOGRAM,
      description: 'Grade A',
      code: 'CMD-CEM-003',
    },
    {
      name: 'Ironrods',
      unitOfMeasure: MeasurementUnit.KILOGRAM,
      description: 'Grade A, B',
      code: 'CMD-IRO-004',
    },
    {
      name: 'Tanks',
      unitOfMeasure: MeasurementUnit.LITRE,
      description: 'Standard',
      code: 'CMD-TNK-005',
    },
    {
      name: 'Doors',
      unitOfMeasure: MeasurementUnit.KILOGRAM,
      description: 'Grade A',
      code: 'CMD-DOR-006',
    },
    {
      name: 'Wheat',
      unitOfMeasure: MeasurementUnit.METRIC_TON,
      description: 'Grade A, B',
      code: 'CMD-WHE-007',
    },
    {
      name: 'Palm Oil',
      unitOfMeasure: MeasurementUnit.LITRE,
      description: 'Grade A',
      code: 'CMD-PAL-008',
    },
  ];

  const commodities: Commodity[] = [];
  for (const c of commoditiesData) {
    let comm = await prisma.commodity.findUnique({ where: { name: c.name } });
    if (!comm) {
      comm = await prisma.commodity.create({
        data: {
          ...c,
          tenantId: tenant.id,
        },
      });
    } else {
      comm = await prisma.commodity.update({
        where: { id: comm.id },
        data: { tenantId: tenant.id, code: c.code },
      });
    }
    commodities.push(comm);
  }

  // Helper to find ID
  const getWH = (name: string) => warehouses.find((w) => w.name === name)?.id;
  const getComm = (name: string) =>
    commodities.find((c) => c.name === name)?.id;

  // 4.5 Warehouse Commodities
  for (const w of warehouses) {
    for (const c of commodities) {
      await prisma.warehouseCommodity.upsert({
        where: {
          warehouseId_commodityId: { warehouseId: w.id, commodityId: c.id },
        },
        update: {
          tenantId: tenant.id,
        },
        create: {
          warehouseId: w.id,
          commodityId: c.id,
          storageFeePerUnit: Math.floor(Math.random() * 20) + 10,
          tenantId: tenant.id,
        },
      });
    }
  }

  // 5. Financiers
  const financiersData = [
    {
      name: 'First Bank Plc',
      interestRate: 8.5,
      minTenure: 3,
      maxTenure: 12,
      approvalTime: '24 hr',
    },
    {
      name: 'Zenith Bank',
      interestRate: 9.0,
      minTenure: 3,
      maxTenure: 12,
      approvalTime: '24 hr',
    },
    {
      name: 'Access Bank',
      interestRate: 8.75,
      minTenure: 3,
      maxTenure: 12,
      approvalTime: '24 hr',
    },
    {
      name: 'GTBank',
      interestRate: 8.0,
      minTenure: 3,
      maxTenure: 12,
      approvalTime: '48 hr',
    },
    {
      name: 'UBA',
      interestRate: 9.25,
      minTenure: 3,
      maxTenure: 12,
      approvalTime: '24 hr',
    },
  ];

  for (const f of financiersData) {
    await prisma.financier.upsert({
      where: { name: f.name },
      update: {
        tenantId: tenant.id,
      },
      create: {
        ...f,
        tenantId: tenant.id,
      },
    });
  }

  // 6. Warehouse Receipts
  const receiptsData = [
    {
      num: 'WR-2025-0001',
      comm: 'Maize',
      qty: 500,
      grade: 'Grade A',
      wh: 'Funtua Grain Storage',
      status: ReceiptStatus.ACTIVE,
    },
    {
      num: 'WR-2025-0002',
      comm: 'Maize',
      qty: 100,
      grade: 'Grade A',
      wh: 'Lagos State Warehouse',
      status: ReceiptStatus.ACTIVE,
    },
    {
      num: 'WR-2025-0003',
      comm: 'Maize',
      qty: 100,
      grade: 'Grade A',
      wh: 'Funtua Grain Storage',
      status: ReceiptStatus.ACTIVE,
    },
  ];

  if (demoUser) {
    for (const r of receiptsData) {
      const whId = getWH(r.wh);
      const commId = getComm(r.comm);

      if (whId && commId) {
        
        // Distribute over last 6 months
        const monthsAgo = Math.floor(Math.random() * 6);
        const createdAt = new Date();
        createdAt.setMonth(createdAt.getMonth() - monthsAgo);

        // Single-node tree root (ACTIVE + APPROVED so it's usable for
        // testing), with a genesis DEPOSIT event. Idempotent by number.
        const existing = await prisma.receipt.findUnique({
          where: { receiptNumber: r.num },
        });
        if (!existing) {
          const id = randomUUID();
          await prisma.receipt.create({
            data: {
              id,
              receiptNumber: r.num,
              commodityId: commId,
              warehouseId: whId,
              clientId: demoUser.id,
              quantity: r.qty,
              grade: r.grade,
              status: r.status,
              approvalStatus: 'APPROVED',
              rootReceiptId: id,
              isParent: false,
              sourceTxnType: 'DEPOSIT',
              dateOfDeposit: new Date('2025-01-01T00:00:00Z'),
              expiryDate: new Date('2026-01-01T00:00:00Z'),
              tenantId: tenant.id,
              createdAt: createdAt,
            },
          });
          const ev = await prisma.inventoryEvent.create({
            data: {
              tenantId: tenant.id,
              rootReceiptId: id,
              fromReceiptId: id,
              eventType: 'DEPOSIT',
              txnType: 'DEPOSIT',
              quantity: r.qty,
              idempotencyKey: `seed:deposit:${r.num}`,
              metadata: { seed: true },
              occurredAt: createdAt,
            },
          });
          await prisma.receipt.update({
            where: { id },
            data: { sourceEventId: ev.id },
          });
        }
      }
    }

    // Add some withdrawals for trend
    const existingReceipts = await prisma.receipt.findMany({ take: 5 });
    for (let i = 0; i < 5; i++) {
      const receipt = existingReceipts[i % existingReceipts.length];
      const monthsAgo = Math.floor(Math.random() * 6);
      const createdAt = new Date();
      createdAt.setMonth(createdAt.getMonth() - monthsAgo);

      await prisma.withdrawal.upsert({
        where: { reference: `WTH-TREND-00${i}` },
        update: {
          tenantId: tenant.id,
        },
        create: {
          reference: `WTH-TREND-00${i}`,
          receiptId: receipt.id,
          clientId: demoUser.id,
          quantity: 1,
          plannedDate: new Date(),
          status: 'COMPLETED',
          storageFee: 10,
          handlingFee: 5,
          totalFee: 15,
          tenantId: tenant.id,
          createdAt: createdAt,
        },
      });
    }
  }

  console.log('Seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
