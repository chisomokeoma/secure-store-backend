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
import { ReceiptStatus, TxnType, WithdrawalStatus } from '@prisma/client';
import { scoreSample } from '../grading/grading.scorer';
import { WarehouseScopeService } from './warehouse-scope.service';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { LoansService } from '../loans/loans.service';
import { TradesService } from '../trades/trades.service';
import { StorageFeesService } from '../storage-fees/storage-fees.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateWithdrawalDto } from '../withdrawals/dto/withdrawals.dto';
import { CreateLoanDto } from '../loans/dto/loans.dto';
import {
  CreateClientDto,
  UpdateClientDto,
  CreateDepositDto,
  PreviewGradingDto,
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

    // Login email is ALWAYS @securestore.com (system-issued identity); any
    // email the form provided is kept only as the contact email.
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
      return tx.clientProfile.create({
        data: {
          userId: user.id,
          tenantId,
          clientCode,
          type: dto.type ?? 'FARMER',
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
    });

    // ── Notifications (best-effort; never blocks the response) ─────────────
    // 1) The new client: their credentials have been issued (the FE shows the
    //    temp password once on screen, but the bell carries the welcome record).
    // 2) Tenant admins: a new client has been registered on the platform.
    const clientName = `${dto.firstName} ${dto.lastName}`;
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
      name: clientName,
      type: profile.type,
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
        select: { createdAt: true, quantity: true },
      }),
      this.prisma.withdrawal.findMany({
        where: { tenantId, createdAt: { gte: sixMo }, ...whT },
        select: { createdAt: true, quantity: true },
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
    const moveMap = new Map<
      string,
      { month: string; deposits: number; withdrawals: number }
    >();
    const bucket = (d: Date) => {
      const k = ym(d);
      if (!moveMap.has(k))
        moveMap.set(k, { month: k, deposits: 0, withdrawals: 0 });
      return moveMap.get(k)!;
    };
    for (const r of depMoves) bucket(r.createdAt).deposits += Number(r.quantity);
    for (const w of wdrMoves) bucket(w.createdAt).withdrawals += w.quantity;

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
      commodityMovement: [...moveMap.values()].sort((a, b) =>
        a.month.localeCompare(b.month),
      ),
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
            email: true,
            phoneNumber: true,
            status: true,
            residentialAddress: true,
          },
        },
        focusCommodities: {
          include: { commodity: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
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

    return {
      clientId: profile.userId,
      clientCode: profile.clientCode,
      name: `${profile.user.firstName} ${profile.user.lastName}`,
      email: profile.user.email,
      phone: profile.user.phoneNumber,
      type: profile.type,
      status: profile.user.status,
      occupation: profile.occupation,
      residentialAddress: profile.user.residentialAddress,
      focusCommodities: profile.focusCommodities.map((f) => f.commodity),
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
      receiptStats: { active, liened, cancelled, total },
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

    // Peel off fields that don't belong on `clientProfile.update.data`:
    //  - the user-bound fields above
    //  - focusCommodityIds, which is a relation replace, not a scalar
    const {
      firstName,
      lastName,
      phoneNumber,
      residentialAddress,
      focusCommodityIds,
      ...profileData
    } = dto;

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

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(userData).length) {
        await tx.user.update({ where: { id: clientUserId }, data: userData });
      }
      await tx.clientProfile.update({
        where: { id: profile.id },
        data: profileData,
      });
      // Replace the focus set when (and only when) it was supplied. Omitting
      // the field leaves existing focus rows untouched; passing `[]` clears.
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
    return this.loans.createLoan(tenantId, dto, clientUserId, managerUserId);
  }

  async createTradeOnBehalf(
    tenantId: string,
    clientUserId: string,
    managerUserId: string,
    dto: { receiptId: string; pricePerUnit?: number },
  ) {
    await this.assertClientInScope(tenantId, clientUserId);
    await this.assertReceiptInScope(tenantId, dto.receiptId);
    return this.trades.createTrade(tenantId, dto, clientUserId, managerUserId);
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
}
