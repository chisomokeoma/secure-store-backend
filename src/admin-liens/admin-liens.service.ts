import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ForceReleaseDto } from './dto/force-release.dto';

/**
 * Global-Admin force-release. Terminal, immutable, court-order-only. This
 * is the exceptional override path — a Global Admin lifts a lien outside
 * the normal financier-approved release flow, always with a supporting
 * document, always audited.
 *
 * Exactly one ForceRelease row can exist per lien (@unique on lienId).
 * Trying twice returns the same row (idempotent from the caller's POV).
 *
 * Volume mechanics:
 *   - Full release of whatever remains (equivalent to a "release everything
 *     that's still liened" action).
 *   - ledger.release() flips the current HELD_LIEN leaf to ACTIVE.
 *   - lien.status → FORCE_RELEASED. Distinct terminal state from RELEASED
 *     so financier can filter their portfolio to see admin-overridden liens
 *     separately.
 *
 * Notifications go to BOTH parties (financier org users AND the client),
 * per spec §6.
 */
@Injectable()
export class AdminLiensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly notifications: NotificationsService,
  ) {}

  async forceReleaseLien(
    tenantId: string,
    adminUserId: string,
    lienId: string,
    dto: ForceReleaseDto,
  ) {
    const lien = await this.prisma.lien.findFirst({
      where: { id: lienId, tenantId },
      include: {
        financierOrg: { select: { id: true, name: true } },
        client: {
          select: { id: true, firstName: true, lastName: true },
        },
        receipt: { select: { id: true, receiptNumber: true } },
        forceRelease: true,
      },
    });
    if (!lien) throw new NotFoundException('Lien not found');
    if (lien.forceRelease) {
      // Idempotent: already force-released → return the existing state
      // instead of erroring. FE can safely re-post if the button gets
      // double-clicked.
      return this.projectForceReleased(lien.id);
    }
    if (lien.status === 'RELEASED') {
      throw new BadRequestException({
        code: 'LIEN_ALREADY_RELEASED',
        message:
          'This lien has already been fully released through the normal flow; no force-release needed.',
      });
    }

    // Release whatever's still held. Uses the same ledger.release primitive
    // as the normal path — the difference is only the audit trail.
    await this.ledger.release({
      tenantId,
      heldReceiptId: lien.receiptId,
      reason: `Force-released by admin: ${dto.reason}`,
      actorUserId: adminUserId,
      idempotencyKey: `lien:force-release:${lien.id}`,
    });

    // Persist force-release row + flip lien status in one transaction.
    await this.prisma.$transaction(async (tx) => {
      await tx.forceRelease.create({
        data: {
          tenantId,
          lienId: lien.id,
          adminId: adminUserId,
          reason: dto.reason,
          courtOrderDocUrl: dto.courtOrderDocUrl,
        },
      });
      await tx.lien.update({
        where: { id: lien.id },
        data: {
          status: 'FORCE_RELEASED',
          remainingQuantity: new Prisma.Decimal(0),
          releasedAt: new Date(),
        },
      });
    });

    // Platform-wide activity emit — force-release is a CRITICAL event
    // (court-order-backed override of a bank's collateral). The reason
    // and court-order URL survive on the ForceRelease row for the audit
    // detail view; the ActivityLog carries the human-readable summary.
    void this.prisma.activityLog
      .create({
        data: {
          tenantId,
          userId: adminUserId,
          action: 'lien.force_released',
          entityType: 'LIEN',
          entityId: lien.id,
          description: `Lien on receipt ${lien.receipt.receiptNumber} (${lien.financierOrg.name}) was force-released`,
          metadata: {
            severity: 'CRITICAL',
            reason: dto.reason,
            courtOrderDocUrl: dto.courtOrderDocUrl,
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    // Notify both parties.
    void this.notifyBoth(tenantId, lien, dto);

    return this.projectForceReleased(lien.id);
  }

  // ─── Read-side (for admin's Liens table if we build one later) ─────────

  async getForceReleaseDetail(tenantId: string, lienId: string) {
    return this.projectForceReleased(lienId, tenantId);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async notifyBoth(
    tenantId: string,
    lien: {
      id: string;
      clientId: string;
      financierOrgId: string;
      financierOrg: { name: string };
      receipt: { receiptNumber: string };
    },
    dto: ForceReleaseDto,
  ) {
    // Financier org users
    const financierUsers = await this.prisma.user.findMany({
      where: { financierOrgId: lien.financierOrgId, status: 'ACTIVE' },
      select: { id: true },
    });
    const financierNotifications = financierUsers.map((u) =>
      this.notifications
        .notifyUser(u.id, {
          tenantId,
          type: 'LIEN_FORCE_RELEASED',
          title: 'Lien force-released by admin',
          body: `A Global Admin has force-released the lien on receipt ${lien.receipt.receiptNumber}. Reason: ${dto.reason}`,
          relatedEntityType: 'lien',
          relatedEntityId: lien.id,
        })
        .catch(() => undefined),
    );

    // Client — same event, different tone
    const clientNotification = this.notifications
      .notifyUser(lien.clientId, {
        tenantId,
        type: 'LIEN_FORCE_RELEASED',
        title: 'Lien force-released',
        body: `The lien held by ${lien.financierOrg.name} on receipt ${lien.receipt.receiptNumber} has been force-released by an admin. Volume is available again.`,
        relatedEntityType: 'lien',
        relatedEntityId: lien.id,
      })
      .catch(() => undefined);

    await Promise.all([...financierNotifications, clientNotification]);
  }

  private async projectForceReleased(lienId: string, tenantId?: string) {
    const lien = await this.prisma.lien.findFirst({
      where: {
        id: lienId,
        ...(tenantId ? { tenantId } : {}),
      },
      include: {
        forceRelease: {
          include: {
            admin: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
        financierOrg: {
          select: { id: true, name: true, logoUrl: true },
        },
        client: { select: { id: true, firstName: true, lastName: true } },
        receipt: {
          select: {
            id: true,
            receiptNumber: true,
            commodity: { select: { name: true, unitOfMeasure: true } },
          },
        },
      },
    });
    if (!lien) throw new NotFoundException('Lien not found');
    return {
      id: lien.id,
      status: lien.status,
      quantity: lien.quantity.toString(),
      remainingQuantity: lien.remainingQuantity.toString(),
      placedAt: lien.placedAt,
      releasedAt: lien.releasedAt,
      financier: {
        id: lien.financierOrg.id,
        name: lien.financierOrg.name,
        logoUrl: lien.financierOrg.logoUrl,
      },
      client: {
        id: lien.client.id,
        name: `${lien.client.firstName} ${lien.client.lastName}`,
      },
      receipt: {
        id: lien.receipt.id,
        receiptNumber: lien.receipt.receiptNumber,
        commodity: lien.receipt.commodity.name,
        unit: lien.receipt.commodity.unitOfMeasure,
      },
      forceRelease: lien.forceRelease
        ? {
            id: lien.forceRelease.id,
            reason: lien.forceRelease.reason,
            courtOrderDocUrl: lien.forceRelease.courtOrderDocUrl,
            createdAt: lien.forceRelease.createdAt,
            admin: {
              id: lien.forceRelease.admin.id,
              name: `${lien.forceRelease.admin.firstName} ${lien.forceRelease.admin.lastName}`,
              email: lien.forceRelease.admin.email,
            },
          }
        : null,
    };
  }
}
