import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { HELD_STATUSES } from '../inventory/inventory.types';
import { StorageFeesService } from '../storage-fees/storage-fees.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SecurityService } from '../security/security.service';
import {
  CalculateWithdrawalDto,
  CreateWithdrawalDto,
  EditWithdrawalDto,
} from './dto/withdrawals.dto';

const HANDLING_FEE = 10000;

// How long a PENDING_PAYMENT withdrawal "reserves" quantity against its
// source receipt before we treat it as abandoned. Past this, the lazy
// availability calculation in `availableForWithdrawal` ignores the row —
// so an abandoned flow doesn't trap inventory forever, but the next
// person trying to confirm payment against that abandoned row will
// correctly fail at hold time if someone else won the race.
const PENDING_PAYMENT_TTL_MINUTES = 30;

@Injectable()
export class WithdrawalsService {
  constructor(
    private prisma: PrismaService,
    private ledger: InventoryLedgerService,
    private storageFees: StorageFeesService,
    private notifications: NotificationsService,
    private security: SecurityService,
  ) {}

  async getWithdrawals(
    tenantId: string,
    filters: { status?: string; page?: string; limit?: string; search?: string },
    forClientId?: string,
  ) {
    const page = parseInt(filters.page || '1', 10);
    const limit = parseInt(filters.limit || '10', 10);
    const skip = (page - 1) * limit;

    const where: any = { tenantId };
    if (forClientId) where.clientId = forClientId;
    if (filters.status) where.status = filters.status as WithdrawalStatus;
    if (filters.search) {
      where.OR = [
        { reference: { contains: filters.search, mode: 'insensitive' } },
        {
          receipt: {
            receiptNumber: { contains: filters.search, mode: 'insensitive' },
          },
        },
        {
          receipt: {
            commodity: { name: { contains: filters.search, mode: 'insensitive' } },
          },
        },
      ];
    }

    const [withdrawals, total] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where,
        include: { receipt: { include: { commodity: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.withdrawal.count({ where }),
    ]);

    return {
      data: withdrawals.map((w) => ({
        id: w.id,
        reference: w.reference,
        receiptNumber: w.receipt.receiptNumber,
        commodity: w.receipt.commodity.name,
        quantity: w.quantity,
        status: w.status,
        createdAt: w.createdAt,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Only APPROVED, ACTIVE leaves are selectable (the locked rule). */
  async getEligibleReceipts(
    tenantId: string,
    clientId: string,
    warehouseIds?: string[],
    commodityId?: string,
  ) {
    const receipts = await this.prisma.receipt.findMany({
      where: {
        tenantId,
        clientId,
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        isParent: false,
        ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}),
        ...(commodityId ? { commodityId } : {}),
      },
      include: { commodity: true, warehouse: true },
    });

    return receipts.map((r) => ({
      id: r.id,
      receiptNumber: r.receiptNumber,
      commodity: r.commodity.name,
      availableQuantity: Number(r.quantity),
      warehouse: r.warehouse.name,
      unit: r.commodity.unitOfMeasure,
    }));
  }

  /**
   * Hydrates the withdrawal-request form on the client side. SOFT on the
   * policy lookup: if no `StorageFeePolicy` resolves for the receipt's
   * (warehouse, commodity), we return `policy: null` and `storageFeePerUnit: 0`
   * so the form can still render the receipt details and the user can begin
   * filling it in. The hard error is reserved for `/calculate` and the actual
   * `createWithdrawalRequest` submit — that's where missing policy *must*
   * stop the flow.
   *
   * `storageFeePerUnit` is preserved as a top-level field for FE backward
   * compatibility (some screens still read it directly). Going forward
   * consumers should prefer the structured `policy` block — it carries the
   * fee type, billing cadence, grace, late penalty, and scope so the FE can
   * render "₦450 per MT per day · billed daily" without guessing.
   */
  async getReceiptPrefill(
    tenantId: string,
    receiptId: string,
    forClientId?: string,
  ) {
    const r = await this.prisma.receipt.findFirst({
      where: {
        id: receiptId,
        tenantId,
        ...(forClientId ? { clientId: forClientId } : {}),
      },
      include: { warehouse: true, commodity: true },
    });
    if (!r) throw new NotFoundException('Receipt not found');

    // Soft policy resolve — the resolver throws on miss, but we want the
    // prefill to succeed either way so the user sees the receipt details.
    let policy = null as Awaited<
      ReturnType<typeof this.storageFees.resolvePolicy>
    > | null;
    try {
      policy = await this.storageFees.resolvePolicy(
        tenantId,
        r.warehouseId,
        r.commodityId,
      );
    } catch {
      // No active policy found — leave `policy` null and let the FE prompt
      // the admin (or just show a "fee TBD" hint). `/calculate` will hard-fail
      // when the user actually tries to commit.
    }

    return {
      maxQuantity: Number(r.quantity),
      // Legacy field — same shape as before. Now sourced from the resolved
      // policy's `rate`; falls back to 0 when no policy is configured (was
      // a hardcoded `15` previously — a misleading placeholder).
      storageFeePerUnit: policy?.rate ?? 0,
      receiptDetails: {
        receiptNumber: r.receiptNumber,
        commodity: r.commodity.name,
        unit: r.commodity.unitOfMeasure,
        grade: r.grade || 'Standard',
        warehouseLocation: r.warehouse.location,
        dateOfDeposit: r.dateOfDeposit,
        expiryDate: r.expiryDate,
      },
      policy: policy
        ? {
            id: policy.id,
            feeType: policy.feeType,
            rate: policy.rate,
            billingFrequency: policy.billingFrequency,
            gracePeriodDays: policy.gracePeriodDays,
            latePenaltyPct: policy.latePenaltyPct,
            currency: policy.currency,
            scope: policy.warehouseId
              ? policy.commodityId
                ? 'warehouse+commodity'
                : 'warehouse'
              : policy.commodityId
                ? 'commodity'
                : 'tenant-default',
          }
        : null,
    };
  }

  /**
   * Live fee quote for the withdrawal-review screen. Uses the SAME resolver
   * + scorer that `createWithdrawalRequest` and `completeWithdrawal` use, so
   * the number the client sees here is the number they'll be billed at
   * dispatch (modulo extra days of storage accruing in between).
   *
   * If no policy resolves for the (warehouse, commodity) combination via
   * the standard fallback chain (warehouse+commodity → warehouse → commodity
   * → tenant-default), this throws 400 with a clear admin nudge — same
   * error the create endpoint would throw.
   */
  async calculateWithdrawal(tenantId: string, dto: CalculateWithdrawalDto) {
    if (dto.quantity <= 0) {
      throw new BadRequestException('Quantity must be greater than zero');
    }

    const receipt = await this.prisma.receipt.findFirst({
      where: { id: dto.receiptId, tenantId },
      include: {
        commodity: true,
        warehouse: { select: { id: true, name: true, location: true } },
      },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');
    if (dto.quantity > Number(receipt.quantity)) {
      throw new BadRequestException(
        'Requested quantity exceeds available quantity',
      );
    }

    const policy = await this.storageFees.resolvePolicy(
      tenantId,
      receipt.warehouseId,
      receipt.commodityId,
    );
    const now = new Date();
    const storageFee = this.storageFees.calculateFee(
      policy,
      dto.quantity,
      receipt.commodity.unitOfMeasure,
      receipt.dateOfDeposit,
      now,
      receipt.commodity.standardBagWeightKg ?? undefined,
    );
    const totalFee = storageFee + HANDLING_FEE;

    return {
      totalFee,
      breakdown: {
        quantity: dto.quantity,
        unit: receipt.commodity.unitOfMeasure,
        storageFee,
        handlingFee: HANDLING_FEE,
        // Kept for FE backward compat — equals policy.rate. The actual fee
        // depends on policy.feeType (per-day / per-week / etc.) so always
        // render with the policy block below for accurate context.
        feePerUnit: policy.rate,
        policy: {
          id: policy.id,
          feeType: policy.feeType,
          rate: policy.rate,
          billingFrequency: policy.billingFrequency,
          gracePeriodDays: policy.gracePeriodDays,
          latePenaltyPct: policy.latePenaltyPct,
          currency: policy.currency,
          scope: policy.warehouseId
            ? policy.commodityId
              ? 'warehouse+commodity'
              : 'warehouse'
            : policy.commodityId
              ? 'commodity'
              : 'tenant-default',
        },
        period: {
          depositDate: receipt.dateOfDeposit,
          throughDate: now,
        },
      },
    };
  }

  /**
   * Request = HOLD on the selected receipt. The ledger atomically splits it
   * into a HELD_WITHDRAWAL node (this withdrawal's receipt) + an ACTIVE
   * remainder. The Withdrawal row is keyed to a pre-generated id so the hold
   * (idempotent) and the row creation are self-healing on retry.
   */
  async createWithdrawalRequest(
    tenantId: string,
    dto: CreateWithdrawalDto,
    clientId: string,
    actorUserId?: string,
    opts: { isOnBehalf?: boolean } = {},
  ) {
    if (dto.quantity <= 0) {
      throw new BadRequestException('Quantity must be greater than zero');
    }

    // 2FA gate. No-op if the client has 2FA off. When on:
    //  - client-initiated: requires their PIN + a fresh OTP
    //  - WM on-behalf: OTP only (sent to client, who reads it to the WM)
    await this.security.assertTransactionAuth({
      userId: clientId,
      purpose: 'WITHDRAWAL',
      pin: dto.pin,
      otp: dto.otp,
      isOnBehalf: opts.isOnBehalf,
    });

    // Resolve the active storage-fee policy via the fallback chain
    // (warehouse+commodity → warehouse → commodity → tenant default) and
    // compute a PROVISIONAL fee — the dispatch step recomputes against
    // the actual collection date so storage accrual is accounted for.
    const sourceReceipt = await this.prisma.receipt.findFirst({
      where: { id: dto.receiptId, tenantId },
      include: { commodity: true },
    });
    if (!sourceReceipt) throw new NotFoundException('Receipt not found');

    // ── State checks (used to happen inside ledger.hold; now we pre-check
    // because the hold is deferred to confirm-payment). The receipt must
    // be a live, admin-approved leaf at creation time.
    if (sourceReceipt.status !== 'ACTIVE') {
      throw new ConflictException(
        `Receipt is not in an active state (status=${sourceReceipt.status}).`,
      );
    }
    if (sourceReceipt.approvalStatus !== 'APPROVED') {
      throw new ConflictException(
        `Receipt has not been approved by an admin (approval=${sourceReceipt.approvalStatus}).`,
      );
    }
    if (sourceReceipt.isParent) {
      throw new ConflictException(
        'This receipt has been superseded by child receipts and cannot be withdrawn against directly.',
      );
    }

    // Before we even compute "available", surface the most common cause of
    // a re-submit conflict: THE SAME CLIENT already has a live PENDING_PAYMENT
    // withdrawal against this receipt. That's nearly always the
    // back-then-forward wizard navigation case, and the FE can resume the
    // existing row instead of starting a new one. Distinct error code so the
    // FE can branch on it.
    const cutoff = new Date(
      Date.now() - PENDING_PAYMENT_TTL_MINUTES * 60 * 1000,
    );
    const existingForSameClient = await this.prisma.withdrawal.findFirst({
      where: {
        tenantId,
        clientId,
        receiptId: sourceReceipt.id,
        status: WithdrawalStatus.PENDING_PAYMENT,
        createdAt: { gt: cutoff },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        reference: true,
        quantity: true,
        totalFee: true,
        plannedDate: true,
        createdAt: true,
      },
    });
    if (existingForSameClient) {
      throw new ConflictException({
        code: 'PENDING_WITHDRAWAL_EXISTS',
        message:
          'A withdrawal is already in progress for this receipt and is awaiting payment confirmation. Resume that one or cancel it before starting a new request.',
        existing: {
          id: existingForSameClient.id,
          reference: existingForSameClient.reference,
          quantity: existingForSameClient.quantity,
          fee: existingForSameClient.totalFee,
          plannedDate: existingForSameClient.plannedDate,
          createdAt: existingForSameClient.createdAt,
        },
      });
    }

    // Available quantity = receipt.quantity minus the sum of OTHER live
    // PENDING_PAYMENT withdrawals against this same receipt. We've already
    // ruled out "the same client's row" above, so anything left here is
    // genuinely someone else's reservation (rare but possible on shared
    // accounts or admin-on-behalf races).
    const available = await this.availableForWithdrawal(
      tenantId,
      sourceReceipt.id,
      Number(sourceReceipt.quantity),
    );
    if (dto.quantity > available) {
      throw new ConflictException({
        code: 'INSUFFICIENT_AVAILABLE_QUANTITY',
        message: `Only ${available} ${sourceReceipt.commodity.unitOfMeasure} available on this receipt — other pending withdrawals are reserving the rest.`,
        available,
        unit: sourceReceipt.commodity.unitOfMeasure,
      });
    }

    const policy = await this.storageFees.resolvePolicy(
      tenantId,
      sourceReceipt.warehouseId,
      sourceReceipt.commodityId,
    );
    const storageFee = this.storageFees.calculateFee(
      policy,
      dto.quantity,
      sourceReceipt.commodity.unitOfMeasure,
      sourceReceipt.dateOfDeposit,
      new Date(),
      sourceReceipt.commodity.standardBagWeightKg ?? undefined,
    );
    const totalFee = storageFee + HANDLING_FEE;

    const withdrawalId = randomUUID();
    // NOTE: the ledger.hold call deliberately does NOT happen here anymore.
    // We point the new Withdrawal row at the ORIGINAL receipt and let it
    // stay ACTIVE. The hold (and the receipt split into a HELD_WITHDRAWAL
    // child) is deferred to confirmPayment — so an abandoned create flow
    // never leaves the client's receipt tied up.
    const withdrawal = await this.prisma.withdrawal.upsert({
      where: { id: withdrawalId },
      update: {},
      create: {
        id: withdrawalId,
        reference: `W-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        receiptId: sourceReceipt.id,
        clientId,
        tenantId,
        quantity: dto.quantity,
        reason: dto.reason,
        plannedDate: new Date(dto.plannedDate),
        status: WithdrawalStatus.PENDING_PAYMENT,
        storageFee,
        handlingFee: HANDLING_FEE,
        totalFee,
      },
    });

    // ── Notifications ──────────────────────────────────────────────────────
    // Tenant admins enter the payment-confirmation queue; the client gets
    // a "we received your request, fees TBD by admin" trail.
    const summary = `${withdrawal.reference}: ${dto.quantity} ${sourceReceipt.commodity.unitOfMeasure} of ${sourceReceipt.commodity.name} (fee ₦${totalFee.toLocaleString()})`;
    void this.notifications.notifyTenantAdmins(tenantId, {
      type: 'WITHDRAWAL_REQUESTED',
      title: 'New withdrawal request',
      body: summary,
      relatedEntityType: 'withdrawal',
      relatedEntityId: withdrawal.id,
      data: {
        reference: withdrawal.reference,
        quantity: dto.quantity,
        totalFee,
        warehouseId: sourceReceipt.warehouseId,
      },
    });
    void this.notifications.notifyUser(clientId, {
      tenantId,
      type: 'WITHDRAWAL_REQUESTED',
      title: 'Withdrawal requested — awaiting payment confirmation',
      body: summary,
      relatedEntityType: 'withdrawal',
      relatedEntityId: withdrawal.id,
    });

    return {
      id: withdrawal.id,
      reference: withdrawal.reference,
      status: withdrawal.status,
      quantity: withdrawal.quantity,
      fee: withdrawal.totalFee,
      reason: withdrawal.reason,
      plannedDate: withdrawal.plannedDate,
      // No held child yet — the receipt isn't split until payment is
      // confirmed. We surface the source receipt instead so the FE can
      // still link the row back to its inventory record.
      sourceReceiptId: sourceReceipt.id,
      heldReceiptId: null,
    };
  }

  /**
   * How much of `receipt.quantity` is still available for a new withdrawal
   * request, after we subtract the quantity reserved by OTHER live
   * PENDING_PAYMENT withdrawals against the same receipt. "Live" means
   * within the PENDING_PAYMENT_TTL_MINUTES window — older rows are treated
   * as abandoned. This is a soft reservation, not a ledger hold; it only
   * affects what the create endpoint will accept.
   */
  private async availableForWithdrawal(
    tenantId: string,
    receiptId: string,
    receiptQuantity: number,
  ): Promise<number> {
    const cutoff = new Date(
      Date.now() - PENDING_PAYMENT_TTL_MINUTES * 60 * 1000,
    );
    const reserved = await this.prisma.withdrawal.aggregate({
      where: {
        tenantId,
        receiptId,
        status: WithdrawalStatus.PENDING_PAYMENT,
        createdAt: { gt: cutoff },
      },
      _sum: { quantity: true },
    });
    return receiptQuantity - (reserved._sum?.quantity ?? 0);
  }

  private async loadWithdrawal(tenantId: string, id: string) {
    const w = await this.prisma.withdrawal.findFirst({
      where: { id, tenantId },
    });
    if (!w) throw new NotFoundException('Withdrawal not found');
    return w;
  }

  async confirmPayment(
    tenantId: string,
    withdrawalId: string,
    actorUserId: string,
    actorRoles: string[],
  ) {
    const w = await this.loadWithdrawal(tenantId, withdrawalId);
    // Allowed: the withdrawal's owning client (self-attesting that they made
    // the transfer), a tenant admin (e.g. confirming a cash payment at the
    // desk), or a warehouse manager currently assigned to the held receipt's
    // warehouse (the WM-on-behalf flow — they collected cash/transfer from
    // the depositor at the desk and are recording it for them). The admin's
    // `approve` step is still the actual money-arrived verification; this
    // call is only the "payment received" signal.
    const isAdmin = actorRoles.some(
      (r) => r === 'TENANT_ADMIN' || r === 'GLOBAL_ADMIN',
    );
    const isOwner = w.clientId === actorUserId;
    let isWarehouseManagerAtHoldSite = false;
    if (!isAdmin && !isOwner && actorRoles.includes('WAREHOUSE_MANAGER')) {
      // Check the held receipt's warehouse against this WM's active
      // assignments. Co-WMs at the same site can cover for each other —
      // we don't require it to be the WM who filed the original request.
      const heldReceipt = await this.prisma.receipt.findUnique({
        where: { id: w.receiptId },
        select: { warehouseId: true },
      });
      if (heldReceipt) {
        const assignment =
          await this.prisma.warehouseManagerAssignment.findFirst({
            where: {
              tenantId,
              managerId: actorUserId,
              warehouseId: heldReceipt.warehouseId,
              unassignedAt: null,
            },
            select: { id: true },
          });
        isWarehouseManagerAtHoldSite = !!assignment;
      }
    }
    if (!isAdmin && !isOwner && !isWarehouseManagerAtHoldSite) {
      throw new ForbiddenException(
        'Only the withdrawal owner, a tenant admin, or a warehouse manager assigned to the holding warehouse can confirm payment',
      );
    }
    if (w.status !== WithdrawalStatus.PENDING_PAYMENT) {
      throw new BadRequestException(
        `Withdrawal is not awaiting payment (status: ${w.status})`,
      );
    }

    // ── This is where the ledger.hold now lives. Previously the hold ran at
    // create time, leaving the receipt visibly "Held Withdrawal" even before
    // the client/WM ever confirmed payment. Doing it here means the receipt
    // stays ACTIVE through the abandonable PENDING_PAYMENT phase and only
    // splits the moment something has actually been committed.
    //
    // Concurrency: if someone else just confirmed payment against the same
    // receipt for an overlapping quantity, ledger.hold rejects with an
    // InsufficientQuantity / state error — the FE surfaces it and the user
    // can resubmit. The original receipt's row hasn't been corrupted.
    const { held } = await this.ledger.hold({
      tenantId,
      sourceReceiptId: w.receiptId,
      quantity: w.quantity,
      heldStatus: 'HELD_WITHDRAWAL',
      txnType: 'WITHDRAWAL',
      txnId: w.id,
      actorUserId,
      idempotencyKey: `WITHDRAWAL:${w.id}:hold`,
    });

    const updated = await this.prisma.withdrawal.update({
      where: { id: withdrawalId },
      // Re-point at the freshly minted held child so all downstream stages
      // (approve, dispatch/consume) operate on the right node.
      data: {
        status: WithdrawalStatus.PAID_PENDING_APPROVAL,
        receiptId: held.id,
      },
    });

    void this.notifications.notifyTenantAdmins(tenantId, {
      type: 'WITHDRAWAL_PAYMENT_CONFIRMED',
      title: 'Withdrawal payment confirmed — awaiting approval',
      body: `${updated.reference}: payment confirmed; ready for approval.`,
      relatedEntityType: 'withdrawal',
      relatedEntityId: updated.id,
    });
    void this.notifications.notifyUser(w.clientId, {
      tenantId,
      type: 'WITHDRAWAL_PAYMENT_CONFIRMED',
      title: 'Payment confirmed',
      body: `${updated.reference}: payment received. Awaiting admin approval.`,
      relatedEntityType: 'withdrawal',
      relatedEntityId: updated.id,
    });

    return {
      id: updated.id,
      reference: updated.reference,
      status: updated.status,
      quantity: updated.quantity,
    };
  }

  async approveWithdrawal(tenantId: string, withdrawalId: string, actorUserId?: string) {
    const w = await this.loadWithdrawal(tenantId, withdrawalId);
    if (w.status !== WithdrawalStatus.PAID_PENDING_APPROVAL) {
      throw new BadRequestException(
        `Withdrawal is not awaiting approval (status: ${w.status})`,
      );
    }
    await this.ledger.approveHold({
      tenantId,
      heldReceiptId: w.receiptId,
      actorUserId,
      idempotencyKey: `WITHDRAWAL:${w.id}:approveHold`,
    });
    const updated = await this.prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: WithdrawalStatus.APPROVED,
        approvedById: actorUserId,
        approvedAt: new Date(),
      },
    });

    // Notify the client + the warehouse managers for this receipt's warehouse
    // (WM dispatch queue lights up).
    const heldReceipt = await this.prisma.receipt.findUnique({
      where: { id: w.receiptId },
      select: { warehouseId: true },
    });
    void this.notifications.notifyUser(w.clientId, {
      tenantId,
      type: 'WITHDRAWAL_APPROVED',
      title: 'Withdrawal approved — awaiting dispatch',
      body: `${updated.reference}: approved by admin. The warehouse manager will dispatch shortly.`,
      relatedEntityType: 'withdrawal',
      relatedEntityId: updated.id,
    });
    if (heldReceipt?.warehouseId) {
      void this.notifications.notifyWarehouseManagersOf(
        tenantId,
        heldReceipt.warehouseId,
        {
          type: 'WITHDRAWAL_APPROVED',
          title: 'Withdrawal ready to dispatch',
          body: `${updated.reference}: approved; please dispatch.`,
          relatedEntityType: 'withdrawal',
          relatedEntityId: updated.id,
        },
      );
    }

    return { id: updated.id, status: updated.status };
  }

  async rejectWithdrawal(
    tenantId: string,
    withdrawalId: string,
    actorUserId?: string,
    reason?: string,
  ) {
    const w = await this.loadWithdrawal(tenantId, withdrawalId);

    // COMPLETED is terminal — the goods are gone, nothing to undo. Anything
    // else is rejectable, including an already-REJECTED row whose linked
    // receipt was left in a HELD state by a prior code path (the legacy
    // create-time hold pattern, before the hold was deferred to
    // confirmPayment). Treating reject as idempotent lets you click it
    // again to clean up such orphans without us having to ship a one-off
    // data migration.
    if (w.status === WithdrawalStatus.COMPLETED) {
      throw new BadRequestException('Withdrawal is already completed');
    }

    // Should we release a hold? Drive this from the ACTUAL receipt state,
    // not from the withdrawal status. Holds-by-implication ("status >
    // PENDING_PAYMENT") are unreliable across mixed code generations —
    // checking the receipt is the source of truth.
    const linkedReceipt = await this.prisma.receipt.findUnique({
      where: { id: w.receiptId },
      select: { id: true, status: true },
    });
    const needsRelease =
      !!linkedReceipt &&
      HELD_STATUSES.includes(linkedReceipt.status);

    if (needsRelease) {
      // Idempotent via the existing release-idempotency key — calling
      // this twice for the same withdrawal is a no-op on the second hit.
      await this.ledger.release({
        tenantId,
        heldReceiptId: w.receiptId,
        actorUserId,
        reason,
        idempotencyKey: `WITHDRAWAL:${w.id}:release`,
      });
    }

    // Only write to the Withdrawal row if it isn't already REJECTED.
    // Notifications likewise only fire on the genuine state transition,
    // so re-reject for an orphan cleanup doesn't double-ping the user.
    const wasAlreadyRejected = w.status === WithdrawalStatus.REJECTED;
    const updated = wasAlreadyRejected
      ? w
      : await this.prisma.withdrawal.update({
          where: { id: withdrawalId },
          data: {
            status: WithdrawalStatus.REJECTED,
            rejectionReason: reason,
          },
        });

    if (!wasAlreadyRejected) {
      void this.notifications.notifyUser(w.clientId, {
        tenantId,
        type: 'WITHDRAWAL_REJECTED',
        title: 'Withdrawal rejected',
        body: reason
          ? `${updated.reference} was rejected. Reason: ${reason}`
          : `${updated.reference} was rejected.`,
        relatedEntityType: 'withdrawal',
        relatedEntityId: updated.id,
        data: reason ? { reason } : undefined,
      });
    }

    return {
      id: updated.id,
      status: updated.status,
      // Useful signal for the FE on the orphan-cleanup path — tells the UI
      // whether something was actually released so it can refresh the
      // receipt list immediately.
      releasedHold: needsRelease,
    };
  }

  /** Completion = CONSUME the held node (all-or-nothing). */
  async completeWithdrawal(
    tenantId: string,
    withdrawalId: string,
    actorUserId?: string,
  ) {
    const w = await this.loadWithdrawal(tenantId, withdrawalId);
    if (w.status !== WithdrawalStatus.APPROVED) {
      throw new BadRequestException(
        `Withdrawal must be APPROVED before completion (status: ${w.status})`,
      );
    }
    const consumed = await this.ledger.consume({
      tenantId,
      heldReceiptId: w.receiptId,
      actorUserId,
      idempotencyKey: `WITHDRAWAL:${w.id}:consume`,
    });

    // Recompute the storage fee against the actual dispatch date so any
    // accrual between request and dispatch is properly billed. We use the
    // currently active policy (in case it was updated since the request).
    const heldReceipt = await this.prisma.receipt.findFirstOrThrow({
      where: { id: w.receiptId },
      include: { commodity: true },
    });
    const policy = await this.storageFees.resolvePolicy(
      tenantId,
      heldReceipt.warehouseId,
      heldReceipt.commodityId,
    );
    const finalStorageFee = this.storageFees.calculateFee(
      policy,
      w.quantity,
      heldReceipt.commodity.unitOfMeasure,
      heldReceipt.dateOfDeposit,
      new Date(),
      heldReceipt.commodity.standardBagWeightKg ?? undefined,
    );
    const finalTotalFee = finalStorageFee + w.handlingFee;

    const updated = await this.prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: WithdrawalStatus.COMPLETED,
        storageFee: finalStorageFee,
        totalFee: finalTotalFee,
        feesBilledAt: new Date(),
      },
    });

    void this.notifications.notifyUser(w.clientId, {
      tenantId,
      type: 'WITHDRAWAL_DISPATCHED',
      title: 'Withdrawal dispatched',
      body: `${updated.reference} has been dispatched. Final fee: ₦${finalTotalFee.toLocaleString()}.`,
      relatedEntityType: 'withdrawal',
      relatedEntityId: updated.id,
      data: { totalFee: finalTotalFee, storageFee: finalStorageFee },
    });
    void this.notifications.notifyTenantAdmins(tenantId, {
      type: 'WITHDRAWAL_DISPATCHED',
      title: 'Withdrawal dispatched',
      body: `${updated.reference}: dispatched by WM.`,
      relatedEntityType: 'withdrawal',
      relatedEntityId: updated.id,
    });

    return {
      withdrawal: {
        id: updated.id,
        reference: updated.reference,
        status: updated.status,
        quantity: updated.quantity,
      },
      finalFees: {
        storageFee: updated.storageFee,
        handlingFee: updated.handlingFee,
        totalFee: updated.totalFee,
        billedAt: updated.feesBilledAt,
        policy: {
          id: policy.id,
          feeType: policy.feeType,
          rate: policy.rate,
          billingFrequency: policy.billingFrequency,
          currency: policy.currency,
        },
      },
      consumedReceipt: consumed.receiptNumber,
    };
  }

  /**
   * Project what the dispatch-time storage fee would be RIGHT NOW for a given
   * withdrawal. Lets the WM (and the client) see the live fee before clicking
   * dispatch. Compares against what was provisionally stored at request time.
   */
  async getFeeQuote(
    tenantId: string,
    withdrawalId: string,
    forClientId?: string,
  ) {
    const w = await this.prisma.withdrawal.findFirst({
      where: {
        id: withdrawalId,
        tenantId,
        ...(forClientId ? { clientId: forClientId } : {}),
      },
      include: { receipt: { include: { commodity: true } } },
    });
    if (!w) throw new NotFoundException('Withdrawal not found');

    const policy = await this.storageFees.resolvePolicy(
      tenantId,
      w.receipt.warehouseId,
      w.receipt.commodityId,
    );
    const projectedStorageFee = this.storageFees.calculateFee(
      policy,
      w.quantity,
      w.receipt.commodity.unitOfMeasure,
      w.receipt.dateOfDeposit,
      new Date(),
      w.receipt.commodity.standardBagWeightKg ?? undefined,
    );
    const projectedTotalFee = projectedStorageFee + w.handlingFee;

    return {
      currentlyOnRow: {
        storageFee: w.storageFee,
        handlingFee: w.handlingFee,
        totalFee: w.totalFee,
        billedAt: w.feesBilledAt,
      },
      projectedAtNow: {
        storageFee: projectedStorageFee,
        handlingFee: w.handlingFee,
        totalFee: projectedTotalFee,
        computedAt: new Date(),
      },
      delta: projectedStorageFee - w.storageFee,
      policy: {
        id: policy.id,
        feeType: policy.feeType,
        rate: policy.rate,
        billingFrequency: policy.billingFrequency,
        gracePeriodDays: policy.gracePeriodDays,
        latePenaltyPct: policy.latePenaltyPct,
        currency: policy.currency,
      },
    };
  }

  /**
   * Edit a previously-filed withdrawal. Permission + state model:
   *
   *   Caller is the OWNING client OR a TENANT_ADMIN/GLOBAL_ADMIN OR a WM
   *   assigned to the held receipt's warehouse → permission OK.
   *
   *   PENDING_PAYMENT          → anyone above can edit (reason + plannedDate).
   *   PAID_PENDING_APPROVAL    → admin only.
   *   APPROVED                 → admin only (plannedDate still useful;
   *                              reason kept for record).
   *   COMPLETED / REJECTED     → 409. Terminal, no edits.
   *
   * The held inventory is NOT touched — those fields (quantity, receiptId)
   * are immutable here. If the quantity itself is wrong, reject the
   * withdrawal and refile.
   *
   * Audit: every change writes an ActivityLog row with before/after of the
   * touched fields, the actor's kind, the state at the time of edit, and the
   * (optional) editReason from the DTO.
   */
  async editWithdrawal(args: {
    tenantId: string;
    withdrawalId: string;
    actorUserId: string;
    actorRoles: string[];
    dto: EditWithdrawalDto;
  }) {
    const w = await this.prisma.withdrawal.findFirst({
      where: { id: args.withdrawalId, tenantId: args.tenantId },
    });
    if (!w) throw new NotFoundException('Withdrawal not found');

    if (
      w.status === WithdrawalStatus.COMPLETED ||
      w.status === WithdrawalStatus.REJECTED
    ) {
      throw new ConflictException(
        `This withdrawal is ${w.status.toLowerCase()} and cannot be edited.`,
      );
    }

    const isAdmin = args.actorRoles.some(
      (r) => r === 'TENANT_ADMIN' || r === 'GLOBAL_ADMIN',
    );
    const isOwner = w.clientId === args.actorUserId;
    let isAuthorizedWm = false;
    if (
      !isAdmin &&
      !isOwner &&
      args.actorRoles.includes('WAREHOUSE_MANAGER')
    ) {
      const heldReceipt = await this.prisma.receipt.findUnique({
        where: { id: w.receiptId },
        select: { warehouseId: true },
      });
      if (heldReceipt) {
        const assignment =
          await this.prisma.warehouseManagerAssignment.findFirst({
            where: {
              tenantId: args.tenantId,
              warehouseId: heldReceipt.warehouseId,
              managerId: args.actorUserId,
              unassignedAt: null,
            },
          });
        isAuthorizedWm = !!assignment;
      }
    }
    if (!isAdmin && !isOwner && !isAuthorizedWm) {
      throw new ForbiddenException(
        'Only the withdrawal owner, an admin, or an assigned WM can edit this withdrawal.',
      );
    }

    // State gate: non-admins can only edit while it's still PENDING_PAYMENT.
    // The spec says "WMs can only modify if the request is pending; else
    // it's the TA's duty." Same rule applies to the client editing their
    // own withdrawal — after they confirm payment, only the admin should
    // be touching the record.
    if (!isAdmin && w.status !== WithdrawalStatus.PENDING_PAYMENT) {
      throw new ConflictException(
        `This withdrawal is already ${w.status} — only a tenant admin can edit it now.`,
      );
    }

    const beforeAfter: Record<string, { from: unknown; to: unknown }> = {};
    const updateData: any = {};

    if (
      args.dto.reason !== undefined &&
      args.dto.reason !== (w.reason ?? null)
    ) {
      beforeAfter['reason'] = { from: w.reason, to: args.dto.reason };
      updateData.reason = args.dto.reason;
    }
    if (args.dto.plannedDate !== undefined) {
      const next = new Date(args.dto.plannedDate);
      if (next.toISOString() !== w.plannedDate.toISOString()) {
        beforeAfter['plannedDate'] = { from: w.plannedDate, to: next };
        updateData.plannedDate = next;
      }
    }

    if (!Object.keys(updateData).length) {
      return {
        id: w.id,
        reference: w.reference,
        status: w.status,
        message: 'No changes to apply.',
      };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.withdrawal.update({
        where: { id: w.id },
        data: updateData,
      });
      await tx.activityLog.create({
        data: {
          tenantId: args.tenantId,
          userId: args.actorUserId,
          action: 'WITHDRAWAL_EDITED',
          entityType: 'Withdrawal',
          entityId: w.id,
          metadata: {
            actorKind: isAdmin ? 'TA' : isOwner ? 'CLIENT' : 'WM',
            stateAtEdit: w.status,
            changes: beforeAfter,
            editReason: args.dto.editReason ?? null,
          } as any,
        },
      });
      return u;
    });

    // Best-effort notifications.
    if (!isOwner) {
      void this.notifications.notifyUser(w.clientId, {
        tenantId: args.tenantId,
        type: 'WITHDRAWAL_REQUESTED',
        title: 'Your withdrawal was updated',
        body: `${updated.reference}: details were edited by ${isAdmin ? 'a tenant admin' : 'a warehouse manager'}.`,
        relatedEntityType: 'withdrawal',
        relatedEntityId: w.id,
        data: { changedFields: Object.keys(beforeAfter) },
      });
    }
    if (!isAdmin) {
      void this.notifications.notifyTenantAdmins(args.tenantId, {
        type: 'WITHDRAWAL_REQUESTED',
        title: 'Withdrawal updated',
        body: `${updated.reference}: details were edited prior to admin action.`,
        relatedEntityType: 'withdrawal',
        relatedEntityId: w.id,
        data: { changedFields: Object.keys(beforeAfter) },
      });
    }

    return {
      id: updated.id,
      reference: updated.reference,
      status: updated.status,
      changedFields: Object.keys(beforeAfter),
      message: 'Withdrawal updated.',
    };
  }

  async getWithdrawalDetail(tenantId: string, id: string, forClientId?: string) {
    const w = await this.prisma.withdrawal.findFirst({
      where: {
        id,
        tenantId,
        ...(forClientId ? { clientId: forClientId } : {}),
      },
      include: {
        receipt: { include: { commodity: true, warehouse: true } },
        client: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    if (!w) throw new NotFoundException('Withdrawal not found');

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
      receipt: {
        id: w.receipt.id,
        receiptNumber: w.receipt.receiptNumber,
        commodity: w.receipt.commodity.name,
        warehouse: w.receipt.warehouse.name,
      },
      client: w.client,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  }
}
