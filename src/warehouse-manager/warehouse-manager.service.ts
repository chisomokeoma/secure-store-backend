import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { randomUUID, randomInt } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { InventoryQueryService } from '../inventory/inventory-query.service';
import {
  ReceiptGroup,
  statusesForGroup,
  deriveGroup,
  HELD_STATUSES,
} from '../inventory/inventory.types';
import { Prisma, ReceiptStatus, TxnType, WithdrawalStatus } from '@prisma/client';

// Concrete type for a receipt loaded by `loadDepositForEdit` — includes the
// commodity and its grading parameters so `applyDepositEdit` can re-score
// measurements without an extra round-trip. Pulled out as a Prisma payload
// type so it doesn't depend on `this`, which TS doesn't allow inside method
// parameter type annotations.
export type EditableDepositReceipt = Prisma.ReceiptGetPayload<{
  include: { commodity: { include: { gradingParameters: true } } };
}>;
import { scoreSample } from '../grading/grading.scorer';
import { WarehouseScopeService } from './warehouse-scope.service';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { LoansService } from '../loans/loans.service';
import { TradesService } from '../trades/trades.service';
import { StorageFeesService } from '../storage-fees/storage-fees.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SecurityService } from '../security/security.service';
import { EmailService } from '../email/email.service';
import { StorageService } from '../storage/storage.service';
import { TransactionOtpPurpose } from '@prisma/client';
import { CreateWithdrawalDto } from '../withdrawals/dto/withdrawals.dto';
import { CreateLoanDto } from '../loans/dto/loans.dto';
import {
  CreateClientDto,
  UpdateClientDto,
  CreateDepositDto,
  EditDepositDto,
  PreviewGradingDto,
  GetMovementDto,
  MovementGranularity,
} from './dto/wm.dto';

const ADMIN_ROLES = ['TENANT_ADMIN', 'GLOBAL_ADMIN'];

@Injectable()
export class WarehouseManagerService {
  constructor(
    private prisma: PrismaService,
    private ledger: InventoryLedgerService,
    private query: InventoryQueryService,
    private whScope: WarehouseScopeService,
    private withdrawals: WithdrawalsService,
    private loans: LoansService,
    private trades: TradesService,
    private storageFees: StorageFeesService,
    private notifications: NotificationsService,
    private security: SecurityService,
    private email: EmailService,
    private storage: StorageService,
  ) {}

  // ── helpers ───────────────────────────────────────────────────────────────

  private async deriveLoginEmail(first: string, last: string) {
    const base = `${first}.${last}`.toLowerCase().replace(/\s+/g, '');
    const domain = 'securestore.com';
    for (const cand of [
      `${base}@${domain}`,
      ...Array.from({ length: 98 }, (_, i) => `${base}${i + 2}@${domain}`),
    ]) {
      if (!(await this.prisma.user.findUnique({ where: { email: cand } })))
        return cand;
    }
    throw new ConflictException('Cannot generate a unique login email');
  }

  private generateTempPassword() {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghjkmnpqrstuvwxyz', '23456789', '!@#$%&'];
    const all = sets.join('');
    const pick = (s: string) => s[randomInt(s.length)];
    return (
      sets.map(pick).join('') +
      Array.from({ length: 8 }, () => pick(all)).join('')
    );
  }

  private async generateClientCode(tenantId: string) {
    const year = new Date().getFullYear();
    const n = await this.prisma.clientProfile.count({ where: { tenantId } });
    return `CLT-${year}-${String(n + 1).padStart(4, '0')}`;
  }

  private async assertWarehouseScope(
    tenantId: string,
    managerUserId: string,
    warehouseId: string,
    actorRoles: string[],
  ) {
    if (actorRoles.some((r) => ADMIN_ROLES.includes(r))) return;
    const assignment = await this.prisma.warehouseManagerAssignment.findFirst({
      where: { tenantId, managerId: managerUserId, warehouseId, unassignedAt: null },
    });
    if (!assignment) {
      throw new ForbiddenException(
        'You are not assigned to this warehouse',
      );
    }
  }

  // ── warehouses ────────────────────────────────────────────────────────────

  async getMyWarehouses(tenantId: string, managerUserId: string) {
    const rows = await this.prisma.warehouseManagerAssignment.findMany({
      where: { tenantId, managerId: managerUserId, unassignedAt: null },
      include: {
        warehouse: {
          include: {
            warehouseCommodities: {
              include: { commodity: { select: { id: true, name: true, unitOfMeasure: true } } },
            },
          },
        },
      },
    });
    return rows.map((a) => ({
      id: a.warehouse.id,
      name: a.warehouse.name,
      code: a.warehouse.code,
      location: a.warehouse.location,
      commodities: a.warehouse.warehouseCommodities.map((wc) => wc.commodity),
    }));
  }

  // ── clients ───────────────────────────────────────────────────────────────

