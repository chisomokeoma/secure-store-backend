/**
 * One-shot seeder for the collateral-flow demo:
 *   - Creates one FinancierOrg ("Beige Bank") in the SecureStore tenant.
 *   - Seeds a first FINANCIER-role user (Ade Bello) with a real inbox
 *     that will receive welcome + OTP emails.
 *   - Seeds a current CommodityPrice per commodity so the pledge
 *     valuation lookup returns real numbers instead of null.
 *
 * Idempotent — running twice reuses existing rows (financier, user,
 * prices) and just prints the credentials again.
 *
 * Usage:
 *   npx tsx prisma/seed.financier.ts
 *
 * Contact email defaults to the founder's inbox (see below). Override
 * via FINANCIER_CONTACT_EMAIL env if needed for FE integration testing
 * from a different address.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';

const prisma = new PrismaClient();

// ── Config ──────────────────────────────────────────────────────────────
const TENANT_SLUG = 'securestore';
const FINANCIER_NAME = 'Beige Bank';
const FINANCIER_LICENSE = 'CBN-BB-2026-001';

const FIRST_USER = {
  firstName: 'Ade',
  lastName: 'Bello',
  contactEmail: process.env.FINANCIER_CONTACT_EMAIL ?? 'jajaprosper70@gmail.com',
};

// Realistic-enough NGN reference prices per unit — Nigerian market
// ballpark 2026. Adjust before running against real customer data.
const PRICES_NGN: Record<string, number> = {
  'SS-MZE': 450_000, // ₦450k / MT
  'SS-CM':      170, // ₦170 / KG (bag ~50kg ≈ ₦8,500)
  'SS-RCE':  75_000, // ₦75k / 50kg bag
  'PMO':      2_000, // ₦2,000 / L
  'CRDO':       850, // ₦850 / L
};

// ── Helpers (mirror ManagersService) ────────────────────────────────────
function generateTempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&';
  const all = upper + lower + digits + symbols;
  const pick = (chars: string) => chars[randomInt(chars.length)];
  const rest = Array.from({ length: 8 }, () => pick(all)).join('');
  return pick(upper) + pick(lower) + pick(digits) + pick(symbols) + rest;
}

async function deriveLoginEmail(firstName: string, lastName: string) {
  const base = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`.replace(
    /\s+/g,
    '',
  );
  const domain = 'securestore.com';
  const candidate = `${base}@${domain}`;
  const existing = await prisma.user.findUnique({ where: { email: candidate } });
  if (!existing) return candidate;
  for (let i = 2; i <= 99; i++) {
    const suffixed = `${base}${i}@${domain}`;
    const conflict = await prisma.user.findUnique({
      where: { email: suffixed },
    });
    if (!conflict) return suffixed;
  }
  throw new Error('Cannot generate a unique login email');
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('▸ Seeding FinancierOrg + user + commodity prices\n');

  // 1. Tenant lookup
  const tenant = await prisma.tenant.findUnique({
    where: { slug: TENANT_SLUG },
  });
  if (!tenant) {
    throw new Error(
      `Tenant "${TENANT_SLUG}" not found. Run the main seed first.`,
    );
  }
  console.log('  Tenant:', tenant.name, `(${tenant.id})`);

  // 2. FINANCIER role
  const role = await prisma.role.findUnique({ where: { name: 'FINANCIER' } });
  if (!role) {
    throw new Error(
      'FINANCIER role not seeded. Run `npm run prisma:seed` first.',
    );
  }

  // 3. FinancierOrg — platform-level entity (no tenantId since 2026-07-22).
  //    Idempotent via global name uniqueness.
  let org = await prisma.financierOrg.findFirst({
    where: { name: FINANCIER_NAME },
  });
  if (org) {
    console.log('  FinancierOrg exists:', org.name, `(${org.id})`);
  } else {
    org = await prisma.financierOrg.create({
      data: {
        name: FINANCIER_NAME,
        licenseNumber: FINANCIER_LICENSE,
        status: 'ACTIVE',
      },
    });
    console.log('  FinancierOrg created:', org.name, `(${org.id})`);
  }

  // 4. First user — idempotent by (financierOrgId, contactEmail)
  let user = await prisma.user.findFirst({
    where: {
      financierOrgId: org.id,
      contactEmail: FIRST_USER.contactEmail,
    },
  });
  let credentials: { email: string; temporaryPassword: string } | null = null;
  if (user) {
    console.log(
      '  User exists:',
      `${user.firstName} ${user.lastName}`,
      `(login: ${user.email})`,
    );
    console.log(
      '  ⚠ Existing user — temp password not printed (rotate via /me/change-password if you\'ve forgotten it).',
    );
  } else {
    const loginEmail = await deriveLoginEmail(
      FIRST_USER.firstName,
      FIRST_USER.lastName,
    );
    const tempPassword = generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: loginEmail,
        password: hashedPassword,
        firstName: FIRST_USER.firstName,
        lastName: FIRST_USER.lastName,
        contactEmail: FIRST_USER.contactEmail,
        status: 'ACTIVE',
        financierOrgId: org.id,
        roles: { create: { roleId: role.id } },
      },
    });
    credentials = { email: loginEmail, temporaryPassword: tempPassword };
    console.log(
      '  User created:',
      `${user.firstName} ${user.lastName}`,
      `(login: ${loginEmail})`,
    );
  }

  // 5. Commodity prices — one row per commodity in the tenant. Idempotent
  //    by "if the latest effective row is our seed value, skip; else insert
  //    a new row with effectiveAt=now."
  const commodities = await prisma.commodity.findMany({
    where: { tenantId: tenant.id },
    select: {
      id: true,
      name: true,
      code: true,
      unitOfMeasure: true,
    },
  });
  console.log('\n  Commodity prices:');
  let seededPrices = 0;
  let skippedPrices = 0;
  for (const c of commodities) {
    const seedValue = c.code ? PRICES_NGN[c.code] : undefined;
    if (!seedValue) {
      console.log(
        `    ⚠ ${c.name} (${c.code ?? 'no code'}) — no seed value defined; skipping`,
      );
      continue;
    }
    const latest = await prisma.commodityPrice.findFirst({
      where: { tenantId: tenant.id, commodityId: c.id },
      orderBy: { effectiveAt: 'desc' },
    });
    const latestValue = latest ? Number(latest.pricePerUnit) : null;
    if (latest && latestValue === seedValue) {
      console.log(
        `    ${c.name}: ₦${seedValue.toLocaleString()}/${c.unitOfMeasure} (unchanged)`,
      );
      skippedPrices++;
      continue;
    }
    // Global-admin lookup for setById (an admin user id is required by FK).
    // Fall back to any TENANT_ADMIN if no GA exists.
    const admin =
      (await prisma.user.findFirst({
        where: {
          tenantId: tenant.id,
          roles: {
            some: {
              role: { name: { in: ['GLOBAL_ADMIN', 'TENANT_ADMIN'] } },
            },
          },
        },
        select: { id: true },
      })) ?? null;
    if (!admin) {
      throw new Error(
        'No GLOBAL_ADMIN or TENANT_ADMIN user found to attribute the price row to.',
      );
    }
    await prisma.commodityPrice.create({
      data: {
        tenantId: tenant.id,
        commodityId: c.id,
        unit: c.unitOfMeasure,
        pricePerUnit: new Prisma.Decimal(seedValue),
        currency: 'NGN',
        setById: admin.id,
        effectiveAt: new Date(),
        source: 'SEED',
      },
    });
    console.log(
      `    ${c.name}: ₦${seedValue.toLocaleString()}/${c.unitOfMeasure} ✓ new`,
    );
    seededPrices++;
  }

  console.log('\n▸ Summary');
  console.log(`  FinancierOrg: ${org.name} (${org.id})`);
  console.log(`  First user:   ${user.firstName} ${user.lastName}`);
  console.log(`  Contact:      ${FIRST_USER.contactEmail}`);
  console.log(
    `  Prices:       ${seededPrices} seeded, ${skippedPrices} unchanged`,
  );
  if (credentials) {
    console.log('\n▸ Login credentials for the new user (copy now — NOT stored anywhere else):');
    console.log(`  Login email: ${credentials.email}`);
    console.log(`  Temp password: ${credentials.temporaryPassword}`);
    console.log(
      '\n  ⚠ Rotate this password via POST /me/change-password before Lagos demo.',
    );
  }
}

main()
  .catch((e) => {
    console.error('✗ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
