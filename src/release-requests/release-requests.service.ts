import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, ReleaseRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SecurityService } from '../security/security.service';
import {
  ApproveReleaseRequestDto,
  CreateReleaseRequestDto,
  RejectReleaseRequestDto,
} from './dto/release-requests.dto';

/**
 * Release-request lifecycle. Client submits multi-line requests to lift
 * (part of) their liens; financier approves atomically (all-or-nothing
 * per request per spec §1.3) or rejects with reason.
 *
 * Volume mechanics:
 *   - Full release (line.quantity === lien.remainingQuantity):
 *       ledger.release() flips HELD_LIEN → ACTIVE on the leaf; lien row
 *       transitions ACTIVE/PARTIALLY_RELEASED → RELEASED.
 *   - Partial release (line.quantity < lien.remainingQuantity):
 *       ledger.releasePartial() splits the HELD_LIEN leaf into an ACTIVE
 *       child (returned to client) + a smaller HELD_LIEN child (still
 *       under lien). Lien.receiptId updates to the new smaller child;
 *       remainingQuantity decrements; status becomes PARTIALLY_RELEASED.
 *
 * All-or-nothing approval semantics:
 *   Validation happens for ALL lines up-front. If any single line's
 *   quantity exceeds its lien's remaining, or the lien is not ACTIVE/
 *   PARTIALLY_RELEASED, or targets a different financier — the whole
 *   request 400s and NOTHING mutates. Only after all lines validate do
 *   we start ledger operations. If a ledger op fails mid-loop the
 *   idempotency keys make the next retry pick up cleanly; the request
 *   stays PENDING until all lines succeed.
 *
 * Concurrency:
 *   Two release requests targeting overlapping volume can race. Each
 *   line records a `RELEASE_ALREADY_PENDING` error at pre-check time.
 *   The check uses the sum of PENDING ReleaseRequestLine quantities per
 *   lien — matches the encumbrance calculation.
 */