  async createClient(
    tenantId: string,
    managerUserId: string,
    dto: CreateClientDto,
  ) {
    const role = await this.prisma.role.findUnique({
      where: { name: 'CLIENT' },
    });
    if (!role) {
      throw new BadRequestException('CLIENT role not configured. Run seed.');
    }

    const mode = dto.mode ?? 'INDIVIDUAL';

    // ── Org-mode functional requirements ────────────────────────────────────
    // The DTO marks everything optional so a partial draft validates, but
    // ORGANIZATION creates can't proceed without the core corporate fields.
    if (mode === 'ORGANIZATION') {
      if (!dto.rcNumber?.trim()) {
        throw new BadRequestException(
          'rcNumber is required for ORGANIZATION clients.',
        );
      }
      if (!dto.companyName?.trim()) {
        throw new BadRequestException(
          'companyName is required for ORGANIZATION clients.',
        );
      }
      if (
        dto.companyCategory === 'OTHER' &&
        !dto.companyCategoryOther?.trim()
      ) {
        throw new BadRequestException(
          'companyCategoryOther is required when companyCategory = OTHER.',
        );
      }
    }

    // Login email is ALWAYS @securestore.com (system-issued identity); any
    // email the form provided is kept only as the contact email. For
    // ORGANIZATION clients the rep's first/last name drives the login —
    // matches the INDIVIDUAL pattern so downstream code doesn't branch.
    const email = await this.deriveLoginEmail(dto.firstName, dto.lastName);
    const tempPassword = this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const clientCode = await this.generateClientCode(tenantId);

    // Dedup the focus ids on the way in (DTO already enforces uniqueness,
    // but we belt-and-braces); validate they belong to this tenant before
    // we open the write transaction.
    const focusIds = Array.from(new Set(dto.focusCommodityIds ?? []));
    if (focusIds.length) {
      const found = await this.prisma.commodity.count({
        where: { tenantId, id: { in: focusIds } },
      });
      if (found !== focusIds.length) {
        throw new BadRequestException(
          'One or more focusCommodityIds are invalid for this tenant',
        );
      }
    }

    // Directors / documents passed in this call (ORGANIZATION only — they're
    // silently ignored for INDIVIDUAL clients to keep the contract relaxed).
    const directors = mode === 'ORGANIZATION' ? dto.directors ?? [] : [];
    const documents = mode === 'ORGANIZATION' ? dto.documents ?? [] : [];

    // Validate any document with scope=DIRECTOR carries a directorRef that
    // matches one of the supplied directors — caught here so we don't open
    // the transaction just to fail late.
    const directorRefs = new Set(
      directors.map((d) => d.ref).filter((r): r is string => !!r),
    );
    for (const doc of documents) {
      if (doc.scope === 'DIRECTOR') {
        if (!doc.directorRef) {
          throw new BadRequestException(
            'documents with scope=DIRECTOR must include directorRef.',
          );
        }
        if (!directorRefs.has(doc.directorRef)) {
          throw new BadRequestException(
            `documents[].directorRef='${doc.directorRef}' does not match any director.ref in this payload.`,
          );
        }
      }
    }

    // ── File-URL validation ──────────────────────────────────────────────
    // Every URL the FE sends here must be one our storage layer issued via
    // POST /storage/upload. Any other URL — pre-existing, externally hosted,
    // typo'd, mocked — is rejected. This turns "ClientDocument.url accepts
    // anything" into "must be a URL we recognise and whose file exists."
    // Cheap (single round-trip per URL); bails before any DB write so a
    // bad payload never produces a half-committed client row.
    await this.storage.assertOwnedUrls([
      dto.profilePhotoUrl,
      dto.idDocumentUrl,
      ...documents.map((d) => d.url),
    ]);

    const profile = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          contactEmail: dto.email ?? null,
          password: passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          tenantId,
          phoneNumber: dto.phoneNumber,
          gender: dto.gender,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
          residentialAddress: dto.residentialAddress,
          profilePhotoUrl: dto.profilePhotoUrl,
          roles: { create: { roleId: role.id } },
        },
      });
      const newProfile = await tx.clientProfile.create({
        data: {
          userId: user.id,
          tenantId,
          clientCode,
          mode,
          type: dto.type ?? (mode === 'ORGANIZATION' ? 'COMPANY' : 'FARMER'),
          occupation: dto.occupation,
          description: dto.description,
          nationality: dto.nationality,
          stateOfOrigin: dto.stateOfOrigin,
          lga: dto.lga,
          nationalId: dto.nationalId,
          profilePhotoUrl: dto.profilePhotoUrl,
          idDocumentUrl: dto.idDocumentUrl,
          bankAccountName: dto.bankAccountName,
          bankAccountNumber: dto.bankAccountNumber,
          bankName: dto.bankName,
          nokFullName: dto.nokFullName,
          nokAddress: dto.nokAddress,
          nokPhone: dto.nokPhone,
          nokEmail: dto.nokEmail,
          nokRelationship: dto.nokRelationship,
          registeredByManagerId: managerUserId,

          // Organisation block (nullable when INDIVIDUAL).
          rcNumber: dto.rcNumber,
          companyName: dto.companyName,
          companyCategory: dto.companyCategory,
          companyCategoryOther: dto.companyCategoryOther,
          dateOfIncorporation: dto.dateOfIncorporation
            ? new Date(dto.dateOfIncorporation)
            : null,
          natureOfBusiness: dto.natureOfBusiness,
          sectorIndustry: dto.sectorIndustry,
          businessAddress: dto.businessAddress,
          tin: dto.tin,

          // Authorised-rep / extended KYC.
          representativeDesignation: dto.representativeDesignation,
          otherNames: dto.otherNames,
          mothersMaidenName: dto.mothersMaidenName,
          maritalStatus: dto.maritalStatus,
          idType: dto.idType,
          idNumber: dto.idNumber,
          idIssueDate: dto.idIssueDate ? new Date(dto.idIssueDate) : null,
          idExpiryDate: dto.idExpiryDate ? new Date(dto.idExpiryDate) : null,

          focusCommodities: focusIds.length
            ? {
                create: focusIds.map((commodityId) => ({
                  tenantId,
                  commodityId,
                })),
              }
            : undefined,
        },
        include: {
          user: { select: { id: true, email: true } },
          focusCommodities: {
            include: { commodity: { select: { id: true, name: true } } },
          },
        },
      });

      // Insert directors and map FE refs → created ids. The map is consumed
      // by the document loop below to resolve DIRECTOR-scoped scopeRefIds.
      const refToId = new Map<string, string>();
      for (const d of directors) {
        const created = await tx.clientDirector.create({
          data: {
            tenantId,
            clientProfileId: newProfile.id,
            firstName: d.firstName,
            lastName: d.lastName,
            otherNames: d.otherNames,
            designation: d.designation,
            residentialAddress: d.residentialAddress,
            phoneNumber: d.phoneNumber,
            email: d.email,
            mothersMaidenName: d.mothersMaidenName,
            gender: d.gender,
            dateOfBirth: d.dateOfBirth ? new Date(d.dateOfBirth) : null,
            nationality: d.nationality,
            stateOfOrigin: d.stateOfOrigin,
            maritalStatus: d.maritalStatus,
            bvn: d.bvn,
            nin: d.nin,
            idType: d.idType,
            idNumber: d.idNumber,
            idIssueDate: d.idIssueDate ? new Date(d.idIssueDate) : null,
            idExpiryDate: d.idExpiryDate ? new Date(d.idExpiryDate) : null,
          },
        });
        if (d.ref) refToId.set(d.ref, created.id);
      }

      // Insert documents. DIRECTOR-scoped docs resolve their `scopeRefId`
      // from the ref→id map; COMPANY/REPRESENTATIVE docs leave it null.
      if (documents.length) {
        await tx.clientDocument.createMany({
          data: documents.map((doc) => ({
            tenantId,
            clientProfileId: newProfile.id,
            type: doc.type,
            scope: doc.scope,
            scopeRefId:
              doc.scope === 'DIRECTOR' && doc.directorRef
                ? refToId.get(doc.directorRef)!
                : null,
            url: doc.url,
            fileName: doc.fileName,
            fileSize: doc.fileSize,
            mimeType: doc.mimeType,
          })),
        });
      }

      return newProfile;
    });

    // ── Welcome email + notifications (best-effort; never blocks the response)
    // The welcome email carries the login alias + temp password to the
    // client's REAL inbox — so the credentials reach them directly without
    // the WM having to relay them over insecure channels (WhatsApp, voice,
    // sticky note). This also establishes that SecureStore mail will come
    // from this sender, which matters when we then ask them to verify a
    // password change via OTP delivered to the same inbox.
    const clientName = `${dto.firstName} ${dto.lastName}`;
    if (dto.email) {
      const signInUrl =
        (process.env.FRONTEND_URL ?? 'http://localhost:3001').replace(
          /\/+$/,
          '',
        ) + '/login';
      void this.email.sendWelcomeEmail({
        to: dto.email,
        firstName: dto.firstName,
        loginEmail: email,
        tempPassword,
        clientCode: profile.clientCode,
        signInUrl,
      });
    }
    void this.notifications.notifyUser(profile.userId, {
      tenantId,
      type: 'CLIENT_CREDENTIALS_ISSUED',
      title: 'Welcome — your SecureStore account is live',
      body: `Your warehouse ID ${profile.clientCode} has been issued. Sign in with ${email}.`,
      relatedEntityType: 'client',
      relatedEntityId: profile.userId,
    });
    void this.notifications.notifyTenantAdmins(tenantId, {
      type: 'CLIENT_REGISTERED',
      title: 'New client registered',
      body: `${clientName} (${profile.clientCode}) was registered by their warehouse manager.`,
      relatedEntityType: 'client',
      relatedEntityId: profile.userId,
    });

    return {
      clientId: profile.userId,
      clientCode: profile.clientCode,
      mode: profile.mode,
      // For ORGANIZATION clients `name` is the company name (what the FE
      // surfaces in lists); the rep's name lives in `representative`.
      name:
        profile.mode === 'ORGANIZATION'
          ? (profile.companyName ?? clientName)
          : clientName,
      type: profile.type,
      ...(profile.mode === 'ORGANIZATION'
        ? {
            companyName: profile.companyName,
            rcNumber: profile.rcNumber,
            representative: { name: clientName },
            directorsCount: directors.length,
            documentsCount: documents.length,
          }
        : {}),
      focusCommodities: profile.focusCommodities.map((f) => f.commodity),
      credentials: { email, tempPassword }, // shown ONCE
    };
  }

  /**
   * Scope filter for clients visible to a warehouse manager:
   *   (a) clients I registered (so a freshly-created client appears immediately,
   *       before they have any receipts), OR
   *   (b) clients with at least one receipt in my scoped warehouses, OR
   *   (c) clients registered by a manager currently assigned to one of my
   *       scoped warehouses (shared warehouse roster).
   * When `scope` is null (privileged role / no narrowing) we return null and
   * the caller skips the filter entirely.
   */
  private async clientScopeWhere(
    tenantId: string,
    managerUserId: string,
  ): Promise<any | null> {
    const scope = await this.whScope.warehouseIds(tenantId);
    if (!scope) return null;
    return {
      OR: [
        { registeredByManagerId: managerUserId },
        { user: { receipts: { some: { warehouseId: { in: scope } } } } },
        {
          registeredByManager: {
            managerAssignments: {
              some: { warehouseId: { in: scope }, unassignedAt: null },
            },
          },
        },
      ],
    };
  }

  async listClients(
    tenantId: string,
    managerUserId: string,
    query: { search?: string; type?: string; page?: string; limit?: string },
  ) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    const AND: any[] = [];
    const scopeWhere = await this.clientScopeWhere(tenantId, managerUserId);
    if (scopeWhere) AND.push(scopeWhere);
    if (query.search) {
      AND.push({
        OR: [
          { clientCode: { contains: query.search, mode: 'insensitive' } },
          { user: { firstName: { contains: query.search, mode: 'insensitive' } } },
          { user: { lastName: { contains: query.search, mode: 'insensitive' } } },
          { user: { email: { contains: query.search, mode: 'insensitive' } } },
        ],
      });
    }
    const where: any = { tenantId, ...(AND.length ? { AND } : {}) };
    if (query.type) where.type = query.type;

    const [rows, total] = await Promise.all([
      this.prisma.clientProfile.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              status: true,
              _count: { select: { receipts: true } },
            },
          },
        },
      }),
      this.prisma.clientProfile.count({ where }),
    ]);

    // Two enrichments per row, both warehouse-scoped:
    //  • lastDeposit  — most recent root-deposit date for this client
    //  • outstandingFee — projected storage fee on currently-in-warehouse
    //    inventory (ACTIVE + HELD_*), summed across the client's receipts.
    //    `null` when no policy resolves for any of the client's holdings.
    const userIds = rows.map((c) => c.userId);
    const scope = await this.whScope.warehouseIds(tenantId);
    const whR = scope ? { warehouseId: { in: scope } } : {};
    const { lastDepositByClient, outstandingByClient } = userIds.length
      ? await this.enrichClientRowMetrics(tenantId, userIds, whR)
      : { lastDepositByClient: new Map(), outstandingByClient: new Map() };

    return {
      data: rows.map((c) => ({
        clientId: c.userId,
        clientCode: c.clientCode,
        name: `${c.user.firstName} ${c.user.lastName}`,
        email: c.user.email,
        type: c.type,
        status: c.user.status,
        totalReceipts: c.user._count.receipts,
        lastDeposit: lastDepositByClient.get(c.userId) ?? null,
        outstandingFee: outstandingByClient.get(c.userId) ?? null,
        currency: 'NGN',
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Batch-compute lastDeposit + outstandingFee for a page of clients. One
   * query for deposit dates, one for the in-warehouse receipts, and one
   * `resolvePolicy` per unique (warehouseId, commodityId) — not per receipt.
   */
  private async enrichClientRowMetrics(
    tenantId: string,
    clientIds: string[],
    whR: { warehouseId?: { in: string[] } },
  ): Promise<{
    lastDepositByClient: Map<string, Date>;
    outstandingByClient: Map<string, number>;
  }> {
    const inWarehouse: ReceiptStatus[] = [
      ReceiptStatus.ACTIVE,
      ...HELD_STATUSES,
    ];

    const [latestDeposits, openReceipts] = await Promise.all([
      this.prisma.receipt.groupBy({
        by: ['clientId'],
        where: {
          tenantId,
          clientId: { in: clientIds },
          parentReceiptId: null,
          ...whR,
        },
        _max: { dateOfDeposit: true },
      }),
      this.prisma.receipt.findMany({
        where: {
          tenantId,
          clientId: { in: clientIds },
          status: { in: inWarehouse },
          ...whR,
        },
        select: {
          clientId: true,
          warehouseId: true,
          commodityId: true,
          quantity: true,
          dateOfDeposit: true,
          commodity: {
            select: { unitOfMeasure: true, standardBagWeightKg: true },
          },
        },
      }),
    ]);

    const lastDepositByClient = new Map<string, Date>();
    for (const r of latestDeposits) {
      if (r._max.dateOfDeposit)
        lastDepositByClient.set(r.clientId, r._max.dateOfDeposit);
    }

    // Memoize policy lookups: many receipts share the same (warehouse, commodity).
    // A throw from resolvePolicy means "no policy configured" — that client's
    // outstanding fee stays null, so the UI renders a dash instead of a zero.
    type PolicyOrMiss =
      | { ok: true; policy: { feeType: any; rate: number } }
      | { ok: false };
    const policyCache = new Map<string, Promise<PolicyOrMiss>>();
    const policyKey = (w: string, c: string) => `${w}::${c}`;
    const getPolicy = (warehouseId: string, commodityId: string) => {
      const key = policyKey(warehouseId, commodityId);
      if (!policyCache.has(key)) {
        policyCache.set(
          key,
          this.storageFees
            .resolvePolicy(tenantId, warehouseId, commodityId)
            .then(
              (p): PolicyOrMiss => ({
                ok: true,
                policy: { feeType: p.feeType, rate: p.rate },
              }),
            )
            .catch((): PolicyOrMiss => ({ ok: false })),
        );
      }
      return policyCache.get(key)!;
    };

    const now = new Date();
    const outstandingByClient = new Map<string, number>();
    const clientsWithMissingPolicy = new Set<string>();

    for (const r of openReceipts) {
      const result = await getPolicy(r.warehouseId, r.commodityId);
      if (!result.ok) {
        clientsWithMissingPolicy.add(r.clientId);
        continue;
      }
      let fee = 0;
      try {
        fee = this.storageFees.calculateFee(
          result.policy,
          Number(r.quantity),
          r.commodity.unitOfMeasure,
          r.dateOfDeposit,
          now,
          r.commodity.standardBagWeightKg ?? undefined,
        );
      } catch {
        // e.g. PER_BAG_PER_WEEK without bag weight — treat as missing fee.
        clientsWithMissingPolicy.add(r.clientId);
        continue;
      }
      outstandingByClient.set(
        r.clientId,
        (outstandingByClient.get(r.clientId) ?? 0) + fee,
      );
    }
    // A client whose only inventory has no policy resolvable falls out as null.
    for (const id of clientsWithMissingPolicy) {
      if (!outstandingByClient.has(id)) {
        // leave unset → null in the response
      }
    }

    return { lastDepositByClient, outstandingByClient };
  }

  // ── receipt detail (tree-backed, explicit) ────────────────────────────────

  async getReceiptDetail(tenantId: string, receiptId: string) {
    return this.query.getReceiptDetail(tenantId, receiptId);
  }

  // ── per-client unified transaction history ────────────────────────────────

  async getClientTransactions(
    tenantId: string,
    clientUserId: string,
    opts: { type?: string; page?: string; limit?: string },
  ) {
    const profile = await this.prisma.clientProfile.findFirst({
      where: { tenantId, userId: clientUserId },
      select: { id: true },
    });
    if (!profile) throw new NotFoundException('Client not found');

    const want = (opts.type ?? '').toUpperCase();
    const include = (t: string) => !want || want === t;

    const scope = await this.whScope.warehouseIds(tenantId);
    const whR = scope ? { warehouseId: { in: scope } } : {};
    const whT = scope ? { receipt: { warehouseId: { in: scope } } } : {};

    const [deposits, withdrawals, loans, trades] = await Promise.all([
      include('DEPOSIT')
        ? this.prisma.receipt.findMany({
            where: {
              tenantId,
              clientId: clientUserId,
              parentReceiptId: null,
              ...whR,
            },
            include: { commodity: { select: { name: true } } },
          })
        : [],
      include('WITHDRAWAL')
        ? this.prisma.withdrawal.findMany({
            where: { tenantId, clientId: clientUserId, ...whT },
            include: { receipt: { include: { commodity: true } } },
          })
        : [],
      include('LOAN')
        ? this.prisma.loan.findMany({
            where: { tenantId, clientId: clientUserId, ...whT },
            include: {
              receipt: { include: { commodity: true } },
              financier: { select: { name: true } },
            },
          })
        : [],
      include('TRADE')
        ? this.prisma.trade.findMany({
            where: {
              tenantId,
              OR: [{ sellerId: clientUserId }, { buyerId: clientUserId }],
              ...whT,
            },
            include: { receipt: { include: { commodity: true } } },
          })
        : [],
    ]);

    const items = [
      ...deposits.map((r) => ({
        id: r.id,
        type: 'DEPOSIT',
        reference: r.receiptNumber,
        status: r.status,
        commodity: r.commodity.name,
        quantity: Number(r.quantity),
        receiptId: r.id,
        receiptNumber: r.receiptNumber,
        warehouseId: r.warehouseId,
        counterparty: null as string | null,
        date: r.createdAt,
      })),
      ...withdrawals.map((w) => ({
        id: w.id,
        type: 'WITHDRAWAL',
        reference: w.reference,
        status: w.status,
        commodity: w.receipt.commodity.name,
        quantity: w.quantity,
        receiptId: w.receiptId,
        receiptNumber: w.receipt.receiptNumber,
        warehouseId: w.receipt.warehouseId,
        counterparty: null as string | null,
        date: w.createdAt,
      })),
      ...loans.map((l) => ({
        id: l.id,
        type: 'LOAN',
        reference: l.reference,
        status: l.status,
        commodity: l.receipt.commodity.name,
        quantity: Number(l.receipt.quantity),
        receiptId: l.receiptId,
        receiptNumber: l.receipt.receiptNumber,
        warehouseId: l.receipt.warehouseId,
        counterparty: l.financier.name,
        date: l.createdAt,
      })),
      ...trades.map((t) => ({
        id: t.id,
        type: 'TRADE',
        reference: t.reference,
        status: t.status,
        commodity: t.receipt.commodity.name,
        quantity: t.quantity,
        receiptId: t.receiptId,
        receiptNumber: t.receipt.receiptNumber,
        warehouseId: t.receipt.warehouseId,
        counterparty: t.sellerId === clientUserId ? 'SELL' : 'BUY',
        date: t.createdAt,
      })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime());

    const page = Math.max(1, parseInt(opts.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(opts.limit || '20', 10)));
    const total = items.length;
    return {
      data: items.slice((page - 1) * limit, page * limit),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  // ── withdrawal management ─────────────────────────────────────────────────

  async getWithdrawalStats(tenantId: string) {
    const scope = await this.whScope.warehouseIds(tenantId);
    const grouped = await this.prisma.withdrawal.groupBy({
      by: ['status'],
      where: {
        tenantId,
        ...(scope ? { receipt: { warehouseId: { in: scope } } } : {}),
      },
      _count: { _all: true },
    });
    const by = (s: WithdrawalStatus) =>
      grouped.find((g) => g.status === s)?._count._all ?? 0;
    return {
      all: grouped.reduce((n, g) => n + g._count._all, 0),
      pending:
        by(WithdrawalStatus.PENDING_PAYMENT) +
        by(WithdrawalStatus.PAID_PENDING_APPROVAL),
      approved: by(WithdrawalStatus.APPROVED),
      completed: by(WithdrawalStatus.COMPLETED),
      rejected: by(WithdrawalStatus.REJECTED),
    };
  }

  async listWithdrawals(
    tenantId: string,
    opts: {
      tab?: string;
      status?: string;
      search?: string;
      page?: string;
      limit?: string;
    },
  ) {
    const page = Math.max(1, parseInt(opts.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(opts.limit || '20', 10)));

    const where: any = { tenantId };
    const scope = await this.whScope.warehouseIds(tenantId);
    if (scope) where.receipt = { warehouseId: { in: scope } };
    const tab = (opts.tab ?? 'all').toLowerCase();
    if (opts.status) {
      where.status = opts.status as WithdrawalStatus;
    } else if (tab === 'pending') {
      where.status = {
        in: [
          WithdrawalStatus.PENDING_PAYMENT,
          WithdrawalStatus.PAID_PENDING_APPROVAL,
        ],
      };
    } else if (tab === 'completed') {
      where.status = WithdrawalStatus.COMPLETED;
    }
    if (opts.search) {
      where.OR = [
        { reference: { contains: opts.search, mode: 'insensitive' } },
        {
          receipt: {
            receiptNumber: { contains: opts.search, mode: 'insensitive' },
          },
        },
        {
          receipt: {
            commodity: {
              name: { contains: opts.search, mode: 'insensitive' },
            },
          },
        },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where,
        include: {
          receipt: { include: { commodity: true, warehouse: true } },
          client: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.withdrawal.count({ where }),
    ]);

    return {
      data: rows.map((w) => ({
        id: w.id,
        reference: w.reference,
        receiptId: w.receiptId,
        receiptNumber: w.receipt.receiptNumber,
        clientName: `${w.client.firstName} ${w.client.lastName}`,
        commodity: w.receipt.commodity.name,
        quantity: w.quantity,
        grade: w.receipt.grade,
        warehouse: w.receipt.warehouse.name,
        status: w.status,
        requestDate: w.createdAt,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async getWithdrawalDetail(tenantId: string, withdrawalId: string) {
    const w = await this.prisma.withdrawal.findFirst({
      where: { id: withdrawalId, tenantId },
      include: {
        receipt: { include: { commodity: true, warehouse: true } },
        client: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    if (!w) throw new NotFoundException('Withdrawal not found');

    const [receiptDetail, txnChain] = await Promise.all([
      this.query.getReceiptDetail(tenantId, w.receiptId).catch(() => null),
      this.query
        .getTransactionDetail(tenantId, TxnType.WITHDRAWAL, w.id)
        .catch(() => null),
    ]);

    return {
      id: w.id,
      reference: w.reference,
      status: w.status,
      quantity: w.quantity,
      reason: w.reason,
      plannedDate: w.plannedDate,
      storageFee: w.storageFee,
      handlingFee: w.handlingFee,
      totalFee: w.totalFee,
      approvedAt: w.approvedAt,
      rejectionReason: w.rejectionReason,
      client: w.client,
      receipt: {
        id: w.receipt.id,
        receiptNumber: w.receipt.receiptNumber,
        commodity: w.receipt.commodity.name,
        grade: w.receipt.grade,
        warehouse: w.receipt.warehouse.name,
        status: w.receipt.status,
      },
      // explicit, architecture-backed lineage + ledger trail
      receiptLineage: receiptDetail,
      ledgerTrail: txnChain,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  }

  // ── transaction reports (tenant-wide, ledger/domain backed) ───────────────

  async getTransactionStats(tenantId: string) {
    const scope = await this.whScope.warehouseIds(tenantId);
    const whR = scope ? { warehouseId: { in: scope } } : {};
    const whT = scope ? { receipt: { warehouseId: { in: scope } } } : {};
    const [deposits, withdrawals, loans, trades, dispatches] =
      await Promise.all([
        this.prisma.receipt.count({
          where: { tenantId, parentReceiptId: null, ...whR },
        }),
        this.prisma.withdrawal.count({ where: { tenantId, ...whT } }),
        this.prisma.loan.count({ where: { tenantId, ...whT } }),
        this.prisma.trade.count({ where: { tenantId, ...whT } }),
        this.prisma.withdrawal.count({
          where: { tenantId, status: WithdrawalStatus.COMPLETED, ...whT },
        }),
      ]);
    return {
      totalTransaction: deposits + withdrawals + loans + trades,
      totalDeposit: deposits,
      totalPledges: loans,
      totalDispatches: dispatches,
    };
  }

  private async collectTransactions(
    tenantId: string,
    clientUserId?: string,
  ) {
    const scope = await this.whScope.warehouseIds(tenantId);
    const whR = scope ? { warehouseId: { in: scope } } : {};
    const whT = scope ? { receipt: { warehouseId: { in: scope } } } : {};
    const clientFilter = clientUserId ? { clientId: clientUserId } : {};
    const sel = {
      select: { id: true, firstName: true, lastName: true },
    } as const;

    const [deposits, withdrawals, loans, trades] = await Promise.all([
      this.prisma.receipt.findMany({
        where: { tenantId, parentReceiptId: null, ...clientFilter, ...whR },
        include: { commodity: { select: { name: true } }, client: sel },
      }),
      this.prisma.withdrawal.findMany({
        where: { tenantId, ...clientFilter, ...whT },
        include: {
          receipt: { include: { commodity: true } },
          client: sel,
        },
      }),
      this.prisma.loan.findMany({
        where: { tenantId, ...clientFilter, ...whT },
        include: {
          receipt: { include: { commodity: true } },
          client: sel,
          financier: { select: { name: true } },
        },
      }),
      this.prisma.trade.findMany({
        where: clientUserId
          ? {
              tenantId,
              OR: [{ sellerId: clientUserId }, { buyerId: clientUserId }],
              ...whT,
            }
          : { tenantId, ...whT },
        include: { receipt: { include: { commodity: true } }, seller: sel },
      }),
    ]);

    const name = (u: { firstName: string; lastName: string }) =>
      `${u.firstName} ${u.lastName}`;

    return [
      ...deposits.map((r) => ({
        id: r.id,
        type: 'DEPOSIT',
        reference: r.receiptNumber,
        status: r.status,
        clientId: r.clientId,
        clientName: name(r.client),
        commodity: r.commodity.name,
        quantity: Number(r.quantity),
        receiptId: r.id,
        receiptNumber: r.receiptNumber,
        warehouseId: r.warehouseId,
        counterparty: null as string | null,
        date: r.createdAt,
      })),
      ...withdrawals.map((w) => ({
        id: w.id,
        type: 'WITHDRAWAL',
        reference: w.reference,
        status: w.status,
        clientId: w.clientId,
        clientName: name(w.client),
        commodity: w.receipt.commodity.name,
        quantity: w.quantity,
        receiptId: w.receiptId,
        receiptNumber: w.receipt.receiptNumber,
        warehouseId: w.receipt.warehouseId,
        counterparty: null as string | null,
        date: w.createdAt,
      })),
      ...loans.map((l) => ({
        id: l.id,
        type: 'LOAN',
        reference: l.reference,
        status: l.status,
        clientId: l.clientId,
        clientName: name(l.client),
        commodity: l.receipt.commodity.name,
        quantity: Number(l.receipt.quantity),
        receiptId: l.receiptId,
        receiptNumber: l.receipt.receiptNumber,
        warehouseId: l.receipt.warehouseId,
        counterparty: l.financier.name,
        date: l.createdAt,
      })),
      ...trades.map((t) => ({
        id: t.id,
        type: 'TRADE',
        reference: t.reference,
        status: t.status,
        clientId: t.sellerId,
        clientName: name(t.seller),
        commodity: t.receipt.commodity.name,
        quantity: t.quantity,
        receiptId: t.receiptId,
        receiptNumber: t.receipt.receiptNumber,
        warehouseId: t.receipt.warehouseId,
        counterparty: null as string | null,
        date: t.createdAt,
      })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  async listTransactions(
    tenantId: string,
    opts: {
      type?: string;
      search?: string;
      clientId?: string;
      warehouseId?: string;
      fromDate?: string | Date;
      toDate?: string | Date;
      page?: string;
      limit?: string;
    },
  ) {
    let items = await this.collectTransactions(tenantId);

    const want = (opts.type ?? '').toUpperCase();
    const norm = want === 'PLEDGE' ? 'LOAN' : want;
    if (norm) items = items.filter((i) => i.type === norm);

    if (opts.clientId) {
      const c = opts.clientId;
      items = items.filter((i) => i.clientId === c);
    }
    if (opts.warehouseId) {
      const w = opts.warehouseId;
      items = items.filter((i) => (i as any).warehouseId === w);
    }
    if (opts.fromDate) {
      const fd =
        typeof opts.fromDate === 'string'
          ? new Date(opts.fromDate)
          : opts.fromDate;
      items = items.filter((i) => i.date.getTime() >= fd.getTime());
    }
    if (opts.toDate) {
      const td =
        typeof opts.toDate === 'string' ? new Date(opts.toDate) : opts.toDate;
      items = items.filter((i) => i.date.getTime() <= td.getTime());
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      items = items.filter(
        (i) =>
          i.reference.toLowerCase().includes(q) ||
          i.clientName.toLowerCase().includes(q) ||
          i.commodity.toLowerCase().includes(q),
      );
    }

    const page = Math.max(1, parseInt(opts.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(opts.limit || '20', 10)));
    const total = items.length;
    return {
      data: items.slice((page - 1) * limit, page * limit),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async getTransactionDetail(tenantId: string, type: string, id: string) {
    const t = type.toUpperCase() === 'PLEDGE' ? 'LOAN' : type.toUpperCase();

    if (t === 'DEPOSIT') {
      return { type: 'DEPOSIT', ...(await this.query.getReceiptDetail(tenantId, id)) };
    }

    const ledger = await this.query
      .getTransactionDetail(tenantId, t as TxnType, id)
      .catch(() => null);

    if (t === 'WITHDRAWAL') {
      const w = await this.prisma.withdrawal.findFirst({
        where: { id, tenantId },
        include: {
          receipt: { include: { commodity: true, warehouse: true } },
          client: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      if (!w) throw new NotFoundException('Transaction not found');
      return {
        type: 'WITHDRAWAL',
        record: w,
        receiptLineage: await this.query
          .getReceiptDetail(tenantId, w.receiptId)
          .catch(() => null),
        ledgerTrail: ledger,
      };
    }
    if (t === 'LOAN') {
      const l = await this.prisma.loan.findFirst({
        where: { id, tenantId },
        include: {
          receipt: { include: { commodity: true, warehouse: true } },
          client: { select: { id: true, firstName: true, lastName: true } },
          financier: { select: { id: true, name: true } },
        },
      });
      if (!l) throw new NotFoundException('Transaction not found');
      return {
        type: 'LOAN',
        record: l,
        receiptLineage: await this.query
          .getReceiptDetail(tenantId, l.receiptId)
          .catch(() => null),
        ledgerTrail: ledger,
      };
    }
    if (t === 'TRADE') {
      const tr = await this.prisma.trade.findFirst({
        where: { id, tenantId },
        include: {
          receipt: { include: { commodity: true, warehouse: true } },
          seller: { select: { id: true, firstName: true, lastName: true } },
          buyer: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      if (!tr) throw new NotFoundException('Transaction not found');
      return {
        type: 'TRADE',
        record: tr,
        receiptLineage: await this.query
          .getReceiptDetail(tenantId, tr.receiptId)
          .catch(() => null),
        ledgerTrail: ledger,
      };
    }
    throw new BadRequestException(`Unknown transaction type: ${type}`);
  }

  // ── commodity management ──────────────────────────────────────────────────

  async getCommodityStats(tenantId: string) {
    const scope = await this.whScope.warehouseIds(tenantId);
    const whR = scope ? { warehouseId: { in: scope } } : {};
    const whT = scope ? { receipt: { warehouseId: { in: scope } } } : {};
    const twoMo = new Date();
    twoMo.setMonth(twoMo.getMonth() - 2);

    const [
      activeByCommodity,
      activeByCommodityDelta,
      depositsCount,
      depositsDelta,
      withdrawalsCount,
      withdrawalsDelta,
      commodities,
    ] = await Promise.all([
      this.prisma.receipt.groupBy({
        by: ['commodityId'],
        where: { tenantId, status: 'ACTIVE', ...whR },
        _sum: { quantity: true },
      }),
      this.prisma.receipt.groupBy({
        by: ['commodityId'],
        where: {
          tenantId,
          status: 'ACTIVE',
          createdAt: { gte: twoMo },
          ...whR,
        },
        _sum: { quantity: true },
      }),
      this.prisma.receipt.count({
        where: { tenantId, parentReceiptId: null, ...whR },
      }),
      this.prisma.receipt.count({
        where: {
          tenantId,
          parentReceiptId: null,
          createdAt: { gte: twoMo },
          ...whR,
        },
      }),
      this.prisma.withdrawal.count({ where: { tenantId, ...whT } }),
      this.prisma.withdrawal.count({
        where: { tenantId, createdAt: { gte: twoMo }, ...whT },
      }),
      this.prisma.commodity.findMany({
        where: { tenantId },
        select: { id: true, name: true, unitOfMeasure: true },
      }),
    ]);

    const commById = new Map(commodities.map((c) => [c.id, c]));

    const byCommodity = activeByCommodity.flatMap((g) => {
      const c = commById.get(g.commodityId);
      if (!c) return [];
      return [
        {
          commodityId: c.id,
          name: c.name,
          unit: c.unitOfMeasure,
          quantity: Number(g._sum.quantity ?? 0),
        },
      ];
    });

    const sumByUnit = (
      rows: { commodityId: string; _sum: { quantity: any } }[],
    ) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const c = commById.get(r.commodityId);
        if (!c) continue;
        m.set(
          c.unitOfMeasure,
          (m.get(c.unitOfMeasure) ?? 0) + Number(r._sum.quantity ?? 0),
        );
      }
      return [...m.entries()].map(([unit, quantity]) => ({ unit, quantity }));
    };

    return {
      totalVolume: {
        byUnit: sumByUnit(activeByCommodity),
        byCommodity,
        deltaByUnit: sumByUnit(activeByCommodityDelta),
      },
      totalDeposits: { value: depositsCount, deltaLast2Months: depositsDelta },
      totalWithdrawals: {
        value: withdrawalsCount,
        deltaLast2Months: withdrawalsDelta,
      },
    };
  }

  async listCommodities(tenantId: string) {
    const scope = await this.whScope.warehouseIds(tenantId);
    const commWhere: any = { tenantId };
    if (scope)
      commWhere.warehouseCommodities = { some: { warehouseId: { in: scope } } };
    const [commodities, volumes] = await Promise.all([
      this.prisma.commodity.findMany({
        where: commWhere,
        orderBy: { name: 'asc' },
      }),
      this.prisma.receipt.groupBy({
        by: ['commodityId'],
        where: {
          tenantId,
          status: 'ACTIVE',
          ...(scope ? { warehouseId: { in: scope } } : {}),
        },
        _sum: { quantity: true },
      }),
    ]);
    const volById = new Map(
      volumes.map((v) => [v.commodityId, Number(v._sum.quantity ?? 0)]),
    );
    return commodities.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      unitOfMeasure: c.unitOfMeasure,
      activeVolume: volById.get(c.id) ?? 0,
    }));
  }

  async getCommodityDetail(tenantId: string, commodityId: string) {
    const commodity = await this.prisma.commodity.findFirst({
      where: { id: commodityId, tenantId },
      include: { _count: { select: { gradingParameters: true } } },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');

    const scope = await this.whScope.warehouseIds(tenantId);
    const grouped = await this.prisma.receipt.groupBy({
      by: ['status'],
      where: {
        tenantId,
        commodityId,
        ...(scope ? { warehouseId: { in: scope } } : {}),
      },
      _sum: { quantity: true },
    });
    const sum = (s: string) =>
      Number(grouped.find((g) => g.status === s)?._sum.quantity ?? 0);

    return {
      id: commodity.id,
      name: commodity.name,
      code: commodity.code,
      unitOfMeasure: commodity.unitOfMeasure,
      gradingLogic: commodity.gradingLogic,
      numberOfGrades: commodity.numberOfGrades,
      gradingParameterCount: commodity._count.gradingParameters,
      summary: {
        total: sum('ACTIVE'),
        withdrawn: sum('WITHDRAWN'),
        loaned: sum('HELD_LOAN'),
        traded: sum('TRADED_OUT') + sum('HELD_TRADE'),
      },
    };
  }

  async listCommodityReceipts(
    tenantId: string,
    opts: {
      status?: string;
      commodityId?: string;
      search?: string;
      page?: string;
      limit?: string;
    },
  ) {
    const page = Math.max(1, parseInt(opts.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(opts.limit || '20', 10)));

    const where: any = { tenantId };
    const scope = await this.whScope.warehouseIds(tenantId);
    if (scope) where.warehouseId = { in: scope };
    if (opts.commodityId) where.commodityId = opts.commodityId;
    const s = (opts.status ?? '').toUpperCase();
    if (s === 'ACTIVE') where.status = { in: statusesForGroup('ACTIVE') };
    else if (s === 'CANCELLED')
      where.status = { in: statusesForGroup('CANCELLED') };
    else if (s === 'PLEDGE' || s === 'LIENED')
      where.status = { in: statusesForGroup('LIENED') };
    if (opts.search) {
      where.OR = [
        { receiptNumber: { contains: opts.search, mode: 'insensitive' } },
        { commodity: { name: { contains: opts.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        include: {
          commodity: { select: { name: true } },
          warehouse: { select: { name: true } },
          client: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.receipt.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        receiptNumber: r.receiptNumber,
        clientName: `${r.client.firstName} ${r.client.lastName}`,
        commodity: r.commodity.name,
        warehouse: r.warehouse.name,
        quantity: Number(r.quantity),
        grade: r.grade,
        dateIssued: r.createdAt,
        status: r.status,
        group: deriveGroup(r),
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  // ── dashboard summary (warehouse-scoped, live) ────────────────────────────

  async getDashboard(tenantId: string) {
    const scope = await this.whScope.warehouseIds(tenantId);
    const whR = scope ? { warehouseId: { in: scope } } : {};
    const whT = scope ? { receipt: { warehouseId: { in: scope } } } : {};
    const us = scope
      ? { receipts: { some: { warehouseId: { in: scope } } } }
      : {};
    const twoMo = new Date();
    twoMo.setMonth(twoMo.getMonth() - 2);
    const sixMo = new Date();
    sixMo.setMonth(sixMo.getMonth() - 6);
    const liened = statusesForGroup('LIENED');
    const pendingW = [
      WithdrawalStatus.PENDING_PAYMENT,
      WithdrawalStatus.PAID_PENDING_APPROVAL,
    ];

    const [
      totalClients,
      clientsDelta,
      commodityVol,
      commodityVolDelta,
      underLien,
      lienDelta,
      pendingWithdrawal,
      pendingWithdrawalDelta,
      statusActive,
      statusLiened,
      statusCancelled,
      distribution,
      commodities,
      warehouses,
      utilization,
      recent,
      depMoves,
      wdrMoves,
    ] = await Promise.all([
      this.prisma.clientProfile.count({ where: { tenantId, user: { ...us } } }),
      this.prisma.clientProfile.count({
        where: { tenantId, user: { ...us }, createdAt: { gte: twoMo } },
      }),
      this.prisma.receipt.groupBy({
        by: ['commodityId'],
        where: { tenantId, status: 'ACTIVE', ...whR },
        _sum: { quantity: true },
      }),
      this.prisma.receipt.groupBy({
        by: ['commodityId'],
        where: { tenantId, status: 'ACTIVE', createdAt: { gte: twoMo }, ...whR },
        _sum: { quantity: true },
      }),
      this.prisma.receipt.count({
        where: { tenantId, status: { in: liened }, ...whR },
      }),
      this.prisma.receipt.count({
        where: {
          tenantId,
          status: { in: liened },
          createdAt: { gte: twoMo },
          ...whR,
        },
      }),
      this.prisma.withdrawal.count({
        where: { tenantId, status: { in: pendingW }, ...whT },
      }),
      this.prisma.withdrawal.count({
        where: {
          tenantId,
          status: { in: pendingW },
          createdAt: { gte: twoMo },
          ...whT,
        },
      }),
      this.prisma.receipt.count({
        where: { tenantId, status: { in: statusesForGroup('ACTIVE') }, ...whR },
      }),
      this.prisma.receipt.count({
        where: { tenantId, status: { in: liened }, ...whR },
      }),
      this.prisma.receipt.count({
        where: {
          tenantId,
          status: { in: statusesForGroup('CANCELLED') },
          ...whR,
        },
      }),
      this.prisma.receipt.groupBy({
        by: ['commodityId'],
        where: { tenantId, status: 'ACTIVE', ...whR },
        _sum: { quantity: true },
      }),
      this.prisma.commodity.findMany({
        where: { tenantId },
        select: { id: true, name: true, unitOfMeasure: true },
      }),
      this.prisma.warehouse.findMany({
        where: scope ? { tenantId, id: { in: scope } } : { tenantId },
        select: { id: true, name: true, capacityMt: true },
      }),
      this.prisma.receipt.groupBy({
        by: ['warehouseId'],
        where: { tenantId, status: 'ACTIVE', ...whR },
        _sum: { quantity: true },
      }),
      this.collectTransactions(tenantId),
      this.prisma.receipt.findMany({
        where: {
          tenantId,
          parentReceiptId: null,
          createdAt: { gte: sixMo },
          ...whR,
        },
        // commodityId surfaces so we can break the bucket down per-commodity
        // (with its own unit), instead of summing mixed-unit quantities.
        select: { createdAt: true, quantity: true, commodityId: true },
      }),
      this.prisma.withdrawal.findMany({
        where: { tenantId, createdAt: { gte: sixMo }, ...whT },
        select: {
          createdAt: true,
          quantity: true,
          receipt: { select: { commodityId: true } },
        },
      }),
    ]);

    const commName = new Map(commodities.map((c) => [c.id, c.name]));
    const commById = new Map(commodities.map((c) => [c.id, c]));
    const sumByUnit = (
      rows: { commodityId: string; _sum: { quantity: any } }[],
    ) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const c = commById.get(r.commodityId);
        if (!c) continue;
        m.set(
          c.unitOfMeasure,
          (m.get(c.unitOfMeasure) ?? 0) + Number(r._sum.quantity ?? 0),
        );
      }
      return [...m.entries()].map(([unit, quantity]) => ({ unit, quantity }));
    };
    const byCommodityVolume = commodityVol.flatMap((g) => {
      const c = commById.get(g.commodityId);
      return c
        ? [
            {
              commodityId: c.id,
              name: c.name,
              unit: c.unitOfMeasure,
              quantity: Number(g._sum.quantity ?? 0),
            },
          ]
        : [];
    });
    const utilById = new Map(
      utilization.map((u) => [u.warehouseId, Number(u._sum.quantity ?? 0)]),
    );
    const ym = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

    // ── Movement bucket — TWO accumulators per month ────────────────────────
    //
    // The legacy fields (`deposits`, `withdrawals`) sum quantities. They're
    // kept for backward compatibility (FE chart still works), but they're
    // dimensionally mixed: 500 KG of Maize + 5 MT of Rice + 50 BAG of Cement
    // get added together as if they were the same unit. The number can shift
    // purely because the commodity mix did.
    //
    // The new fields restore honesty:
    //   - `depositCount` / `withdrawalCount` — raw row counts, the "how
    //     often" your eye expected when looking at "1800 deposits".
    //   - `byCommodity[]` — per-commodity rows with their own UNIT. The
    //     FE renders one chart series per commodity and the eye compares
    //     them correctly.
    interface CommodityBucket {
      deposits: number;
      withdrawals: number;
      depositCount: number;
      withdrawalCount: number;
    }
    interface MovementBucket {
      month: string;
      deposits: number;
      withdrawals: number;
      depositCount: number;
      withdrawalCount: number;
      byCommodity: Map<string, CommodityBucket>;
    }
    const moveMap = new Map<string, MovementBucket>();
    const bucket = (d: Date): MovementBucket => {
      const k = ym(d);
      let row = moveMap.get(k);
      if (!row) {
        row = {
          month: k,
          deposits: 0,
          withdrawals: 0,
          depositCount: 0,
          withdrawalCount: 0,
          byCommodity: new Map(),
        };
        moveMap.set(k, row);
      }
      return row;
    };
    const perComm = (
      row: MovementBucket,
      commodityId: string,
    ): CommodityBucket => {
      let pc = row.byCommodity.get(commodityId);
      if (!pc) {
        pc = {
          deposits: 0,
          withdrawals: 0,
          depositCount: 0,
          withdrawalCount: 0,
        };
        row.byCommodity.set(commodityId, pc);
      }
      return pc;
    };
    for (const r of depMoves) {
      const row = bucket(r.createdAt);
      const qty = Number(r.quantity);
      row.deposits += qty;
      row.depositCount += 1;
      const pc = perComm(row, r.commodityId);
      pc.deposits += qty;
      pc.depositCount += 1;
    }
    for (const w of wdrMoves) {
      const row = bucket(w.createdAt);
      row.withdrawals += w.quantity;
      row.withdrawalCount += 1;
      const pc = perComm(row, w.receipt.commodityId);
      pc.withdrawals += w.quantity;
      pc.withdrawalCount += 1;
    }

    return {
      cards: {
        totalClients: { value: totalClients, deltaLast2Months: clientsDelta },
        totalCommodity: {
          byUnit: sumByUnit(commodityVol),
          byCommodity: byCommodityVolume,
          deltaByUnit: sumByUnit(commodityVolDelta),
        },
        underLien: { value: underLien, deltaLast2Months: lienDelta },
        pendingWithdrawal: {
          value: pendingWithdrawal,
          deltaLast2Months: pendingWithdrawalDelta,
        },
      },
      receiptStatusOverview: {
        active: statusActive,
        liened: statusLiened,
        cancelled: statusCancelled,
      },
      storageDistribution: distribution.flatMap((d) => {
        const c = commById.get(d.commodityId);
        return c
          ? [
              {
                commodity: c.name,
                unit: c.unitOfMeasure,
                quantity: Number(d._sum.quantity ?? 0),
              },
            ]
          : [];
      }),
      warehouseCapacityUtilization: warehouses.map((w) => ({
        id: w.id,
        name: w.name,
        capacityMt: w.capacityMt ?? 0,
        utilizedMt: utilById.get(w.id) ?? 0,
      })),
      commodityMovement: [...moveMap.values()]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((row) => ({
          month: row.month,
          // Legacy mixed-unit quantity sums — kept so existing chart code
          // doesn't break. New consumers should prefer `byCommodity` (units
          // attached) or the *Count fields (dimension-free).
          deposits: row.deposits,
          withdrawals: row.withdrawals,
          // Honest transaction counts.
          depositCount: row.depositCount,
          withdrawalCount: row.withdrawalCount,
          // Per-commodity breakdown with each commodity's own unit. This is
          // the truthful series the chart should render.
          byCommodity: [...row.byCommodity.entries()].flatMap(([id, qs]) => {
            const c = commById.get(id);
            if (!c) return [];
            return [
              {
                commodityId: id,
                name: c.name,
                unit: c.unitOfMeasure,
                deposits: qs.deposits,
                withdrawals: qs.withdrawals,
                depositCount: qs.depositCount,
                withdrawalCount: qs.withdrawalCount,
              },
            ];
          }),
        })),
      recentActivities: recent.slice(0, 8).map((t) => ({
        id: t.id,
        type: t.type,
        reference: t.reference,
        clientName: t.clientName,
        commodity: t.commodity,
        quantity: t.quantity,
        status: t.status,
        date: t.date,
      })),
    };
  }

  /**
   * Filtered time-series for the WM dashboard chart. Three filter axes:
   *  - period:       preset window (7d / 30d / 90d / 6m / 1y / ytd / all / custom)
   *  - granularity:  bucket size (day / week / month / quarter / year)
   *  - commodityIds: optional subset; omit for all commodities the WM sees
   *
   * Defaults preserve the existing dashboard's `commodityMovement` shape
   * (6 months × monthly × all commodities) so callers that don't filter
   * see the same numbers.
   *
   * Each row carries `deposits` + `withdrawals` totals plus a per-commodity
   * breakdown — lets the FE render a single chart, a stacked chart, or a
   * commodity selector inside the same response.
   *
   * Semantics:
   *  - "deposit" = a root receipt's creation date and its quantity
   *    (parentReceiptId IS NULL — counts the original issuance, not splits).
   *  - "withdrawal" = a Withdrawal row's creation date and its quantity
   *    (counted at request time, not at dispatch — matches existing dashboard).
   */
  async getCommodityMovement(tenantId: string, opts: GetMovementDto) {
    const { from, to } = this.resolveMovementWindow(opts);
    const granularity: MovementGranularity = opts.granularity ?? 'month';
    const commodityIds = opts.commodityIds?.length ? opts.commodityIds : null;

    const scope = await this.whScope.warehouseIds(tenantId);
    const whR = scope ? { warehouseId: { in: scope } } : {};
    const whT = scope ? { receipt: { warehouseId: { in: scope } } } : {};

    const dateRange: { gte?: Date; lte?: Date } = {};
    if (from) dateRange.gte = from;
    if (to) dateRange.lte = to;
    const dateFilter = from || to ? { createdAt: dateRange } : {};

    const [deposits, withdrawals, commodities] = await Promise.all([
      this.prisma.receipt.findMany({
        where: {
          tenantId,
          parentReceiptId: null,
          ...(commodityIds ? { commodityId: { in: commodityIds } } : {}),
          ...whR,
          ...dateFilter,
        },
        select: {
          createdAt: true,
          quantity: true,
          commodityId: true,
        },
      }),
      this.prisma.withdrawal.findMany({
        where: {
          tenantId,
          ...(commodityIds
            ? {
                receipt: {
                  commodityId: { in: commodityIds },
                  ...(scope ? { warehouseId: { in: scope } } : {}),
                },
              }
            : whT),
          ...dateFilter,
        },
        select: {
          createdAt: true,
          quantity: true,
          receipt: { select: { commodityId: true } },
        },
      }),
      this.prisma.commodity.findMany({
        where: {
          tenantId,
          ...(commodityIds ? { id: { in: commodityIds } } : {}),
        },
        select: { id: true, name: true, unitOfMeasure: true },
      }),
    ]);

    const commById = new Map(commodities.map((c) => [c.id, c]));

    // Same dual-accumulator pattern as getDashboard: legacy mixed-unit
    // quantity sums kept for backward compat (see comment over there for
    // the full reasoning); honest transaction counts + per-commodity-with-
    // unit breakdown for the new chart shape.
    type CommodityCell = {
      deposits: number;
      withdrawals: number;
      depositCount: number;
      withdrawalCount: number;
    };
    type BucketRow = {
      deposits: number;
      withdrawals: number;
      depositCount: number;
      withdrawalCount: number;
      byCommodity: Map<string, CommodityCell>;
    };
    const buckets = new Map<string, BucketRow>();
    const empty = (): BucketRow => ({
      deposits: 0,
      withdrawals: 0,
      depositCount: 0,
      withdrawalCount: 0,
      byCommodity: new Map(),
    });
    const get = (key: string) => {
      let row = buckets.get(key);
      if (!row) {
        row = empty();
        buckets.set(key, row);
      }
      return row;
    };
    const perComm = (row: BucketRow, commodityId: string) => {
      let pc = row.byCommodity.get(commodityId);
      if (!pc) {
        pc = {
          deposits: 0,
          withdrawals: 0,
          depositCount: 0,
          withdrawalCount: 0,
        };
        row.byCommodity.set(commodityId, pc);
      }
      return pc;
    };

    for (const r of deposits) {
      const key = this.bucketKey(r.createdAt, granularity);
      const row = get(key);
      const qty = Number(r.quantity);
      row.deposits += qty;
      row.depositCount += 1;
      const pc = perComm(row, r.commodityId);
      pc.deposits += qty;
      pc.depositCount += 1;
    }
    for (const w of withdrawals) {
      const key = this.bucketKey(w.createdAt, granularity);
      const row = get(key);
      row.withdrawals += w.quantity;
      row.withdrawalCount += 1;
      const pc = perComm(row, w.receipt.commodityId);
      pc.withdrawals += w.quantity;
      pc.withdrawalCount += 1;
    }

    const data = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, row]) => ({
        bucket,
        deposits: row.deposits,
        withdrawals: row.withdrawals,
        depositCount: row.depositCount,
        withdrawalCount: row.withdrawalCount,
        byCommodity: [...row.byCommodity.entries()].flatMap(([id, qs]) => {
          const c = commById.get(id);
          if (!c) return [];
          return [
            {
              commodityId: id,
              name: c.name,
              unit: c.unitOfMeasure,
              deposits: qs.deposits,
              withdrawals: qs.withdrawals,
              depositCount: qs.depositCount,
              withdrawalCount: qs.withdrawalCount,
            },
          ];
        }),
      }));

    return {
      data,
      meta: {
        period: opts.period ?? '6m',
        from: from ? from.toISOString().slice(0, 10) : null,
        to: to ? to.toISOString().slice(0, 10) : null,
        granularity,
        commodityIds: commodityIds ?? [],
      },
    };
  }

  /**
   * Resolve the date window from a period preset (or explicit from/to).
   * `all` returns nulls so no date filter is applied.
   */
  private resolveMovementWindow(opts: GetMovementDto): {
    from: Date | null;
    to: Date | null;
  } {
    const period = opts.period ?? '6m';
    if (period === 'custom') {
      return {
        from: opts.from ? new Date(opts.from) : null,
        to: opts.to ? new Date(opts.to) : null,
      };
    }
    if (period === 'all') return { from: null, to: null };

    const now = new Date();
    const from = new Date(now);
    if (period === '7d') from.setDate(from.getDate() - 7);
    else if (period === '30d') from.setDate(from.getDate() - 30);
    else if (period === '90d') from.setDate(from.getDate() - 90);
    else if (period === '6m') from.setMonth(from.getMonth() - 6);
    else if (period === '1y') from.setFullYear(from.getFullYear() - 1);
    else if (period === 'ytd') {
      from.setMonth(0);
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
    }
    return { from, to: now };
  }

  /**
   * Map a date to its bucket key for the given granularity. Keys are sortable
   * lexically so the FE can render them in chronological order without parsing:
   *   day     → 2026-05-21
   *   week    → 2026-W21       (ISO week number)
   *   month   → 2026-05
   *   quarter → 2026-Q2
   *   year    → 2026
   */
  private bucketKey(d: Date, g: MovementGranularity): string {
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    if (g === 'day') {
      return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    if (g === 'week') {
      // ISO week: Thursday determines the year, week 1 contains Jan 4.
      const dt = new Date(Date.UTC(y, m - 1, day));
      const dayNum = dt.getUTCDay() || 7;
      dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
      const week = Math.ceil(
        ((dt.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
      );
      return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    if (g === 'month') return `${y}-${String(m).padStart(2, '0')}`;
    if (g === 'quarter') {
      const q = Math.floor((m - 1) / 3) + 1;
      return `${y}-Q${q}`;
    }
    return `${y}`;
  }

  async getClientStats(tenantId: string, managerUserId: string) {
    const scopeWhere = await this.clientScopeWhere(tenantId, managerUserId);
    const base = (extra: any = {}) => ({
      tenantId,
      ...(scopeWhere ? { AND: [scopeWhere, extra] } : extra),
    });
    const [total, active, inactive] = await Promise.all([
      this.prisma.clientProfile.count({ where: base() }),
      this.prisma.clientProfile.count({
        where: base({ user: { status: 'ACTIVE' } }),
      }),
      this.prisma.clientProfile.count({
        where: base({
          user: { status: { in: ['INACTIVE', 'SUSPENDED', 'DEACTIVATED'] } },
        }),
      }),
    ]);
    return { total, active, inactive };
  }

  async getClient(tenantId: string, clientUserId: string) {
    const profile = await this.prisma.clientProfile.findFirst({
      where: { tenantId, userId: clientUserId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            middleName: true,
            email: true,
            contactEmail: true,
            phoneNumber: true,
            gender: true,
            dateOfBirth: true,
            profilePhotoUrl: true,
            status: true,
            residentialAddress: true,
            // Surface the client's security posture so the WM's on-behalf
            // form can decide whether to render the OTP step. We never expose
            // the PIN hash to a third party — just the boolean.
            twoFactorEnabled: true,
            transactionPinHash: true,
          },
        },
        focusCommodities: {
          include: { commodity: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
        // ORGANIZATION-mode children. For INDIVIDUAL clients both arrays are
        // empty so the response shape stays uniform.
        directors: { orderBy: { createdAt: 'asc' } },
        documents: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!profile) throw new NotFoundException('Client not found');

    const scope = await this.whScope.warehouseIds(tenantId);
    const whR = scope ? { warehouseId: { in: scope } } : {};
    const whT = scope ? { receipt: { warehouseId: { in: scope } } } : {};
    const [active, liened, cancelled, total, withdrawalDispatches] =
      await Promise.all([
        this.prisma.receipt.count({
          where: { tenantId, clientId: clientUserId, status: { in: statusesForGroup('ACTIVE') }, ...whR },
        }),
        this.prisma.receipt.count({
          where: { tenantId, clientId: clientUserId, status: { in: statusesForGroup('LIENED') }, ...whR },
        }),
        this.prisma.receipt.count({
          where: { tenantId, clientId: clientUserId, status: { in: statusesForGroup('CANCELLED') }, ...whR },
        }),
        this.prisma.receipt.count({
          where: { tenantId, clientId: clientUserId, ...whR },
        }),
        // Tenant-admin-approved withdrawals awaiting WM dispatch (status = APPROVED).
        this.prisma.withdrawal.count({
          where: {
            tenantId,
            clientId: clientUserId,
            status: 'APPROVED',
            ...whT,
          },
        }),
      ]);

    const repName = `${profile.user.firstName} ${profile.user.lastName}`;

    return {
      clientId: profile.userId,
      clientCode: profile.clientCode,
      mode: profile.mode,
      // `name` is what the UI surfaces in lists / titles. For ORGANIZATION
      // clients it's the company name; the rep's name lives under
      // `organization.representative`.
      name:
        profile.mode === 'ORGANIZATION'
          ? (profile.companyName ?? repName)
          : repName,

      // ── Discrete form fields ─────────────────────────────────────────────
      // Surfaced as individual fields (in addition to combined `name`) so
      // the WM's "Edit client" form can prefill each input. The previous
      // shape only carried `name` as one string, which forced the FE to
      // split it — fragile when middle/multi-part names are involved.
      firstName: profile.user.firstName,
      lastName: profile.user.lastName,
      middleName: profile.user.middleName,
      gender: profile.user.gender,
      dateOfBirth: profile.user.dateOfBirth,
      nationality: profile.nationality,
      stateOfOrigin: profile.stateOfOrigin,
      lga: profile.lga,
      nationalId: profile.nationalId,
      profilePhotoUrl: profile.user.profilePhotoUrl ?? profile.profilePhotoUrl,
      idDocumentUrl: profile.idDocumentUrl,

      // System-issued login alias + the user's real inbox. The form's
      // "Email address" field should bind to `contactEmail`; `email` is
      // the @securestore.com username and stays read-only.
      email: profile.user.email,
      contactEmail: profile.user.contactEmail,

      phone: profile.user.phoneNumber,
      type: profile.type,
      status: profile.user.status,
      occupation: profile.occupation,
      residentialAddress: profile.user.residentialAddress,

      // Two shapes for two consumers. `focusCommodities` is the {id,name}
      // pair used by the detail view; `focusCommodityIds` is just the ids
      // — what the multi-select on the edit form binds to as initial value.
      focusCommodities: profile.focusCommodities.map((f) => f.commodity),
      focusCommodityIds: profile.focusCommodities.map((f) => f.commodity.id),
      bank: {
        accountName: profile.bankAccountName,
        accountNumber: profile.bankAccountNumber,
        bankName: profile.bankName,
      },
      nextOfKin: {
        fullName: profile.nokFullName,
        address: profile.nokAddress,
        phone: profile.nokPhone,
        email: profile.nokEmail,
        relationship: profile.nokRelationship,
      },
      // ORGANIZATION block. `null` when the client is INDIVIDUAL so the FE
      // can short-circuit cleanly.
      organization:
        profile.mode === 'ORGANIZATION'
          ? {
              rcNumber: profile.rcNumber,
              companyName: profile.companyName,
              companyCategory: profile.companyCategory,
              companyCategoryOther: profile.companyCategoryOther,
              dateOfIncorporation: profile.dateOfIncorporation,
              natureOfBusiness: profile.natureOfBusiness,
              sectorIndustry: profile.sectorIndustry,
              businessAddress: profile.businessAddress,
              tin: profile.tin,
              representative: {
                name: repName,
                designation: profile.representativeDesignation,
                otherNames: profile.otherNames,
                phoneNumber: profile.user.phoneNumber,
                email: profile.user.email,
                residentialAddress: profile.user.residentialAddress,
                mothersMaidenName: profile.mothersMaidenName,
                maritalStatus: profile.maritalStatus,
                nationality: profile.nationality,
                stateOfOrigin: profile.stateOfOrigin,
                idType: profile.idType,
                idNumber: profile.idNumber,
                idIssueDate: profile.idIssueDate,
                idExpiryDate: profile.idExpiryDate,
              },
              directors: profile.directors.map((d) => ({
                id: d.id,
                firstName: d.firstName,
                lastName: d.lastName,
                otherNames: d.otherNames,
                designation: d.designation,
                residentialAddress: d.residentialAddress,
                phoneNumber: d.phoneNumber,
                email: d.email,
                mothersMaidenName: d.mothersMaidenName,
                gender: d.gender,
                dateOfBirth: d.dateOfBirth,
                nationality: d.nationality,
                stateOfOrigin: d.stateOfOrigin,
                maritalStatus: d.maritalStatus,
                bvn: d.bvn,
                nin: d.nin,
                idType: d.idType,
                idNumber: d.idNumber,
                idIssueDate: d.idIssueDate,
                idExpiryDate: d.idExpiryDate,
              })),
              documents: profile.documents.map((doc) => ({
                id: doc.id,
                type: doc.type,
                scope: doc.scope,
                scopeRefId: doc.scopeRefId,
                url: doc.url,
                fileName: doc.fileName,
                fileSize: doc.fileSize,
                mimeType: doc.mimeType,
                createdAt: doc.createdAt,
              })),
            }
          : null,
      receiptStats: { active, liened, cancelled, total },
      // Client's transaction-security posture — drives the WM on-behalf form:
      //   • twoFactorEnabled true  → render the OTP step (WM clicks "Send OTP
      //     to client", client reads it back, WM enters it on submit).
      //   • twoFactorEnabled false → no OTP step, submit goes straight through.
      // `transactionPinSet` is informational only on this view — the WM never
      // enters the client's PIN (the on-behalf flow skips it by design).
      security: {
        twoFactorEnabled: profile.user.twoFactorEnabled,
        transactionPinSet: !!profile.user.transactionPinHash,
      },
      // Flag for the "Action needed" pill on the client-detail header.
      // Fires when the tenant admin has approved one of this client's
      // withdrawal requests and it's awaiting WM dispatch (`/complete`).
      actionNeeded: {
        withdrawalDispatches: withdrawalDispatches,
        total: withdrawalDispatches,
      },
    };
  }

  async getClientReceipts(
    tenantId: string,
    clientUserId: string,
    opts: { group?: string; search?: string; page?: string; limit?: string },
  ) {
    const profile = await this.prisma.clientProfile.findFirst({
      where: { tenantId, userId: clientUserId },
      select: { id: true },
    });
    if (!profile) throw new NotFoundException('Client not found');

    const g = (opts.group ?? '').toUpperCase();
    const group = (['ACTIVE', 'LIENED', 'CANCELLED'] as string[]).includes(g)
      ? (g as ReceiptGroup)
      : undefined;

    const scope = await this.whScope.warehouseIds(tenantId);
    return this.query.listReceipts(tenantId, {
      clientId: clientUserId,
      group,
      search: opts.search,
      warehouseIds: scope ?? undefined,
      page: opts.page ? parseInt(opts.page, 10) : undefined,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    });
  }

  async updateClient(
    tenantId: string,
    clientUserId: string,
    dto: UpdateClientDto,
  ) {
    const profile = await this.prisma.clientProfile.findFirst({
      where: { tenantId, userId: clientUserId },
    });
    if (!profile) throw new NotFoundException('Client not found');

    const userData: any = {};
    if (dto.firstName !== undefined) userData.firstName = dto.firstName;
    if (dto.lastName !== undefined) userData.lastName = dto.lastName;
    if (dto.phoneNumber !== undefined) userData.phoneNumber = dto.phoneNumber;
    if (dto.residentialAddress !== undefined)
      userData.residentialAddress = dto.residentialAddress;
    // Profile photo MUST be mirrored to the User row too. The client's
    // settings page reads `User.profilePhotoUrl` (via /me and /users/me);
    // without this mirror the WM uploads an avatar but the client sees
    // their initials. Empty string normalises to null — same convention
    // as the self-update path in UsersService.updateMe.
    if (dto.profilePhotoUrl !== undefined) {
      userData.profilePhotoUrl =
        dto.profilePhotoUrl === '' ? null : dto.profilePhotoUrl;
    }

    // Peel off fields that don't belong on `clientProfile.update.data`:
    //  - the user-bound fields above
    //  - focusCommodityIds / directors / documents — relation replaces, not scalars
    //  - date-string fields that need parsing to Date before the update
    const {
      firstName,
      lastName,
      phoneNumber,
      residentialAddress,
      focusCommodityIds,
      directors: directorsPatch,
      documents: documentsPatch,
      dateOfIncorporation,
      idIssueDate,
      idExpiryDate,
      ...rest
    } = dto;

    const profileData: any = { ...rest };
    if (dateOfIncorporation !== undefined) {
      profileData.dateOfIncorporation = dateOfIncorporation
        ? new Date(dateOfIncorporation)
        : null;
    }
    if (idIssueDate !== undefined) {
      profileData.idIssueDate = idIssueDate ? new Date(idIssueDate) : null;
    }
    if (idExpiryDate !== undefined) {
      profileData.idExpiryDate = idExpiryDate ? new Date(idExpiryDate) : null;
    }

    // Validate focus ids belong to this tenant (only when caller is changing them).
    const focusIds = focusCommodityIds
      ? Array.from(new Set(focusCommodityIds))
      : undefined;
    if (focusIds && focusIds.length) {
      const found = await this.prisma.commodity.count({
        where: { tenantId, id: { in: focusIds } },
      });
      if (found !== focusIds.length) {
        throw new BadRequestException(
          'One or more focusCommodityIds are invalid for this tenant',
        );
      }
    }

    // Validate director/document cross-references the same way createClient does.
    if (documentsPatch !== undefined) {
      const refs = new Set(
        (directorsPatch ?? []).map((d) => d.ref).filter((r): r is string => !!r),
      );
      for (const doc of documentsPatch) {
        if (doc.scope === 'DIRECTOR') {
          if (!doc.directorRef) {
            throw new BadRequestException(
              'documents with scope=DIRECTOR must include directorRef.',
            );
          }
          if (directorsPatch !== undefined && !refs.has(doc.directorRef)) {
            throw new BadRequestException(
              `documents[].directorRef='${doc.directorRef}' does not match any director.ref in this payload.`,
            );
          }
        }
      }
    }

    // File-URL validation (same rule as createClient — only URLs our
    // storage layer issued are accepted). Runs against whatever the caller
    // is patching: if `documents` is omitted, we don't touch existing rows
    // and there's nothing to validate.
    if (documentsPatch !== undefined) {
      await this.storage.assertOwnedUrls(documentsPatch.map((d) => d.url));
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(userData).length) {
        await tx.user.update({ where: { id: clientUserId }, data: userData });
      }
      await tx.clientProfile.update({
        where: { id: profile.id },
        data: profileData,
      });

      // Replace the focus set when supplied; omit to keep, `[]` to clear.
      if (focusIds !== undefined) {
        await tx.clientFocusCommodity.deleteMany({
          where: { clientProfileId: profile.id },
        });
        if (focusIds.length) {
          await tx.clientFocusCommodity.createMany({
            data: focusIds.map((commodityId) => ({
              tenantId,
              clientProfileId: profile.id,
              commodityId,
            })),
            skipDuplicates: true,
          });
        }
      }

      // Director replace. Same semantics as focusCommodityIds: omit to
      // leave alone, `[]` to clear, populated array to fully replace.
      const refToId = new Map<string, string>();
      if (directorsPatch !== undefined) {
        await tx.clientDirector.deleteMany({
          where: { clientProfileId: profile.id },
        });
        for (const d of directorsPatch) {
          const created = await tx.clientDirector.create({
            data: {
              tenantId,
              clientProfileId: profile.id,
              firstName: d.firstName,
              lastName: d.lastName,
              otherNames: d.otherNames,
              designation: d.designation,
              residentialAddress: d.residentialAddress,
              phoneNumber: d.phoneNumber,
              email: d.email,
              mothersMaidenName: d.mothersMaidenName,
              gender: d.gender,
              dateOfBirth: d.dateOfBirth ? new Date(d.dateOfBirth) : null,
              nationality: d.nationality,
              stateOfOrigin: d.stateOfOrigin,
              maritalStatus: d.maritalStatus,
              bvn: d.bvn,
              nin: d.nin,
              idType: d.idType,
              idNumber: d.idNumber,
              idIssueDate: d.idIssueDate ? new Date(d.idIssueDate) : null,
              idExpiryDate: d.idExpiryDate ? new Date(d.idExpiryDate) : null,
            },
          });
          if (d.ref) refToId.set(d.ref, created.id);
        }
      }

      // Document replace. Same semantics — DIRECTOR-scoped docs resolve
      // scopeRefId from the ref→id map built above. If the caller is
      // patching documents WITHOUT also patching directors, DIRECTOR-scoped
      // docs must already use real existing director ids (we don't try to
      // guess across calls).
      if (documentsPatch !== undefined) {
        await tx.clientDocument.deleteMany({
          where: { clientProfileId: profile.id },
        });
        if (documentsPatch.length) {
          await tx.clientDocument.createMany({
            data: documentsPatch.map((doc) => ({
              tenantId,
              clientProfileId: profile.id,
              type: doc.type,
              scope: doc.scope,
              scopeRefId:
                doc.scope === 'DIRECTOR' && doc.directorRef
                  ? (refToId.get(doc.directorRef) ?? doc.directorRef)
                  : null,
              url: doc.url,
              fileName: doc.fileName,
              fileSize: doc.fileSize,
              mimeType: doc.mimeType,
            })),
          });
        }
      }
    });

    return this.getClient(tenantId, clientUserId);
  }

  // ── on-behalf actions (WM acting for a specific client) ──────────────────

  private async assertClientInScope(tenantId: string, clientUserId: string) {
    const scope = await this.whScope.warehouseIds(tenantId);
    const profile = await this.prisma.clientProfile.findFirst({
      where: {
        tenantId,
        userId: clientUserId,
        ...(scope
          ? { user: { receipts: { some: { warehouseId: { in: scope } } } } }
          : {}),
      },
      select: { id: true },
    });
    if (!profile) {
      throw new ForbiddenException(
        'Client not in your warehouse scope or not found',
      );
    }
  }

  private async assertReceiptInScope(tenantId: string, receiptId: string) {
    const scope = await this.whScope.warehouseIds(tenantId);
    const r = await this.prisma.receipt.findFirst({
      where: {
        id: receiptId,
        tenantId,
        ...(scope ? { warehouseId: { in: scope } } : {}),
      },
      select: { id: true },
    });
    if (!r) {
      throw new ForbiddenException(
        'Receipt not in your warehouse scope or not found',
      );
    }
  }

  async listFinanciers(tenantId: string) {
    return this.loans.getFinanciers(tenantId);
  }

  async getClientEligibleReceipts(tenantId: string, clientUserId: string) {
    await this.assertClientInScope(tenantId, clientUserId);
    const scope = await this.whScope.warehouseIds(tenantId);
    return this.withdrawals.getEligibleReceipts(
      tenantId,
      clientUserId,
      scope ?? undefined,
    );
  }

  async getClientPledgeableReceipts(
    tenantId: string,
    clientUserId: string,
    commodity?: string,
  ) {
    await this.assertClientInScope(tenantId, clientUserId);
    const scope = await this.whScope.warehouseIds(tenantId);
    return this.loans.getPledgeableReceipts(
      tenantId,
      clientUserId,
      commodity,
      scope ?? undefined,
    );
  }

  /**
   * Issue a 2FA OTP for an on-behalf transaction. The OTP is sent to the
   * CLIENT's registered channel — the WM then asks the client to read the
   * code back so they can complete the create-on-behalf submission.
   *
   * Two scope checks:
   *  1. The target client must be in the WM's scope (same warehouse roster).
   *  2. SecurityService.requestTransactionOtp returns a generic success
   *     either way, so the WM can't probe to learn whether a given client
   *     has 2FA on.
   */
  async requestClientTransactionOtp(
    tenantId: string,
    managerUserId: string,
    clientUserId: string,
    purpose: TransactionOtpPurpose,
  ) {
    await this.assertClientInScope(tenantId, clientUserId);
    return this.security.requestTransactionOtp({
      userId: clientUserId,
      purpose,
      requestedByUserId: managerUserId,
    });
  }

  async createWithdrawalOnBehalf(
    tenantId: string,
    clientUserId: string,
    managerUserId: string,
    dto: CreateWithdrawalDto,
  ) {
    await this.assertClientInScope(tenantId, clientUserId);
    await this.assertReceiptInScope(tenantId, dto.receiptId);
    return this.withdrawals.createWithdrawalRequest(
      tenantId,
      dto,
      clientUserId,
      managerUserId,
      { isOnBehalf: true },
    );
  }

  async createLoanOnBehalf(
    tenantId: string,
    clientUserId: string,
    managerUserId: string,
    dto: CreateLoanDto,
  ) {
    await this.assertClientInScope(tenantId, clientUserId);
    await this.assertReceiptInScope(tenantId, dto.receiptId);
    return this.loans.createLoan(
      tenantId,
      dto,
      clientUserId,
      managerUserId,
      { isOnBehalf: true },
    );
  }

  async createTradeOnBehalf(
    tenantId: string,
    clientUserId: string,
    managerUserId: string,
    dto: { receiptId: string; pricePerUnit?: number; pin?: string; otp?: string },
  ) {
    await this.assertClientInScope(tenantId, clientUserId);
    await this.assertReceiptInScope(tenantId, dto.receiptId);
    return this.trades.createTrade(
      tenantId,
      dto,
      clientUserId,
      managerUserId,
      { isOnBehalf: true },
    );
  }

  /**
   * Dispatch (= complete) an admin-approved withdrawal. The receipt must be
   * in the manager's warehouse scope. Fees are recomputed at dispatch time
   * inside WithdrawalsService.completeWithdrawal.
   */
  async dispatchWithdrawal(
    tenantId: string,
    managerUserId: string,
    withdrawalId: string,
  ) {
    const w = await this.prisma.withdrawal.findFirst({
      where: { id: withdrawalId, tenantId },
      select: { receiptId: true },
    });
    if (!w) throw new NotFoundException('Withdrawal not found');
    await this.assertReceiptInScope(tenantId, w.receiptId);
    return this.withdrawals.completeWithdrawal(
      tenantId,
      withdrawalId,
      managerUserId,
    );
  }

  // ── grading parameters (drives the dynamic deposit form) ──────────────────

  async getCommodityGradingParameters(tenantId: string, commodityId: string) {
    const commodity = await this.prisma.commodity.findFirst({
      where: { id: commodityId, tenantId },
      include: { gradingParameters: { orderBy: { name: 'asc' } } },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');

    return {
      commodityId: commodity.id,
      commodity: commodity.name,
      unitOfMeasure: commodity.unitOfMeasure,
      gradingLogic: commodity.gradingLogic,
      numberOfGrades: commodity.numberOfGrades,
      parameters: commodity.gradingParameters.map((p) => ({
        id: p.id,
        name: p.name,
        unit: p.unit,
        isDefective: p.isDefective,
        thresholds: p.thresholds,
      })),
    };
  }

  // ── deposit ───────────────────────────────────────────────────────────────

  /**
   * Stateless preview of the grade for a set of measurements. Mirrors the
   * exact validation and scoring `createDeposit` performs, minus the write,
   * so the WM's review-and-submit screen can show what grade the submit
   * will produce. Two outcomes worth handling on the FE:
   *   • computedGrade === 'REJECTED'  → submit will 400 with `failingParameters`
   *   • computedGrade === 'Grade N'   → submit will accept (barring unrelated errors)
   */
  async previewGrading(tenantId: string, dto: PreviewGradingDto) {
    const commodity = await this.prisma.commodity.findFirst({
      where: { id: dto.commodityId, tenantId },
      include: { gradingParameters: true },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');
    if (!commodity.gradingParameters.length) {
      throw new BadRequestException(
        'This commodity has no grading parameters configured — cannot grade',
      );
    }

    // Measurements arrive keyed by parameter id (matches CreateDepositDto).
    // Translate to name-keyed because the scorer is name-keyed.
    const paramById = new Map(
      commodity.gradingParameters.map((p) => [p.id, p]),
    );
    const unknownIds = Object.keys(dto.measurements).filter(
      (id) => !paramById.has(id),
    );
    if (unknownIds.length) {
      throw new BadRequestException(
        `Unknown grading parameter id(s): ${unknownIds.join(', ')}`,
      );
    }
    const measurementsByName: Record<string, number> = {};
    for (const [id, value] of Object.entries(dto.measurements)) {
      measurementsByName[paramById.get(id)!.name] = value;
    }

    let scored;
    try {
      scored = scoreSample({
        parameters: commodity.gradingParameters.map((p) => ({
          name: p.name,
          unit: p.unit,
          isDefective: p.isDefective,
          thresholds: p.thresholds as Record<string, number>,
        })),
        measurements: measurementsByName,
        numberOfGrades: commodity.numberOfGrades,
      });
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }

    return {
      commodityId: commodity.id,
      commodity: commodity.name,
      numberOfGrades: commodity.numberOfGrades,
      computedGrade: scored.computedGrade,
      acceptable: scored.computedGrade !== 'REJECTED',
      totalDefectivePct: scored.totalDefectivePct,
      standardDeductionPct: scored.standardDeductionPct,
      perParameter: scored.perParameter,
      ...(scored.failingParameters?.length
        ? { failingParameters: scored.failingParameters }
        : {}),
    };
  }

  async createDeposit(
    tenantId: string,
    managerUserId: string,
    actorRoles: string[],
    dto: CreateDepositDto,
  ) {
    await this.assertWarehouseScope(
      tenantId,
      managerUserId,
      dto.warehouseId,
      actorRoles,
    );

    const client = await this.prisma.user.findFirst({
      where: {
        id: dto.clientId,
        tenantId,
        roles: { some: { role: { name: 'CLIENT' } } },
      },
    });
    if (!client) throw new NotFoundException('Client not found');

    const wc = await this.prisma.warehouseCommodity.findUnique({
      where: {
        warehouseId_commodityId: {
          warehouseId: dto.warehouseId,
          commodityId: dto.commodityId,
        },
      },
    });
    if (!wc) {
      throw new BadRequestException(
        'This commodity is not accepted at the selected warehouse',
      );
    }

    const commodity = await this.prisma.commodity.findFirst({
      where: { id: dto.commodityId, tenantId },
      include: { gradingParameters: true },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');
    if (!commodity.gradingParameters.length) {
      throw new BadRequestException(
        'This commodity has no grading parameters configured — cannot deposit',
      );
    }

    // measurements come keyed by grading-parameter id → resolve to names
    // (the scorer is name-keyed; names are unique per commodity).
    const paramById = new Map(
      commodity.gradingParameters.map((p) => [p.id, p]),
    );
    const unknownIds = Object.keys(dto.measurements).filter(
      (id) => !paramById.has(id),
    );
    if (unknownIds.length) {
      throw new BadRequestException(
        `Unknown grading parameter id(s): ${unknownIds.join(', ')}`,
      );
    }
    const measurementsByName: Record<string, number> = {};
    for (const [id, value] of Object.entries(dto.measurements)) {
      measurementsByName[paramById.get(id)!.name] = value;
    }

    let scored;
    try {
      scored = scoreSample({
        parameters: commodity.gradingParameters.map((p) => ({
          name: p.name,
          unit: p.unit,
          isDefective: p.isDefective,
          thresholds: p.thresholds as Record<string, number>,
        })),
        measurements: measurementsByName,
        numberOfGrades: commodity.numberOfGrades,
      });
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
    if (scored.computedGrade === 'REJECTED') {
      throw new BadRequestException(
        `Commodity fails grading and cannot be deposited. Failing: ${(scored.failingParameters ?? []).join(', ')}`,
      );
    }

    const receipt = await this.ledger.deposit({
      tenantId,
      clientId: dto.clientId,
      commodityId: dto.commodityId,
      warehouseId: dto.warehouseId,
      quantity: dto.quantity,
      grade: dto.grade ?? scored.computedGrade,
      dateOfDeposit: dto.dateOfDeposit ? new Date(dto.dateOfDeposit) : new Date(),
      actorUserId: managerUserId,
      idempotencyKey: `MANAGER_DEPOSIT:${randomUUID()}`,
      gradingScores: {
        measurementsById: dto.measurements,
        computedGrade: scored.computedGrade,
        totalDefectivePct: scored.totalDefectivePct,
        standardDeductionPct: scored.standardDeductionPct,
        perParameter: scored.perParameter,
      },
    });

    // ── Notifications ──────────────────────────────────────────────────────
    // Tenant admins get the approval queue ping; the client gets a
    // "deposit recorded, awaiting approval" so they aren't in the dark.
    void this.notifications.notifyTenantAdmins(tenantId, {
      type: 'DEPOSIT_PENDING_APPROVAL',
      title: 'New deposit pending approval',
      body: `${client.firstName} ${client.lastName} — ${receipt.receiptNumber} (${Number(receipt.quantity)} ${commodity.unitOfMeasure} of ${commodity.name}, Grade: ${scored.computedGrade})`,
      relatedEntityType: 'receipt',
      relatedEntityId: receipt.id,
      data: {
        receiptNumber: receipt.receiptNumber,
        commodity: commodity.name,
        quantity: Number(receipt.quantity),
        unit: commodity.unitOfMeasure,
        computedGrade: scored.computedGrade,
        warehouseId: dto.warehouseId,
      },
    });
    void this.notifications.notifyUser(dto.clientId, {
      tenantId,
      type: 'DEPOSIT_PENDING_APPROVAL',
      title: 'Deposit recorded — awaiting admin approval',
      body: `${receipt.receiptNumber}: ${Number(receipt.quantity)} ${commodity.unitOfMeasure} of ${commodity.name} (Grade: ${scored.computedGrade}). Pending approval.`,
      relatedEntityType: 'receipt',
      relatedEntityId: receipt.id,
    });

    return {
      receiptId: receipt.id,
      receiptNumber: receipt.receiptNumber,
      status: receipt.status,
      approvalStatus: receipt.approvalStatus,
      computedGrade: scored.computedGrade,
      quantity: Number(receipt.quantity),
      message:
        'Deposit created and is PENDING_APPROVAL by a Tenant Admin.',
    };
  }

  /**
   * WM-side deposit edit. The WM can only modify a deposit while it's still
   * PENDING_APPROVAL — once the tenant admin has approved it, the receipt
   * is "live" and any further data correction is the TA's responsibility
   * (via the admin-side edit endpoint). All deposit fields are editable in
   * this state: quantity, commodity, warehouse, grade, date, measurements.
   *
   * Re-scoring: if `measurements` is supplied and `grade` is NOT, we re-run
   * the commodity's grader against the new measurements and stamp the
   * computed grade. If both are supplied, `grade` wins and we record it
   * as a manual override in the audit log.
   */
  async editDeposit(
    tenantId: string,
    managerUserId: string,
    actorRoles: string[],
    receiptId: string,
    dto: EditDepositDto,
  ) {
    const receipt = await this.loadDepositForEdit(tenantId, receiptId);
    if (!receipt) throw new NotFoundException('Deposit not found');

    if (receipt.status !== 'PENDING_APPROVAL') {
      throw new ConflictException(
        `This deposit is already ${receipt.status} — only a tenant admin can edit it now.`,
      );
    }

    // Scope check: the WM must be assigned to the receipt's CURRENT warehouse.
    // (If they're moving it to a new warehouse, the destination is validated
    // separately below; the WM must have scope at both ends.)
    await this.assertWarehouseScope(
      tenantId,
      managerUserId,
      receipt.warehouseId,
      actorRoles,
    );
    if (dto.warehouseId && dto.warehouseId !== receipt.warehouseId) {
      await this.assertWarehouseScope(
        tenantId,
        managerUserId,
        dto.warehouseId,
        actorRoles,
      );
    }

    return this.applyDepositEdit({
      tenantId,
      receipt,
      dto,
      actorUserId: managerUserId,
      actorKind: 'WM',
    });
  }

  /**
   * Shared edit implementation used by both the WM and TA endpoints. Handles
   * destination-commodity validation, optional re-scoring, the actual
   * Receipt update, an ActivityLog row capturing what changed (before/after
   * + reason + actor), and the post-edit notifications.
   *
   * State + field restrictions are pre-enforced by the caller; this method
   * trusts the inputs. Public so AdminReceiptService can invoke it after
   * its own TA-side permission checks.
   */
  async applyDepositEdit(args: {
    tenantId: string;
    // Non-null receipt — callers MUST check loadDepositForEdit's null return
    // and 404 themselves before invoking this helper.
    receipt: EditableDepositReceipt;
    dto: EditDepositDto;
    actorUserId: string;
    actorKind: 'WM' | 'TA';
  }) {
    const { tenantId, receipt, dto, actorUserId, actorKind } = args;
    const isPending = receipt.status === 'PENDING_APPROVAL';

    // Resolve the destination commodity. If commodityId is changing, look
    // up the new commodity (need its grading params for re-score + unit/bag
    // weight for downstream fee math). Otherwise reuse the loaded one.
    let destCommodity = receipt.commodity;
    if (dto.commodityId && dto.commodityId !== receipt.commodityId) {
      const c = await this.prisma.commodity.findFirst({
        where: { id: dto.commodityId, tenantId },
        include: { gradingParameters: true },
      });
      if (!c) throw new BadRequestException('commodityId is not valid for this tenant.');
      destCommodity = c;
    }

    // If the warehouse is changing (PENDING only), make sure the destination
    // accepts the commodity. Same precondition as createDeposit.
    if (dto.warehouseId && dto.warehouseId !== receipt.warehouseId) {
      const wc = await this.prisma.warehouseCommodity.findUnique({
        where: {
          warehouseId_commodityId: {
            warehouseId: dto.warehouseId,
            commodityId: destCommodity.id,
          },
        },
      });
      if (!wc) {
        throw new BadRequestException(
          'The destination warehouse does not accept this commodity.',
        );
      }
    }

    // Re-score on measurement change unless the caller is explicitly
    // overriding the grade. Existing gradingScores are kept verbatim when
    // measurements aren't being touched, so an unchanged edit doesn't
    // re-stamp old data.
    let nextGrade = dto.grade ?? receipt.grade;
    let nextScores: any = receipt.gradingScores;
    let nextComputedGrade: string | null = receipt.computedGrade;
    let nextTotalDefectivePct = receipt.totalDefectivePct;
    let nextStandardDeductionPct = receipt.standardDeductionPct;
    let gradeOverridden = !!dto.grade;

    if (dto.measurements) {
      if (!destCommodity.gradingParameters.length) {
        throw new BadRequestException(
          'Destination commodity has no grading parameters — cannot re-score.',
        );
      }
      const params = destCommodity.gradingParameters;
      const nameById = new Map<string, string>();
      for (const p of params) nameById.set(p.id, p.name);
      const unknownIds = Object.keys(dto.measurements).filter(
        (id) => !nameById.has(id),
      );
      if (unknownIds.length) {
        throw new BadRequestException(
          `Unknown grading parameter id(s): ${unknownIds.join(', ')}`,
        );
      }
      const measurementsByName: Record<string, number> = {};
      for (const [id, value] of Object.entries(dto.measurements)) {
        measurementsByName[nameById.get(id)!] = value;
      }
      let scored;
      try {
        scored = scoreSample({
          parameters: destCommodity.gradingParameters.map((p) => ({
            name: p.name,
            unit: p.unit,
            isDefective: p.isDefective,
            thresholds: p.thresholds as Record<string, number>,
          })),
          measurements: measurementsByName,
          numberOfGrades: destCommodity.numberOfGrades,
        });
      } catch (e: any) {
        throw new BadRequestException(e.message);
      }
      if (scored.computedGrade === 'REJECTED') {
        throw new BadRequestException(
          `Edited measurements fail grading. Failing: ${(scored.failingParameters ?? []).join(', ')}`,
        );
      }
      nextScores = {
        measurementsById: dto.measurements,
        computedGrade: scored.computedGrade,
        totalDefectivePct: scored.totalDefectivePct,
        standardDeductionPct: scored.standardDeductionPct,
        perParameter: scored.perParameter,
      };
      nextComputedGrade = scored.computedGrade;
      nextTotalDefectivePct = scored.totalDefectivePct;
      nextStandardDeductionPct = scored.standardDeductionPct;
      // Only auto-stamp the grade when the caller didn't manually override.
      if (!dto.grade) nextGrade = scored.computedGrade;
    }

    // Build the actual update payload — diff-driven so we only touch fields
    // the caller is changing. Capture before/after for the audit log.
    const beforeAfter: Record<string, { from: unknown; to: unknown }> = {};
    const updateData: any = {};

    const setIfChanged = <K extends keyof typeof receipt>(
      key: K,
      next: unknown,
      transform: (v: unknown) => unknown = (v) => v,
    ) => {
      const current = receipt[key];
      const incoming = transform(next);
      if (incoming === undefined) return;
      if (
        (current instanceof Date
          ? current.toISOString()
          : current) !==
        (incoming instanceof Date ? incoming.toISOString() : incoming)
      ) {
        beforeAfter[key as string] = { from: current as unknown, to: incoming };
        updateData[key as string] = incoming;
      }
    };

    setIfChanged('quantity', dto.quantity);
    setIfChanged('commodityId', dto.commodityId);
    setIfChanged('warehouseId', dto.warehouseId);
    setIfChanged('grade', nextGrade);
    setIfChanged('dateOfDeposit', dto.dateOfDeposit, (v) =>
      v ? new Date(v as string) : undefined,
    );
    // gradingScores / computedGrade / def pcts only change when we re-scored.
    if (dto.measurements) {
      setIfChanged('gradingScores', nextScores);
      setIfChanged('computedGrade', nextComputedGrade);
      setIfChanged('totalDefectivePct', nextTotalDefectivePct);
      setIfChanged('standardDeductionPct', nextStandardDeductionPct);
    }

    if (!Object.keys(updateData).length) {
      // Nothing actually changed — return early without an audit row so
      // we don't pollute the log with no-op edits.
      return {
        receiptId: receipt.id,
        receiptNumber: receipt.receiptNumber,
        status: receipt.status,
        message: 'No changes to apply.',
      };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.receipt.update({
        where: { id: receipt.id },
        data: updateData,
      });
      await tx.activityLog.create({
        data: {
          tenantId,
          userId: actorUserId,
          action: 'RECEIPT_DEPOSIT_EDITED',
          entityType: 'Receipt',
          entityId: receipt.id,
          metadata: {
            actorKind,
            stateAtEdit: receipt.status,
            changes: beforeAfter,
            gradeOverridden,
            editReason: dto.editReason ?? null,
          } as any,
        },
      });
      return u;
    });

    // ── Notifications (best-effort, never blocks the response) ─────────────
    if (isPending) {
      // PENDING edit: keep the tenant admins informed — the data they're
      // about to approve has just changed.
      void this.notifications.notifyTenantAdmins(tenantId, {
        type: 'DEPOSIT_PENDING_APPROVAL',
        title: 'Pending deposit updated',
        body: `${updated.receiptNumber}: deposit details edited prior to approval.`,
        relatedEntityType: 'receipt',
        relatedEntityId: receipt.id,
        data: { changedFields: Object.keys(beforeAfter) },
      });
    } else {
      // ACTIVE edit (TA path): the client and the filing WM need to know.
      void this.notifications.notifyUser(receipt.clientId, {
        tenantId,
        type: 'DEPOSIT_APPROVED',
        title: 'Your approved deposit was edited',
        body: `${updated.receiptNumber}: a tenant admin updated this receipt's details. View the receipt to see the changes.`,
        relatedEntityType: 'receipt',
        relatedEntityId: receipt.id,
        data: { changedFields: Object.keys(beforeAfter) },
      });
      const filingWm = await this.prisma.inventoryEvent.findFirst({
        where: { fromReceiptId: receipt.id, eventType: 'DEPOSIT' },
        select: { actorUserId: true },
      });
      if (filingWm?.actorUserId && filingWm.actorUserId !== actorUserId) {
        void this.notifications.notifyUser(filingWm.actorUserId, {
          tenantId,
          type: 'DEPOSIT_APPROVED',
          title: 'A deposit you filed was edited',
          body: `${updated.receiptNumber}: a tenant admin corrected details on this receipt.`,
          relatedEntityType: 'receipt',
          relatedEntityId: receipt.id,
          data: { changedFields: Object.keys(beforeAfter) },
        });
      }
    }

    return {
      receiptId: updated.id,
      receiptNumber: updated.receiptNumber,
      status: updated.status,
      approvalStatus: updated.approvalStatus,
      changedFields: Object.keys(beforeAfter),
      message: 'Deposit updated.',
    };
  }

  /**
   * Loader used by both WM (editDeposit above) and TA (admin-receipt
   * service's editDepositAsAdmin) so the receipt's type is exactly what
   * `applyDepositEdit` expects (the commodity + its grading parameters).
   * Public for cross-module reuse.
   */
  async loadDepositForEdit(tenantId: string, receiptId: string) {
    return this.prisma.receipt.findFirst({
      where: { id: receiptId, tenantId },
      include: { commodity: { include: { gradingParameters: true } } },
    });
  }
}
