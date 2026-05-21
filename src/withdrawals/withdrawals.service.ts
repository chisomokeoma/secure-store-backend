import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { StorageFeesService } from '../storage-fees/storage-fees.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CalculateWithdrawalDto,
  CreateWithdrawalDto,
} from './dto/withdrawals.dto';

const HANDLING_FEE = 10000;

@Injectable()
export class WithdrawalsService {
  constructor(
    private prisma: PrismaService,
    private ledger: InventoryLedgerService,
    private storageFees: StorageFeesService,
    private notifications: NotificationsService,
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
  ) {
    if (dto.quantity <= 0) {
      throw new BadRequestException('Quantity must be greater than zero');
    }

    // Resolve the active storage-fee policy via the fallback chain
    // (warehouse+commodity → warehouse → commodity → tenant default) and
    // compute a PROVISIONAL fee — the dispatch step recomputes against
    // the actual collection date so storage accrual is accounted for.
    const sourceReceipt = await this.prisma.receipt.findFirst({
      where: { id: dto.receiptId, tenantId },
      include: { commodity: true },
    });
    if (!sourceReceipt) throw new NotFoundException('Receipt not found');

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
    const { held } = await this.ledger.hold({
      tenantId,
      sourceReceiptId: dto.receiptId,
      quantity: dto.quantity,
      heldStatus: 'HELD_WITHDRAWAL',
      txnType: 'WITHDRAWAL',
      txnId: withdrawalId,
      actorUserId: actorUserId ?? clientId,
      idempotencyKey: `WITHDRAWAL:${withdrawalId}:hold`,
    });

    const withdrawal = await this.prisma.withdrawal.upsert({
      where: { id: withdrawalId },
      update: {},
      create: {
        id: withdrawalId,
        reference: `W-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        receiptId: held.id,
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
      heldReceiptId: held.id,
    };
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
    // the transfer) or a tenant admin (e.g. confirming a cash payment at the
    // desk). The admin's `approve` step is the actual verification — this
    // call is just the "I sent it" signal.
    const isAdmin = actorRoles.some((r) =>
      r === 'TENANT_ADMIN' || r === 'GLOBAL_ADMIN',
    );
    const isOwner = w.clientId === actorUserId;
    if (!isAdmin && !isOwner) {
      throw new ForbiddenException(
        'Only the withdrawal owner or a tenant admin can confirm payment',
      );
    }
    if (w.status !== WithdrawalStatus.PENDING_PAYMENT) {
      throw new BadRequestException(
        `Withdrawal is not awaiting payment (status: ${w.status})`,
      );
    }
    const updated = await this.prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: WithdrawalStatus.PAID_PENDING_APPROVAL },
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
    if (
      w.status === WithdrawalStatus.COMPLETED ||
      w.status === WithdrawalStatus.REJECTED
    ) {
      throw new BadRequestException(
        `Withdrawal is already ${w.status.toLowerCase()}`,
      );
    }
    await this.ledger.release({
      tenantId,
      heldReceiptId: w.receiptId,
      actorUserId,
      reason,
      idempotencyKey: `WITHDRAWAL:${w.id}:release`,
    });
    const updated = await this.prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: WithdrawalStatus.REJECTED, rejectionReason: reason },
    });

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

    return { id: updated.id, status: updated.status };
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
