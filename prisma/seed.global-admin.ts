/**
 * One-shot seeder for the Global Admin (platform operator) login.
 *
 * The GA is a platform-level role — it presides over tenants, financiers,
 * and platform statistics. Not tenant-scoped operationally, but our
 * User.tenantId is still non-null (broader schema refactor), so we
 * anchor to whichever tenant exists (the seeded SecureStore) as a
 * placeholder. The tenant-suspension sign-in guard exempts GA users
 * so a paused placeholder can't lock the platform operator out.
 *
 * Idempotent — running twice reuses the existing user and just prints
 * the credentials if a fresh one is minted.
 *
 * Usage:
 *   npx tsx prisma/seed.global-admin.ts
 *
 * Contact email defaults to the founder's inbox. Override via
 * GLOBAL_ADMIN_CONTACT_EMAIL env if you want the welcome mail + future
 * password-reset OTPs delivered elsewhere.
 */

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';

const prisma = new PrismaClient();

// ── Config ──────────────────────────────────────────────────────────────
const GA_FIRST_NAME = 'Platform';
const GA_LAST_NAME = 'Admin';
const GA_CONTACT_EMAIL =
  process.env.GLOBAL_ADMIN_CONTACT_EMAIL ?? 'giulio@utf.ai';

// ── Helpers (mirror the invite pattern used everywhere else) ────────────
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
  throw new Error('Cannot generate a unique login email for platform admin');
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('▸ Seeding Global Admin login\n');

  const role = await prisma.role.findUnique({
    where: { name: 'GLOBAL_ADMIN' },
  });
  if (!role) {
    throw new Error(
      'GLOBAL_ADMIN role not seeded. Run `npm run prisma:seed` first.',
    );
  }

  // Platform-tenant anchor — first tenant in the DB. GA is not
  // tenant-scoped operationally; this is just the User.tenantId FK
  // placeholder until we make that column nullable in a broader refactor.
  const platformTenant = await prisma.tenant.findFirst({
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!platformTenant) {
    throw new Error(
      'No tenant exists to anchor the GA user. Run the main seed first.',
    );
  }
  console.log('  Platform-tenant anchor:', platformTenant.name);

  // Idempotency check — is a GA user with this contact email already there?
  const existingGa = await prisma.user.findFirst({
    where: {
      contactEmail: GA_CONTACT_EMAIL,
      roles: { some: { role: { name: 'GLOBAL_ADMIN' } } },
    },
  });
  if (existingGa) {
    console.log(
      '\n▸ Global Admin already exists — no new credentials minted.',
    );
    console.log('  Name:         ', existingGa.firstName, existingGa.lastName);
    console.log('  Login email:  ', existingGa.email);
    console.log('  Contact email:', existingGa.contactEmail);
    console.log(
      '\n  If you\'ve forgotten the password, use POST /auth/forgot-password',
    );
    console.log('  with', existingGa.contactEmail, 'to receive a reset link.');
    return;
  }

  const loginEmail = await deriveLoginEmail(GA_FIRST_NAME, GA_LAST_NAME);
  const tempPassword = generateTempPassword();
  const hashedPassword = await bcrypt.hash(tempPassword, 10);

  const user = await prisma.user.create({
    data: {
      tenantId: platformTenant.id,
      email: loginEmail,
      password: hashedPassword,
      firstName: GA_FIRST_NAME,
      lastName: GA_LAST_NAME,
      contactEmail: GA_CONTACT_EMAIL,
      status: 'ACTIVE',
      roles: { create: { roleId: role.id } },
    },
  });

  console.log(
    '\n▸ Global Admin created:',
    user.firstName,
    user.lastName,
    `(${user.id})`,
  );
  console.log('\n▸ Login credentials — copy now, NOT stored anywhere else:');
  console.log('  Login email:   ', loginEmail);
  console.log('  Temp password: ', tempPassword);
  console.log('  Contact email: ', user.contactEmail);
  console.log('  Role:          ', 'GLOBAL_ADMIN');
  console.log(
    '\n  ⚠ Rotate the password via POST /me/change-password on first sign-in.',
  );
  console.log(
    '  ⚠ Contact email drives password-reset delivery — update via /me if needed.',
  );
}

main()
  .catch((e) => {
    console.error('✗ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
