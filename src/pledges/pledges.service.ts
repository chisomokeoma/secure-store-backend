import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, PledgeStatus, ReceiptStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SecurityService } from '../security/security.service';
import { CommodityPricesService } from '../commodity-prices/commodity-prices.service';
import { DEFAULT_PLEDGE_TTL_DAYS } from '../financier/financier-self.service';
import {
  AcceptPledgeDto,
  CreatePledgeDto,
  RejectPledgeDto,
} from './dto/pledges.dto';

/**
 * Core pledge lifecycle service — shared between client-facing
 * (/me/pledges/*) and financier-facing (/financier/pledges/*) surfaces.
 *
 * Volume accounting reuses the existing InventoryLedgerService (same
 * UTXO-style hold/release the withdrawals + loans modules use). New:
 * `transitionPledgeToLien` when the financier accepts, which flips a
 * HELD_PLEDGE_PENDING leaf to HELD_LIEN in place (no split).
 *
 * Invariants enforced here (§1.2 of the spec):
 *   1. Pledge can only be created against a receipt the caller owns.
 *   2. Pledge target financier must have an ACTIVE WarehouseLink to
 *      the receipt's warehouse (and must not be SUSPENDED).
 *   3. Quantity must be <= receipt's currently-available quantity.
 *   4. Only the financier that owns the pledge (via financierOrgId)
 *      can accept / reject.
 *   5. Race safety: hold() uses row-level lock inside a serializable
 *      transaction, so two concurrent pledges for the same volume
 *      never both succeed.
 */
