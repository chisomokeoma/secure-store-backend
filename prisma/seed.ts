import {
  PrismaClient,
  MeasurementUnit,
  ReceiptStatus,
  Warehouse,
  Commodity,
} from '@prisma/client';

// import { PrismaClient, MeasurementUnit, ReceiptStatus } from '@prisma/client';

import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import 'dotenv/config';
import * as bcrypt from 'bcrypt';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL as string,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Starting seed...');

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
      roleName: 'GLOBAL_ADMIN',
    },
    {
      email: 'tenant@securestore.com',
      firstName: 'Tenant',
      lastName: 'Admin',
      password: passwordHash,
      roleName: 'TENANT_ADMIN',
    },
    {
      email: 'manager@securestore.com',
      firstName: 'Funtua',
      lastName: 'Manager',
      password: passwordHash,
      roleName: 'WAREHOUSE_MANAGER',
    },
    {
      email: 'manager2@securestore.com',
      firstName: 'Lagos',
      lastName: 'Manager',
      password: passwordHash,
      roleName: 'WAREHOUSE_MANAGER',
    },
    {
      email: 'firstbank@securestore.com',
      firstName: 'First',
      lastName: 'Bank',
      password: passwordHash,
      roleName: 'FINANCIER',
    },
    {
      email: 'demo@securestore.com',
      firstName: 'John',
      lastName: 'Doe',
      password: passwordHash,
      roleName: 'CLIENT',
    },
  ];

  for (const u of users) {
    const role = await prisma.role.findUnique({ where: { name: u.roleName } });
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        password: u.password,
        roles: role ? { connect: { id: role.id } } : undefined,
      },
    });
  }

  const demoUser = await prisma.user.findUnique({
    where: { email: 'demo@securestore.com' },
  });

  // 3. Warehouses
  const warehousesData = [
    { name: 'Funtua Grain Storage', location: 'Funtua, Katsina' },
    { name: 'Lagos State Warehouse', location: 'Lagos' },
    { name: 'Kano Dry Goods Warehouse', location: 'Kano' },
  ];

  const warehouses: Warehouse[] = [];
  for (const w of warehousesData) {
    let wh = await prisma.warehouse.findFirst({ where: { name: w.name } });
    if (!wh) {
      wh = await prisma.warehouse.create({ data: w });
    }
    warehouses.push(wh);
  }

  // 4. Commodities
  const commoditiesData = [
    {
      name: 'Maize',
      unitOfMeasure: MeasurementUnit.METRIC_TON,
      description: 'Grade A, B, C',
    },
    {
      name: 'Rice',
      unitOfMeasure: MeasurementUnit.KILOGRAM,
      description: 'Grade A, B',
    },
    {
      name: 'Cement',
      unitOfMeasure: MeasurementUnit.KILOGRAM,
      description: 'Grade A',
    },
    {
      name: 'Ironrods',
      unitOfMeasure: MeasurementUnit.KILOGRAM,
      description: 'Grade A, B',
    },
    {
      name: 'Tanks',
      unitOfMeasure: MeasurementUnit.LITRE,
      description: 'Standard',
    },
    {
      name: 'Doors',
      unitOfMeasure: MeasurementUnit.KILOGRAM,
      description: 'Grade A',
    },
    {
      name: 'Wheat',
      unitOfMeasure: MeasurementUnit.METRIC_TON,
      description: 'Grade A, B',
    },
    {
      name: 'Palm Oil',
      unitOfMeasure: MeasurementUnit.LITRE,
      description: 'Grade A',
    },
  ];

  const commodities: Commodity[] = [];
  for (const c of commoditiesData) {
    let comm = await prisma.commodity.findUnique({ where: { name: c.name } });
    if (!comm) {
      comm = await prisma.commodity.create({ data: c });
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
        update: {},
        create: {
          warehouseId: w.id,
          commodityId: c.id,
          storageFeePerUnit: Math.floor(Math.random() * 20) + 10,
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
      update: {},
      create: f,
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
    {
      num: 'WR-2025-0004',
      comm: 'Maize',
      qty: 100,
      grade: 'Grade B',
      wh: 'Funtua Grain Storage',
      status: ReceiptStatus.PLEDGED,
    },
    {
      num: 'WR-2025-0005',
      comm: 'Maize',
      qty: 100,
      grade: 'Grade A',
      wh: 'Funtua Grain Storage',
      status: ReceiptStatus.LIEN,
    },
    {
      num: 'WR-2025-0006',
      comm: 'Cement',
      qty: 1000,
      grade: 'Grade A',
      wh: 'Lagos State Warehouse',
      status: ReceiptStatus.ACTIVE,
    },
    {
      num: 'WR-2025-0007',
      comm: 'Cement',
      qty: 1000,
      grade: 'Grade A',
      wh: 'Lagos State Warehouse',
      status: ReceiptStatus.ACTIVE,
    },
    {
      num: 'WR-2025-0008',
      comm: 'Cement',
      qty: 1000,
      grade: 'Grade A',
      wh: 'Kano Dry Goods Warehouse',
      status: ReceiptStatus.PLEDGED,
    },
    {
      num: 'WR-2025-0009',
      comm: 'Rice',
      qty: 500,
      grade: 'Grade A',
      wh: 'Lagos State Warehouse',
      status: ReceiptStatus.ACTIVE,
    },
    {
      num: 'WR-2025-0010',
      comm: 'Wheat',
      qty: 100,
      grade: 'Grade A',
      wh: 'Funtua Grain Storage',
      status: ReceiptStatus.ACTIVE,
    },
    {
      num: 'WR-2025-0011',
      comm: 'Ironrods',
      qty: 200,
      grade: 'Grade A',
      wh: 'Kano Dry Goods Warehouse',
      status: ReceiptStatus.ACTIVE,
    },
    {
      num: 'WR-2025-0012',
      comm: 'Tanks',
      qty: 500,
      grade: 'Standard',
      wh: 'Lagos State Warehouse',
      status: ReceiptStatus.CANCELLED,
    }, // TRADED doesn't exist in enum
    {
      num: 'WR-2025-0013',
      comm: 'Doors',
      qty: 200,
      grade: 'Grade A',
      wh: 'Lagos State Warehouse',
      status: ReceiptStatus.ACTIVE,
    },
    {
      num: 'WR-2025-0014',
      comm: 'Palm Oil',
      qty: 12500,
      grade: 'Grade A',
      wh: 'Lagos State Warehouse',
      status: ReceiptStatus.ACTIVE,
    },
  ];

  if (demoUser) {
    for (const r of receiptsData) {
      const whId = getWH(r.wh);
      const commId = getComm(r.comm);

      if (whId && commId) {
        const isLocked = (
          [ReceiptStatus.PLEDGED, ReceiptStatus.LIEN] as ReceiptStatus[]
        ).includes(r.status);
        await prisma.receipt.upsert({
          where: { receiptNumber: r.num },
          update: {},
          create: {
            receiptNumber: r.num,
            commodityId: commId,
            warehouseId: whId,
            clientId: demoUser.id,
            quantity: r.qty,
            quantityAvailable: isLocked ? 0 : r.qty,
            grade: r.grade,
            status: r.status,
            dateOfDeposit: new Date('2025-01-01T00:00:00Z'),
            expiryDate: new Date('2026-01-01T00:00:00Z'),
          },
        });
      }
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

// import { PrismaPg } from '@prisma/adapter-pg';
// import { Pool } from 'pg';
// import 'dotenv/config';
// import * as bcrypt from 'bcrypt';
// import { MeasurementUnit, PrismaClient, ReceiptStatus } from '@prisma/client';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL as string,
// });

// const adapter = new PrismaPg(pool);
// const prisma = new PrismaClient({ adapter });

// async function main() {
//   console.log('Starting seed...');

//   // 1. Users
//   const passwordHash = await bcrypt.hash('Demo@123', 10);
//   const users = [
//     { email: 'admin@securestore.com', firstName: 'Admin', lastName: 'User', password: passwordHash, role: 'GLOBAL_ADMIN' },
//     { email: 'tenant@securestore.com', firstName: 'Tenant', lastName: 'Admin', password: passwordHash, role: 'TENANT_ADMIN' },
//     { email: 'manager@securestore.com', firstName: 'Funtua', lastName: 'Manager', password: passwordHash, role: 'WAREHOUSE_MANAGER' },
//     { email: 'manager2@securestore.com', firstName: 'Lagos', lastName: 'Manager', password: passwordHash, role: 'WAREHOUSE_MANAGER' },
//     { email: 'firstbank@securestore.com', firstName: 'First', lastName: 'Bank', password: passwordHash, role: 'FINANCIER' },
//     { email: 'demo@securestore.com', firstName: 'John', lastName: 'Doe', password: passwordHash, role: 'CLIENT' },
//   ];

//   for (const u of users) {
//     await prisma.user.upsert({
//       where: { email: u.email },
//       update: {},
//       create: {
//         email: u.email,
//         firstName: u.firstName,
//         lastName: u.lastName,
//         password: u.password,
//         role: u.role as any,
//       },
//     });
//   }

//   const demoUser = await prisma.user.findUnique({ where: { email: 'demo@securestore.com' } });

//   // 2. Warehouses
//   const warehousesData = [
//     { name: 'Funtua Grain Storage', location: 'Funtua, Katsina' },
//     { name: 'Lagos State Warehouse', location: 'Lagos' },
//     { name: 'Kano Dry Goods Warehouse', location: 'Kano' },
//   ];

//   const warehouses: any[] = [];
//   for (const w of warehousesData) {
//     let wh = await prisma.warehouse.findFirst({ where: { name: w.name } });
//     if (!wh) wh = await prisma.warehouse.create({ data: w });
//     warehouses.push(wh);
//   }

//   // 3. Commodities
//   const commoditiesData = [
//     { name: 'Maize', unitOfMeasure: MeasurementUnit.METRIC_TON, description: 'Grade A, B, C' },
//     { name: 'Rice', unitOfMeasure: MeasurementUnit.KILOGRAM, description: 'Grade A, B' },
//     { name: 'Cement', unitOfMeasure: MeasurementUnit.KILOGRAM, description: 'Grade A' },
//     { name: 'Ironrods', unitOfMeasure: MeasurementUnit.KILOGRAM, description: 'Grade A, B' },
//     { name: 'Tanks', unitOfMeasure: MeasurementUnit.UNIT, description: 'Standard' }, // 👈 changed LITRE to UNIT
//     { name: 'Doors', unitOfMeasure: MeasurementUnit.UNIT, description: 'Grade A' }, // 👈 changed to UNIT
//     { name: 'Wheat', unitOfMeasure: MeasurementUnit.METRIC_TON, description: 'Grade A, B' },
//     { name: 'Palm Oil', unitOfMeasure: MeasurementUnit.UNIT, description: 'Grade A' }, // 👈 changed to UNIT
//   ];

//   const commodities: any[] = [];
//   for (const c of commoditiesData) {
//     let comm = await prisma.commodity.findUnique({ where: { name: c.name } });
//     if (!comm) comm = await prisma.commodity.create({ data: c });
//     commodities.push(comm);
//   }

//   const getWH = (name: string) => warehouses.find(w => w.name === name)?.id;
//   const getComm = (name: string) => commodities.find(c => c.name === name)?.id;

//   // 4. Financiers
//   const financiersData = [
//     { name: 'First Bank Plc', interestRate: 8.5, minTenure: 3, maxTenure: 12, approvalTime: '24 hr' },
//     { name: 'Zenith Bank', interestRate: 9.0, minTenure: 3, maxTenure: 12, approvalTime: '24 hr' },
//     { name: 'Access Bank', interestRate: 8.75, minTenure: 3, maxTenure: 12, approvalTime: '24 hr' },
//     { name: 'GTBank', interestRate: 8.0, minTenure: 3, maxTenure: 12, approvalTime: '48 hr' },
//     { name: 'UBA', interestRate: 9.25, minTenure: 3, maxTenure: 12, approvalTime: '24 hr' },
//   ];

//   for (const f of financiersData) {
//     await prisma.financier.upsert({
//       where: { name: f.name },
//       update: {},
//       create: f,
//     });
//   }

//   // 5. Receipts
//   const receiptsData = [
//     { num: 'WR-2025-0001', comm: 'Maize', qty: 500, grade: 'Grade A', wh: 'Funtua Grain Storage', status: ReceiptStatus.ACTIVE },
//     { num: 'WR-2025-0002', comm: 'Maize', qty: 100, grade: 'Grade A', wh: 'Lagos State Warehouse', status: ReceiptStatus.ACTIVE },
//     { num: 'WR-2025-0003', comm: 'Maize', qty: 100, grade: 'Grade A', wh: 'Funtua Grain Storage', status: ReceiptStatus.ACTIVE },
//     { num: 'WR-2025-0004', comm: 'Maize', qty: 100, grade: 'Grade B', wh: 'Funtua Grain Storage', status: ReceiptStatus.PLEDGED },
//     { num: 'WR-2025-0005', comm: 'Maize', qty: 100, grade: 'Grade A', wh: 'Funtua Grain Storage', status: ReceiptStatus.LIEN },
//     { num: 'WR-2025-0006', comm: 'Cement', qty: 1000, grade: 'Grade A', wh: 'Lagos State Warehouse', status: ReceiptStatus.ACTIVE },
//     { num: 'WR-2025-0007', comm: 'Cement', qty: 1000, grade: 'Grade A', wh: 'Lagos State Warehouse', status: ReceiptStatus.ACTIVE },
//     { num: 'WR-2025-0008', comm: 'Cement', qty: 1000, grade: 'Grade A', wh: 'Kano Dry Goods Warehouse', status: ReceiptStatus.PLEDGED },
//     { num: 'WR-2025-0009', comm: 'Rice', qty: 500, grade: 'Grade A', wh: 'Lagos State Warehouse', status: ReceiptStatus.ACTIVE },
//     { num: 'WR-2025-0010', comm: 'Wheat', qty: 100, grade: 'Grade A', wh: 'Funtua Grain Storage', status: ReceiptStatus.ACTIVE },
//     { num: 'WR-2025-0011', comm: 'Ironrods', qty: 200, grade: 'Grade A', wh: 'Kano Dry Goods Warehouse', status: ReceiptStatus.ACTIVE },
//     { num: 'WR-2025-0012', comm: 'Tanks', qty: 500, grade: 'Standard', wh: 'Lagos State Warehouse', status: ReceiptStatus.CANCELLED },
//     { num: 'WR-2025-0013', comm: 'Doors', qty: 200, grade: 'Grade A', wh: 'Lagos State Warehouse', status: ReceiptStatus.ACTIVE },
//     { num: 'WR-2025-0014', comm: 'Palm Oil', qty: 12500, grade: 'Grade A', wh: 'Lagos State Warehouse', status: ReceiptStatus.ACTIVE },
//   ];

//   if (demoUser) {
//     for (const r of receiptsData) {
//       const whId = getWH(r.wh);
//       const commId = getComm(r.comm);

//       if (whId && commId) {
//         await prisma.receipt.upsert({
//           where: { receiptNumber: r.num },
//           update: {},
//           create: {
//             receiptNumber: r.num,
//             commodityId: commId,
//             warehouseId: whId,
//             clientId: demoUser.id,
//             quantity: r.qty,
//             grade: r.grade,
//             status: r.status,
//             dateOfDeposit: new Date('2025-01-01T00:00:00Z'),
//             expiryDate: new Date('2026-01-01T00:00:00Z'),
//           }
//         });
//       }
//     }
//   }

//   console.log('Seeding completed successfully.');
// }

// main()
//   .catch((e) => {
//     console.error(e);
//     process.exit(1);
//   })
//   .finally(async () => {
//     await prisma.$disconnect();
//   });