@Injectable()
export class ReleaseRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly notifications: NotificationsService,
    private readonly security: SecurityService,
  ) {}

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
        message: 'Your organisation is currently suspended.',
      });
    }
    return { financierOrg: user.financierOrg, tenantId: user.tenantId };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLIENT-FACING
  // ═══════════════════════════════════════════════════════════════════════

  async createReleaseRequest(
    callerUserId: string,
    dto: CreateReleaseRequestDto,
  ) {
    const caller = await this.prisma.user.findUnique({
      where: { id: callerUserId },
      select: { id: true, tenantId: true },
    });
    if (!caller) throw new NotFoundException('User not found');

    // Load all target liens in one query — cheap even for 20-line requests.
    const lienIds = dto.lines.map((l) => l.lienId);
    const liens = await this.prisma.lien.findMany({
      where: { id: { in: lienIds } },
      select: {
        id: true,
        clientId: true,
        financierOrgId: true,
        receiptId: true,
        remainingQuantity: true,
        status: true,
        receipt: {
          select: {
            receiptNumber: true,
            commodity: { select: { unitOfMeasure: true } },
          },
        },
      },
    });
    const lienMap = new Map(liens.map((l) => [l.id, l]));

    // Per-lien PENDING release volume already in flight — needed to
    // compute the "remaining un-release-pending" quantity per the spec's
    // RELEASE_ALREADY_PENDING guard.
    const pendingLines = await this.prisma.releaseRequestLine.groupBy({
      by: ['lienId'],
      where: {
        lienId: { in: lienIds },
        releaseRequest: { status: 'PENDING' },
      },
      _sum: { quantity: true },
    });
    const pendingPerLien = new Map(
      pendingLines.map((p) => [p.lienId, p._sum.quantity ?? new Prisma.Decimal(0)]),
    );

    // Validate every line up-front. Collect errors so the FE gets one
    // clear 400 rather than a mystery on line #7.
    for (const line of dto.lines) {
      const lien = lienMap.get(line.lienId);
      if (!lien) {
        throw new BadRequestException({
          code: 'LIEN_NOT_FOUND',
          message: `Lien ${line.lienId} not found`,
          lienId: line.lienId,
        });
      }
      if (lien.clientId !== callerUserId) {
        // Don't tell the caller anything about liens they don't own.
        throw new NotFoundException(`Lien ${line.lienId} not found`);
      }
      if (lien.financierOrgId !== dto.financierId) {
        throw new BadRequestException({
          code: 'LIEN_FINANCIER_MISMATCH',
          message: `Lien ${line.lienId} belongs to a different financier than the one in the request`,
          lienId: line.lienId,
        });
      }
      if (lien.status !== 'ACTIVE' && lien.status !== 'PARTIALLY_RELEASED') {
        throw new BadRequestException({
          code: 'LIEN_NOT_ACTIVE',
          message: `Lien ${line.lienId} is in status ${lien.status} and cannot be released`,
          lienId: line.lienId,
        });
      }
      const qty = new Prisma.Decimal(line.quantity);
      if (qty.lte(0)) {
        throw new BadRequestException({
          code: 'QUANTITY_INVALID',
          message: 'Line quantity must be greater than zero',
          lienId: line.lienId,
        });
      }
      const pendingForLien =
        pendingPerLien.get(line.lienId) ?? new Prisma.Decimal(0);
      const availableForRelease =
        lien.remainingQuantity.minus(pendingForLien);
      if (qty.gt(availableForRelease)) {
        throw new ConflictException({
          code:
            pendingForLien.gt(0)
              ? 'RELEASE_ALREADY_PENDING'
              : 'QUANTITY_EXCEEDS_LIEN',
          message:
            pendingForLien.gt(0)
              ? `${pendingForLien.toString()} ${lien.receipt.commodity.unitOfMeasure} of this lien is already in a pending release request. Available to release: ${availableForRelease.toString()}.`
              : `Lien has ${lien.remainingQuantity.toString()} remaining; requested ${qty.toString()}`,
          lienId: line.lienId,
          available: availableForRelease.toString(),
        });
      }
    }

    // All good — create the request + lines in one transaction.
    const req = await this.prisma.$transaction(async (tx) => {
      const req = await tx.releaseRequest.create({
        data: {
          id: randomUUID(),
          tenantId: caller.tenantId,
          clientId: callerUserId,
          financierOrgId: dto.financierId,
          requestedDate: new Date(dto.requestedDate),
          note: dto.note,
          status: ReleaseRequestStatus.PENDING,
        },
      });
      for (const line of dto.lines) {
        const lien = lienMap.get(line.lienId)!;
        await tx.releaseRequestLine.create({
          data: {
            releaseRequestId: req.id,
            lienId: line.lienId,
            receiptId: lien.receiptId,
            quantity: new Prisma.Decimal(line.quantity),
          },
        });
      }
      return req;
    });

    await this.notifyFinancierUsers(dto.financierId, {
      tenantId: caller.tenantId,
      type: 'RELEASE_REQUESTED',
      title: 'New release request',
      body: `Client requested release of ${dto.lines.length} lien${dto.lines.length === 1 ? '' : 's'}${dto.note ? ` — "${dto.note.slice(0, 60)}"` : ''}`,
      relatedEntityType: 'release_request',
      relatedEntityId: req.id,
    });

    return this.projectRequestDetail(req.id);
  }

  async listMyReleaseRequests(
    callerUserId: string,
    query: {
      status?: string;
      page?: string;
      limit?: string;
    },
  ) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    const where: any = { clientId: callerUserId };
    if (query.status) where.status = query.status;

    const [rows, total] = await Promise.all([
      this.prisma.releaseRequest.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: this.requestInclude,
      }),
      this.prisma.releaseRequest.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.projectRequest(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async cancelReleaseRequest(callerUserId: string, requestId: string) {
    const req = await this.prisma.releaseRequest.findFirst({
      where: { id: requestId, clientId: callerUserId },
    });
    if (!req) throw new NotFoundException('Release request not found');
    if (req.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'RELEASE_REQUEST_NOT_PENDING',
        message: `Cannot cancel a request in status ${req.status}`,
      });
    }
    await this.prisma.releaseRequest.update({
      where: { id: req.id },
      data: {
        status: ReleaseRequestStatus.CANCELLED,
        decidedAt: new Date(),
      },
    });
    // No ledger unwind — cancelling doesn't change encumbrance because
    // release requests never held any volume; they were only signals.
    // The lien remains fully in force.
    return this.projectRequestDetail(req.id);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FINANCIER-FACING
  // ═══════════════════════════════════════════════════════════════════════

  async listFinancierReleaseRequests(
    callerUserId: string,
    query: {
      status?: string;
      page?: string;
      limit?: string;
    },
  ) {
    const { financierOrg } = await this.requireFinancierOrg(callerUserId);
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    const where: any = { financierOrgId: financierOrg.id };
    if (query.status) where.status = query.status;

    const [rows, total] = await Promise.all([
      this.prisma.releaseRequest.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        include: this.requestInclude,
      }),
      this.prisma.releaseRequest.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.projectRequest(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getFinancierReleaseRequestDetail(
    callerUserId: string,
    requestId: string,
  ) {
    const { financierOrg } = await this.requireFinancierOrg(callerUserId);
    const req = await this.prisma.releaseRequest.findFirst({
      where: { id: requestId, financierOrgId: financierOrg.id },
      include: this.requestInclude,
    });
    if (!req) throw new NotFoundException('Release request not found');
    return this.projectRequest(req);
  }

  /**
   * Approve a release request. All-or-nothing — validates every line
   * before ANY ledger operation runs, then processes each line in turn.
   *
   * Per-line ledger operation is chosen by comparing line.quantity to
   * the lien's remainingQuantity at THAT moment (re-loaded fresh):
   *   - equal  → ledger.release()          (full release)
   *   - less   → ledger.releasePartial()   (split HELD_LIEN into ACTIVE + smaller HELD_LIEN)
   *
   * After each line, the Lien row updates:
   *   - remainingQuantity -= line.quantity
   *   - status: RELEASED if remaining = 0, else PARTIALLY_RELEASED
   *   - receiptId: on partial release, points at the new smaller HELD_LIEN
   *
   * OTP consumed FIRST (wrong OTP = zero mutations). Idempotency keys
   * on ledger ops make crash-mid-loop recovery safe: re-invoking the
   * approve call after a crash replays what completed and finishes the rest.
   */
  async approveReleaseRequest(
    callerUserId: string,
    requestId: string,
    dto: ApproveReleaseRequestDto,
  ) {
    const { financierOrg } = await this.requireFinancierOrg(callerUserId);
    const req = await this.prisma.releaseRequest.findFirst({
      where: { id: requestId, financierOrgId: financierOrg.id },
      include: {
        lines: {
          include: {
            lien: {
              select: {
                id: true,
                receiptId: true,
                remainingQuantity: true,
                status: true,
              },
            },
          },
        },
        financierOrg: { select: { name: true } },
      },
    });
    if (!req) throw new NotFoundException('Release request not found');
    if (req.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'RELEASE_REQUEST_NOT_PENDING',
        message: `Cannot approve a request in status ${req.status}`,
      });
    }

    // Re-validate every line right now — lien state could have moved
    // since the request was submitted (concurrent force-release, etc.).
    for (const line of req.lines) {
      if (
        line.lien.status !== 'ACTIVE' &&
        line.lien.status !== 'PARTIALLY_RELEASED'
      ) {
        throw new BadRequestException({
          code: 'LIEN_NOT_ACTIVE',
          message: `Lien ${line.lien.id} is in status ${line.lien.status}; cannot release`,
        });
      }
      if (line.quantity.gt(line.lien.remainingQuantity)) {
        throw new BadRequestException({
          code: 'QUANTITY_EXCEEDS_LIEN',
          message: `Lien ${line.lien.id} has ${line.lien.remainingQuantity.toString()} remaining; requested ${line.quantity.toString()}`,
        });
      }
    }

    // OTP gate. Consumed BEFORE any state change so wrong-OTP burns nothing.
    await this.security.consumeOtp({
      userId: callerUserId,
      code: dto.otp,
      purpose: 'RELEASE_APPROVE',
    });

    // Process each line. Ledger ops idempotent by key so crash-mid-loop
    // is recoverable via retry.
    for (const line of req.lines) {
      const isFullRelease = line.quantity.eq(line.lien.remainingQuantity);
      if (isFullRelease) {
        await this.ledger.release({
          tenantId: req.tenantId,
          heldReceiptId: line.lien.receiptId,
          reason: `Release request ${req.id} approved`,
          actorUserId: callerUserId,
          idempotencyKey: `release:full:${req.id}:${line.id}`,
        });
        await this.prisma.lien.update({
          where: { id: line.lien.id },
          data: {
            remainingQuantity: new Prisma.Decimal(0),
            status: 'RELEASED',
            releasedAt: new Date(),
          },
        });
      } else {
        const result = await this.ledger.releasePartial({
          tenantId: req.tenantId,
          heldReceiptId: line.lien.receiptId,
          releaseQuantity: line.quantity,
          releaseRequestId: req.id,
          actorUserId: callerUserId,
          idempotencyKey: `release:partial:${req.id}:${line.id}`,
        });
        await this.prisma.lien.update({
          where: { id: line.lien.id },
          data: {
            // Lien's active leaf shifts to the new smaller HELD_LIEN.
            receiptId: result.remainingHeld.id,
            remainingQuantity: line.lien.remainingQuantity.minus(line.quantity),
            status: 'PARTIALLY_RELEASED',
          },
        });
      }
    }

    await this.prisma.releaseRequest.update({
      where: { id: req.id },
      data: {
        status: ReleaseRequestStatus.APPROVED,
        decidedById: callerUserId,
        decidedAt: new Date(),
      },
    });

    void this.notifications
      .notifyUser(req.clientId, {
        tenantId: req.tenantId,
        type: 'RELEASE_APPROVED',
        title: `Release approved by ${req.financierOrg.name}`,
        body: `Your release request has been approved — released volume is now available.`,
        relatedEntityType: 'release_request',
        relatedEntityId: req.id,
      })
      .catch(() => undefined);

    return this.getFinancierReleaseRequestDetail(callerUserId, req.id);
  }

  async rejectReleaseRequest(
    callerUserId: string,
    requestId: string,
    dto: RejectReleaseRequestDto,
  ) {
    const { financierOrg } = await this.requireFinancierOrg(callerUserId);
    const req = await this.prisma.releaseRequest.findFirst({
      where: { id: requestId, financierOrgId: financierOrg.id },
      include: { financierOrg: { select: { name: true } } },
    });
    if (!req) throw new NotFoundException('Release request not found');
    if (req.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'RELEASE_REQUEST_NOT_PENDING',
        message: `Cannot reject a request in status ${req.status}`,
      });
    }
    await this.prisma.releaseRequest.update({
      where: { id: req.id },
      data: {
        status: ReleaseRequestStatus.REJECTED,
        decisionReason: dto.reason,
        decidedById: callerUserId,
        decidedAt: new Date(),
      },
    });

    void this.notifications
      .notifyUser(req.clientId, {
        tenantId: req.tenantId,
        type: 'RELEASE_REJECTED',
        title: `Release rejected by ${req.financierOrg.name}`,
        body: `Reason: ${dto.reason}`,
        relatedEntityType: 'release_request',
        relatedEntityId: req.id,
      })
      .catch(() => undefined);

    return this.getFinancierReleaseRequestDetail(callerUserId, req.id);
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

  private readonly requestInclude = {
    client: {
      select: { id: true, firstName: true, lastName: true },
    },
    financierOrg: {
      select: { id: true, name: true, logoUrl: true },
    },
    lines: {
      include: {
        lien: {
          select: { id: true, remainingQuantity: true, status: true },
        },
        receipt: {
          select: {
            id: true,
            receiptNumber: true,
            commodity: { select: { name: true, unitOfMeasure: true } },
            grade: true,
          },
        },
      },
    },
  };

  private async projectRequestDetail(id: string) {
    const req = await this.prisma.releaseRequest.findUnique({
      where: { id },
      include: this.requestInclude,
    });
    if (!req) throw new NotFoundException('Release request not found');
    return this.projectRequest(req);
  }

  private projectRequest(req: {
    id: string;
    client: { id: string; firstName: string; lastName: string };
    financierOrg: { id: string; name: string; logoUrl: string | null };
    requestedDate: Date;
    note: string | null;
    status: ReleaseRequestStatus;
    decisionReason: string | null;
    decidedAt: Date | null;
    createdAt: Date;
    lines: {
      id: string;
      lienId: string;
      quantity: Prisma.Decimal;
      receipt: {
        id: string;
        receiptNumber: string;
        commodity: { name: string; unitOfMeasure: string };
        grade: string | null;
      };
    }[];
  }) {
    return {
      id: req.id,
      client: {
        id: req.client.id,
        name: `${req.client.firstName} ${req.client.lastName}`,
      },
      financier: {
        id: req.financierOrg.id,
        name: req.financierOrg.name,
        logoUrl: req.financierOrg.logoUrl,
      },
      requestedDate: req.requestedDate,
      note: req.note,
      lines: req.lines.map((l) => ({
        id: l.id,
        lienId: l.lienId,
        quantity: l.quantity.toString(),
        receipt: {
          id: l.receipt.id,
          receiptNumber: l.receipt.receiptNumber,
          commodity: l.receipt.commodity.name,
          grade: l.receipt.grade,
          unit: l.receipt.commodity.unitOfMeasure,
        },
      })),
      status: req.status,
      decisionReason: req.decisionReason,
      decidedAt: req.decidedAt,
      createdAt: req.createdAt,
    };
  }
}