@Injectable()
export class PledgesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly notifications: NotificationsService,
    private readonly security: SecurityService,
    private readonly commodityPrices: CommodityPricesService,
  ) {}

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * The active FinancierOrg for a financier-role user. Throws 403 if the
   * caller isn't a financier or if their org is SUSPENDED. Returns just
   * the ids we need downstream.
   */
  private async requireFinancierOrg(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        tenantId: true,
        financierOrg: {
          select: { id: true, name: true, status: true },
        },
      },
    });
    if (!user?.financierOrg) {
      throw new ForbiddenException(
        'This account is not associated with a FinancierOrg',
      );
    }
    if (user.financierOrg.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: 'FINANCIER_ORG_SUSPENDED',
        message:
          'Your organisation is currently suspended. Please contact the tenant administrator.',
      });
    }
    return { financierOrg: user.financierOrg, tenantId: user.tenantId };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ENCUMBRANCE — the FE's single most important query
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Given a root receipt, decompose the total quantity into:
  //   available       — sum of ACTIVE children (or the leaf itself if unsplit)
  //   pledgePending   — sum of HELD_PLEDGE_PENDING children
  //   liened          — sum of HELD_LIEN children
  //   releasePending  — subset of liened currently covered by PENDING
  //                     ReleaseRequestLines (informational only)
  //
  // Invariant: available + pledgePending + liened == totalQuantity.
  // releasePending is NOT additive — it's a subset of liened.
  //
  // We compute from the receipt tree + pending PLEDGE/RELEASE_REQUEST rows
  // rather than materialise. Correctness > slight query cost; the numbers
  // stay honest under any concurrent mutation because the queries run at
  // read-committed isolation.

  async getReceiptEncumbrance(callerUserId: string, receiptId: string) {
    const root = await this.prisma.receipt.findUnique({
      where: { id: receiptId },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        quantity: true,
        commodityId: true,
        receiptNumber: true,
        commodity: { select: { unitOfMeasure: true, name: true } },
      },
    });
    if (!root || root.clientId !== callerUserId) {
      throw new NotFoundException('Receipt not found');
    }

    // All leaves in this receipt's tree (children whose rootReceiptId
    // points here). We include the root itself when it hasn't been split
    // (status = ACTIVE / HELD_* on the root itself).
    const leaves = await this.prisma.receipt.findMany({
      where: {
        tenantId: root.tenantId,
        OR: [{ rootReceiptId: root.id }, { id: root.id }],
        status: {
          in: [
            'ACTIVE',
            'HELD_PLEDGE_PENDING',
            'HELD_LIEN',
            'HELD_WITHDRAWAL',
            'HELD_LOAN',
            'HELD_TRADE',
          ],
        },
      },
      select: { id: true, status: true, quantity: true },
    });

    const zero = new Prisma.Decimal(0);
    let available = zero;
    let pledgePending = zero;
    let liened = zero;
    const heldLienIds = new Set<string>();
    for (const leaf of leaves) {
      const q = leaf.quantity;
      if (leaf.status === 'ACTIVE') available = available.add(q);
      else if (leaf.status === 'HELD_PLEDGE_PENDING')
        pledgePending = pledgePending.add(q);
      else if (leaf.status === 'HELD_LIEN') {
        liened = liened.add(q);
        heldLienIds.add(leaf.id);
      }
      // Other HELD_* statuses (WITHDRAWAL / LOAN / TRADE) count as
      // "encumbered but out of this contract's scope." They subtract
      // from `available` (they can't be pledged) without landing in
      // the pledge/lien buckets. The FE just doesn't display those.
    }

    // releasePending = sum of PENDING ReleaseRequestLine quantities
    // whose lien.receiptId is in heldLienIds. Only relevant when the
    // receipt actually has liens.
    let releasePending = zero;
    if (heldLienIds.size > 0) {
      const lines = await this.prisma.releaseRequestLine.findMany({
        where: {
          receiptId: { in: [...heldLienIds] },
          releaseRequest: { status: 'PENDING' },
        },
        select: { quantity: true },
      });
      for (const l of lines) releasePending = releasePending.add(l.quantity);
    }

    // Pending pledges + active liens for the response body.
    const [pendingPledges, activeLiens] = await Promise.all([
      this.prisma.pledge.findMany({
        where: {
          receiptId: root.id,
          status: 'PENDING',
        },
        select: {
          id: true,
          quantity: true,
          expiresAt: true,
          financierOrg: { select: { id: true, name: true, logoUrl: true } },
        },
      }),
      this.prisma.lien.findMany({
        where: {
          clientId: callerUserId,
          receipt: { rootReceiptId: root.id },
          status: { in: ['ACTIVE', 'PARTIALLY_RELEASED'] },
        },
        select: {
          id: true,
          quantity: true,
          remainingQuantity: true,
          status: true,
          placedAt: true,
          financierOrg: { select: { id: true, name: true, logoUrl: true } },
        },
      }),
    ]);

    return {
      encumbrance: {
        receiptId: root.id,
        totalQuantity: root.quantity.toString(),
        unit: root.commodity.unitOfMeasure,
        available: available.toString(),
        pledgePending: pledgePending.toString(),
        liened: liened.toString(),
        releasePending: releasePending.toString(),
      },
      liens: activeLiens.map((l) => ({
        id: l.id,
        financier: {
          id: l.financierOrg.id,
          name: l.financierOrg.name,
          logoUrl: l.financierOrg.logoUrl,
        },
        quantity: l.remainingQuantity.toString(),
        status: l.status,
        placedAt: l.placedAt,
      })),
      pendingPledges: pendingPledges.map((p) => ({
        id: p.id,
        financierName: p.financierOrg.name,
        quantity: p.quantity.toString(),
        expiresAt: p.expiresAt,
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FINANCIERS-FOR-WAREHOUSE — pledge-target dropdown feed
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * FinancierOrgs with an ACTIVE WarehouseLink to the given warehouse.
   * The FE renders this list in the "pick a financier" step of the
   * pledge flow (§2.2 of the spec).
   */
  async financiersForWarehouse(callerUserId: string, warehouseId: string) {
    const caller = await this.prisma.user.findUnique({
      where: { id: callerUserId },
      select: { tenantId: true },
    });
    if (!caller) throw new NotFoundException('User not found');

    const links = await this.prisma.warehouseLink.findMany({
      where: {
        tenantId: caller.tenantId,
        warehouseId,
        status: 'ACTIVE',
        financierOrg: { status: 'ACTIVE' },
      },
      include: {
        financierOrg: {
          select: { id: true, name: true, logoUrl: true },
        },
      },
      orderBy: { financierOrg: { name: 'asc' } },
    });

    return links.map((l) => ({
      id: l.financierOrg.id,
      name: l.financierOrg.name,
      logoUrl: l.financierOrg.logoUrl,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RECEIPT VALUATION — client-facing read for the pledge wizard
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Serves the FE's "Market price today" + live "Estimated market worth"
  // rows on the Financing drawer and receipt-detail modal (§2.1b of the
  // FE spec). The client uses `pricePerUnit` to compute a live estimate
  // as they type — the BINDING value on the pledge is still
  // `Pledge.valuationAtPledge` stamped at submit-time by createPledge().
  //
  // Receipt-scoped (not commodity-scoped) so downstream grade-adjusted
  // pricing stays a server concern — callers never guess how price is
  // derived, they just get the number the server would use.

  async getReceiptValuation(callerUserId: string, receiptId: string) {
    const receipt = await this.prisma.receipt.findFirst({
      where: { id: receiptId, clientId: callerUserId },
      select: {
        id: true,
        tenantId: true,
        commodityId: true,
        commodity: { select: { unitOfMeasure: true } },
      },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');

    const price = await this.commodityPrices.currentPrice(
      receipt.tenantId,
      receipt.commodityId,
    );
    if (!price) {
      // Distinct code so the FE can silently hide the price row rather
      // than surface a scary error. The FE hook is documented as "no-retry
      // and silent on error" so any 404 here just collapses the row.
      throw new NotFoundException({
        code: 'NO_PRICE_ON_FILE',
        message: 'No reference price is on file for this commodity.',
      });
    }

    return {
      receiptId: receipt.id,
      pricePerUnit: price.pricePerUnit.toString(),
      unit: receipt.commodity.unitOfMeasure,
      currency: price.currency,
      effectiveFrom: price.effectiveAt,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLIENT-FACING — /me/pledges
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create a pledge. Runs three guards, resolves valuation, holds the
   * volume via the ledger, then persists the Pledge row + notifies the
   * financier's users.
   *
   * Guards (in order — cheapest first):
   *   1. Receipt exists and belongs to the caller.
   *   2. Quantity > 0 and <= receipt's currently-available quantity.
   *   3. FinancierOrg is ACTIVE + has an ACTIVE WarehouseLink to the
   *      receipt's warehouse.
   *
   * Volume flow: `ledger.hold` splits the receipt into a HELD_PLEDGE_PENDING
   * child (size = pledged quantity) + an ACTIVE remainder. The pledge row
   * stores both `receiptId` (root, what the client sees) and
   * `heldReceiptId` (the actual leaf being held).
   */
  async createPledge(callerUserId: string, dto: CreatePledgeDto) {
    const caller = await this.prisma.user.findUnique({
      where: { id: callerUserId },
      select: { id: true, tenantId: true },
    });
    if (!caller) throw new NotFoundException('User not found');

    const receipt = await this.prisma.receipt.findFirst({
      where: {
        id: dto.receiptId,
        clientId: callerUserId,
        tenantId: caller.tenantId,
      },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        warehouseId: true,
        commodityId: true,
        commodity: { select: { unitOfMeasure: true, name: true } },
        status: true,
      },
    });
    if (!receipt) {
      throw new NotFoundException({
        code: 'RECEIPT_NOT_PLEDGEABLE',
        message: 'Receipt not found or not owned by you',
      });
    }
    // Root-level status must be SPLIT (children exist and one is ACTIVE)
    // or ACTIVE (never held-out yet). Anything terminal is unpledgeable.
    if (
      receipt.status !== 'ACTIVE' &&
      receipt.status !== 'SPLIT' &&
      receipt.status !== 'PENDING_APPROVAL'
    ) {
      throw new BadRequestException({
        code: 'RECEIPT_NOT_PLEDGEABLE',
        message: `Receipt is in status ${receipt.status} and cannot be pledged`,
      });
    }

    const qty = new Prisma.Decimal(dto.quantity);
    if (qty.lte(0)) {
      throw new BadRequestException({
        code: 'QUANTITY_INVALID',
        message: 'quantity must be greater than zero',
      });
    }

    // Recompute available for THIS receipt at this exact moment. The
    // ledger.hold call below has its own row-lock so the definitive
    // race check happens inside the transaction; this is just a fast
    // client-facing 400 for obvious over-pledges.
    const enc = await this.getReceiptEncumbrance(callerUserId, receipt.id);
    const available = new Prisma.Decimal(enc.encumbrance.available);
    if (qty.gt(available)) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_AVAILABLE_VOLUME',
        message: `Available volume is ${available.toString()} but you're trying to pledge ${qty.toString()}`,
        available: available.toString(),
      });
    }

    const link = await this.prisma.warehouseLink.findFirst({
      where: {
        tenantId: caller.tenantId,
        financierOrgId: dto.financierId,
        warehouseId: receipt.warehouseId,
        status: 'ACTIVE',
      },
      include: {
        financierOrg: {
          select: { id: true, name: true, status: true, pledgeTtlDays: true },
        },
      },
    });
    if (!link || link.financierOrg.status !== 'ACTIVE') {
      throw new BadRequestException({
        code: 'FINANCIER_NOT_ONBOARDED',
        message:
          'This financier is not onboarded to the warehouse holding this receipt.',
      });
    }

    // Valuation lookup (Q2 — automatic per current market data).
    const valuation = await this.commodityPrices.lookupValuation({
      tenantId: caller.tenantId,
      commodityId: receipt.commodityId,
      quantity: qty,
    });

    // TTL computation with per-org override + platform default fallback.
    // Snapshot rule (spec §1.3): expiresAt captured now; later changes
    // to the org's pledgeTtlDays never shift this pledge's expiry.
    const ttlDays = link.financierOrg.pledgeTtlDays ?? DEFAULT_PLEDGE_TTL_DAYS;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    // Reserve a Pledge row id upfront so we can use it as both the
    // ledger transaction id and the DB row id (avoids a second update).
    const pledgeId = randomUUID();

    // Hold the volume — creates a HELD_PLEDGE_PENDING child leaf.
    const holdResult = await this.ledger.hold({
      tenantId: receipt.tenantId,
      sourceReceiptId: receipt.id,
      quantity: qty,
      heldStatus: 'HELD_PLEDGE_PENDING',
      txnType: 'PLEDGE',
      txnId: pledgeId,
      actorUserId: callerUserId,
      idempotencyKey: `pledge:create:${pledgeId}`,
      metadata: { financierOrgId: dto.financierId },
    });

    const pledge = await this.prisma.pledge.create({
      data: {
        id: pledgeId,
        tenantId: caller.tenantId,
        receiptId: receipt.id,
        heldReceiptId: holdResult.held.id,
        clientId: callerUserId,
        financierOrgId: dto.financierId,
        warehouseId: receipt.warehouseId,
        quantity: qty,
        unit: receipt.commodity.unitOfMeasure,
        valuationAtPledge: valuation?.value,
        currency: valuation?.currency ?? 'NGN',
        status: PledgeStatus.PENDING,
        clientNote: dto.note,
        expiresAt,
      },
    });

    // Notify all financier-org users so their inbox refreshes.
    await this.notifyFinancierUsers(link.financierOrg.id, {
      tenantId: caller.tenantId,
      type: 'PLEDGE_CREATED',
      title: `New pledge — ${qty.toString()} ${receipt.commodity.unitOfMeasure} of ${receipt.commodity.name}`,
      body: `Review and decide within ${ttlDays} day${ttlDays === 1 ? '' : 's'}.`,
      relatedEntityType: 'pledge',
      relatedEntityId: pledge.id,
    });

    return this.projectPledgeDetail(pledge.id);
  }

  /**
   * List the caller's pledges. Includes receipt / financier / warehouse
   * summaries embedded so the FE table renders in one call.
   */
  async listMyPledges(
    callerUserId: string,
    query: { status?: string; page?: string; limit?: string },
  ) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    const where: any = { clientId: callerUserId };
    if (query.status) where.status = query.status;

    const [rows, total] = await Promise.all([
      this.prisma.pledge.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: this.pledgeInclude,
      }),
      this.prisma.pledge.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.projectPledge(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** Client cancels their pledge. Only allowed while PENDING. */
  async cancelPledge(callerUserId: string, pledgeId: string) {
    const p = await this.prisma.pledge.findFirst({
      where: { id: pledgeId, clientId: callerUserId },
    });
    if (!p) throw new NotFoundException('Pledge not found');
    if (p.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'PLEDGE_NOT_PENDING',
        message: `Cannot cancel a pledge in status ${p.status}`,
      });
    }

    // Release the held volume back to ACTIVE.
    if (p.heldReceiptId) {
      await this.ledger.release({
        tenantId: p.tenantId,
        heldReceiptId: p.heldReceiptId,
        reason: 'Pledge cancelled by client',
        actorUserId: callerUserId,
        idempotencyKey: `pledge:cancel:${p.id}`,
      });
    }

    await this.prisma.pledge.update({
      where: { id: p.id },
      data: { status: PledgeStatus.CANCELLED },
    });

    // Notify the financier — their inbox count needs to drop.
    await this.notifyFinancierUsers(p.financierOrgId, {
      tenantId: p.tenantId,
      type: 'PLEDGE_REJECTED', // reuse — no CANCELLED enum. Body copy explains.
      title: 'Pledge cancelled',
      body: `The client cancelled pledge ${p.id.slice(0, 8)} before you responded.`,
      relatedEntityType: 'pledge',
      relatedEntityId: p.id,
    });

    return this.projectPledgeDetail(p.id);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FINANCIER-FACING — /financier/pledges
  // ═══════════════════════════════════════════════════════════════════════

  async listFinancierPledges(
    callerUserId: string,
    query: { status?: string; page?: string; limit?: string },
  ) {
    const { financierOrg } = await this.requireFinancierOrg(callerUserId);
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    const where: any = { financierOrgId: financierOrg.id };
    if (query.status) where.status = query.status;

    const [rows, total] = await Promise.all([
      this.prisma.pledge.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        include: this.pledgeInclude,
      }),
      this.prisma.pledge.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.projectPledge(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getFinancierPledgeDetail(callerUserId: string, pledgeId: string) {
    const { financierOrg } = await this.requireFinancierOrg(callerUserId);
    const p = await this.prisma.pledge.findFirst({
      where: { id: pledgeId, financierOrgId: financierOrg.id },
      include: this.pledgeInclude,
    });
    if (!p) throw new NotFoundException('Pledge not found');
    return this.projectPledge(p);
  }

  /**
   * Accept a pledge — the atomic pledge → lien transition.
   *
   * Order of operations:
   *   1. Guard: OTP valid (SecurityService).
   *   2. Guard: pledge is PENDING, ownership matches, not expired.
   *   3. Ledger: transitionPledgeToLien (flips HELD_PLEDGE_PENDING → HELD_LIEN,
   *      records InventoryEvent).
   *   4. DB: create Lien row + update Pledge status ACCEPTED.
   *   5. Notify client.
   *
   * OTP is consumed BEFORE any state change so a wrong OTP doesn't
   * partially transition anything.
   */
  async acceptPledge(
    callerUserId: string,
    pledgeId: string,
    dto: AcceptPledgeDto,
  ) {
    const { financierOrg } = await this.requireFinancierOrg(callerUserId);
    const p = await this.prisma.pledge.findFirst({
      where: { id: pledgeId, financierOrgId: financierOrg.id },
      include: { financierOrg: { select: { name: true } } },
    });
    if (!p) throw new NotFoundException('Pledge not found');
    if (p.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'PLEDGE_NOT_PENDING',
        message: `Cannot accept a pledge in status ${p.status}`,
      });
    }
    if (p.expiresAt < new Date()) {
      throw new BadRequestException({
        code: 'PLEDGE_EXPIRED',
        message: 'This pledge has expired. Ask the client to submit a new one.',
      });
    }
    if (!p.heldReceiptId) {
      // Defensive — should never happen; every pledge creates a held child.
      throw new BadRequestException({
        code: 'PLEDGE_INTERNAL_STATE_ERROR',
        message: 'Pledge is missing its held receipt reference; contact support.',
      });
    }

    // OTP gate — same infra used by withdrawals / loans.
    await this.security.consumeOtp({
      userId: callerUserId,
      code: dto.otp,
      purpose: 'PLEDGE_ACCEPT',
    });

    // Ledger: HELD_PLEDGE_PENDING → HELD_LIEN on the leaf.
    await this.ledger.transitionPledgeToLien({
      tenantId: p.tenantId,
      heldReceiptId: p.heldReceiptId,
      pledgeId: p.id,
      actorUserId: callerUserId,
      idempotencyKey: `pledge:accept:${p.id}`,
      metadata: { note: dto.note ?? null },
    });

    // Create the Lien + flip pledge status in one transaction.
    await this.prisma.$transaction(async (tx) => {
      await tx.lien.create({
        data: {
          tenantId: p.tenantId,
          pledgeId: p.id,
          receiptId: p.heldReceiptId!,
          clientId: p.clientId,
          financierOrgId: p.financierOrgId,
          quantity: p.quantity,
          remainingQuantity: p.quantity,
          status: 'ACTIVE',
        },
      });
      await tx.pledge.update({
        where: { id: p.id },
        data: {
          status: PledgeStatus.ACCEPTED,
          decidedById: callerUserId,
          decidedAt: new Date(),
          decisionReason: dto.note ?? null,
        },
      });
    });

    void this.notifications
      .notifyUser(p.clientId, {
        tenantId: p.tenantId,
        type: 'PLEDGE_ACCEPTED',
        title: `Pledge accepted by ${p.financierOrg.name}`,
        body: `Your pledge of ${p.quantity.toString()} ${p.unit} has been accepted and is now under lien.`,
        relatedEntityType: 'pledge',
        relatedEntityId: p.id,
      })
      .catch(() => undefined);

    return this.getFinancierPledgeDetail(callerUserId, p.id);
  }

  async rejectPledge(
    callerUserId: string,
    pledgeId: string,
    dto: RejectPledgeDto,
  ) {
    const { financierOrg } = await this.requireFinancierOrg(callerUserId);
    const p = await this.prisma.pledge.findFirst({
      where: { id: pledgeId, financierOrgId: financierOrg.id },
      include: { financierOrg: { select: { name: true } } },
    });
    if (!p) throw new NotFoundException('Pledge not found');
    if (p.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'PLEDGE_NOT_PENDING',
        message: `Cannot reject a pledge in status ${p.status}`,
      });
    }

    // Release the held volume back to ACTIVE.
    if (p.heldReceiptId) {
      await this.ledger.release({
        tenantId: p.tenantId,
        heldReceiptId: p.heldReceiptId,
        reason: `Pledge rejected: ${dto.reason}`,
        actorUserId: callerUserId,
        idempotencyKey: `pledge:reject:${p.id}`,
      });
    }

    await this.prisma.pledge.update({
      where: { id: p.id },
      data: {
        status: PledgeStatus.REJECTED,
        decisionReason: dto.reason,
        decidedById: callerUserId,
        decidedAt: new Date(),
      },
    });

    void this.notifications
      .notifyUser(p.clientId, {
        tenantId: p.tenantId,
        type: 'PLEDGE_REJECTED',
        title: `Pledge rejected by ${p.financierOrg.name}`,
        body: `Reason: ${dto.reason}`,
        relatedEntityType: 'pledge',
        relatedEntityId: p.id,
      })
      .catch(() => undefined);

    return this.getFinancierPledgeDetail(callerUserId, p.id);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TTL EXPIRATION — called by the cron
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Expire all PENDING pledges past `expiresAt`. Called by the cron
   * every 10 minutes. Returns the number expired for telemetry.
   *
   * For each expired pledge: release the held volume + set status
   * EXPIRED + notify both parties (best-effort).
   */
  async expireStalePledges(): Promise<{ expired: number }> {
    const stale = await this.prisma.pledge.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { lte: new Date() },
      },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        financierOrgId: true,
        heldReceiptId: true,
        quantity: true,
        unit: true,
      },
    });

    let expired = 0;
    for (const p of stale) {
      try {
        if (p.heldReceiptId) {
          await this.ledger.release({
            tenantId: p.tenantId,
            heldReceiptId: p.heldReceiptId,
            reason: 'Pledge expired (TTL elapsed with no decision)',
            idempotencyKey: `pledge:expire:${p.id}`,
          });
        }
        await this.prisma.pledge.update({
          where: { id: p.id },
          data: { status: PledgeStatus.EXPIRED, decidedAt: new Date() },
        });
        expired++;

        void this.notifications
          .notifyUser(p.clientId, {
            tenantId: p.tenantId,
            type: 'PLEDGE_EXPIRED',
            title: 'Pledge expired',
            body: `Your pledge of ${p.quantity.toString()} ${p.unit} expired without a decision. The volume is available again.`,
            relatedEntityType: 'pledge',
            relatedEntityId: p.id,
          })
          .catch(() => undefined);

        void this.notifyFinancierUsers(p.financierOrgId, {
          tenantId: p.tenantId,
          type: 'PLEDGE_EXPIRED',
          title: 'Pledge expired',
          body: `A pending pledge expired before decision. Client can resubmit.`,
          relatedEntityType: 'pledge',
          relatedEntityId: p.id,
        }).catch(() => undefined);
      } catch {
        // One bad pledge shouldn't block the whole batch. Failures
        // will be picked up on the next cron tick.
      }
    }
    return { expired };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════

  private async notifyFinancierUsers(
    financierOrgId: string,
    payload: Parameters<NotificationsService['notifyUser']>[1],
  ) {
    const users = await this.prisma.user.findMany({
      where: { financierOrgId, status: 'ACTIVE' },
      select: { id: true },
    });
    await Promise.all(
      users.map((u) =>
        this.notifications.notifyUser(u.id, payload).catch(() => undefined),
      ),
    );
  }

  // ─── Projection ────────────────────────────────────────────────────────

  private readonly pledgeInclude = {
    receipt: {
      select: {
        id: true,
        receiptNumber: true,
        commodity: { select: { name: true, unitOfMeasure: true } },
        grade: true,
      },
    },
    client: {
      select: { id: true, firstName: true, lastName: true },
    },
    financierOrg: {
      select: { id: true, name: true, logoUrl: true },
    },
    warehouse: {
      select: { id: true, name: true },
    },
  };

  private async projectPledgeDetail(id: string) {
    const p = await this.prisma.pledge.findUnique({
      where: { id },
      include: this.pledgeInclude,
    });
    if (!p) throw new NotFoundException('Pledge not found');
    return this.projectPledge(p);
  }

  private projectPledge(p: {
    id: string;
    receipt: {
      id: string;
      receiptNumber: string;
      commodity: { name: string; unitOfMeasure: string };
      grade: string | null;
    };
    client: { id: string; firstName: string; lastName: string };
    financierOrg: { id: string; name: string; logoUrl: string | null };
    warehouse: { id: string; name: string };
    quantity: Prisma.Decimal;
    unit: string;
    valuationAtPledge: Prisma.Decimal | null;
    currency: string;
    status: PledgeStatus;
    clientNote: string | null;
    decisionReason: string | null;
    decidedAt: Date | null;
    expiresAt: Date;
    createdAt: Date;
  }) {
    return {
      id: p.id,
      receipt: {
        id: p.receipt.id,
        receiptNumber: p.receipt.receiptNumber,
        commodity: p.receipt.commodity.name,
        grade: p.receipt.grade,
        unit: p.receipt.commodity.unitOfMeasure,
      },
      client: {
        id: p.client.id,
        name: `${p.client.firstName} ${p.client.lastName}`,
      },
      financier: {
        id: p.financierOrg.id,
        name: p.financierOrg.name,
        logoUrl: p.financierOrg.logoUrl,
      },
      warehouse: {
        id: p.warehouse.id,
        name: p.warehouse.name,
      },
      quantity: p.quantity.toString(),
      valuationAtPledge: p.valuationAtPledge?.toString() ?? null,
      currency: p.currency,
      status: p.status,
      clientNote: p.clientNote,
      decisionReason: p.decisionReason,
      decidedAt: p.decidedAt,
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
    };
  }
}
