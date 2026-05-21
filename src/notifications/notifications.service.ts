import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  NotificationType,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The shape every dispatch call hands in. Title/body are pre-rendered by the
 * call site (closest to the domain logic — knows the verb, the actor, the
 * amount). The data blob is optional and only used by call sites that need to
 * surface something extra in the bell (e.g. counterparty name, dispatch ETA)
 * without dragging a schema migration.
 */
export interface DispatchInput {
  tenantId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  data?: Prisma.InputJsonValue;
}

type Tx = PrismaClient | Prisma.TransactionClient;

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  constructor(private prisma: PrismaService) {}

  // ── Read path ─────────────────────────────────────────────────────────────

  /**
   * Paginated notification list for the bell + a fresh unreadCount on every
   * read so the badge stays accurate even without a websocket. `unreadOnly`
   * gates the list — useful for the dropdown which only shows unread.
   */
  async getNotifications(
    userId: string,
    opts: {
      page?: string | number;
      limit?: string | number;
      unreadOnly?: string | boolean;
    } = {},
  ) {
    const page = Math.max(1, Number(opts.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(opts.limit ?? 20)));
    const skip = (page - 1) * limit;
    const unreadOnly =
      opts.unreadOnly === true || opts.unreadOnly === 'true';

    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(unreadOnly ? { isRead: false } : {}),
    };

    const [rows, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    return {
      data: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        relatedEntityType: n.relatedEntityType,
        relatedEntityId: n.relatedEntityId,
        data: n.data,
        isRead: n.isRead,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
        unreadCount,
      },
    };
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { success: true, updated: result.count };
  }

  async markRead(userId: string, notificationId: string) {
    // Scope by userId so a forged id from another user errors as not-found.
    const n = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
      select: { id: true, isRead: true },
    });
    if (!n) throw new NotFoundException('Notification not found');
    if (!n.isRead) {
      await this.prisma.notification.update({
        where: { id: n.id },
        data: { isRead: true, readAt: new Date() },
      });
    }
    return { success: true };
  }

  // ── Dispatch (write path) ─────────────────────────────────────────────────

  /**
   * Single-recipient dispatch. Wrapped in try/catch — a notification failure
   * must NEVER take down the domain action that triggered it (an admin's
   * approval still succeeds even if the bell write hiccups).
   *
   * Pass a `tx` when calling from inside an existing $transaction so the
   * notification commits/rolls back with the domain change. Otherwise the
   * default Prisma client is used.
   */
  async dispatch(input: DispatchInput, tx?: Tx): Promise<void> {
    const client: Tx = tx ?? this.prisma;
    try {
      await client.notification.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          relatedEntityType: input.relatedEntityType,
          relatedEntityId: input.relatedEntityId,
          data: input.data,
        },
      });
    } catch (err: any) {
      this.log.warn(
        `Notification dispatch failed for user=${input.userId} type=${input.type}: ${err?.message ?? err}`,
      );
    }
  }

  /** Fan-out version. Same payload to every recipient. Skips empty lists cheaply. */
  async dispatchMany(
    recipients: string[],
    input: Omit<DispatchInput, 'userId'>,
    tx?: Tx,
  ): Promise<void> {
    const unique = Array.from(new Set(recipients));
    if (!unique.length) return;
    const client: Tx = tx ?? this.prisma;
    try {
      await client.notification.createMany({
        data: unique.map((userId) => ({
          tenantId: input.tenantId,
          userId,
          type: input.type,
          title: input.title,
          body: input.body,
          relatedEntityType: input.relatedEntityType,
          relatedEntityId: input.relatedEntityId,
          data: input.data,
        })),
      });
    } catch (err: any) {
      this.log.warn(
        `Notification fan-out failed (n=${unique.length}, type=${input.type}): ${err?.message ?? err}`,
      );
    }
  }

  // ── Audience helpers (cache-light; one query per call) ───────────────────

  /** All active TENANT_ADMIN + GLOBAL_ADMIN user ids for a tenant. */
  async tenantAdminIds(tenantId: string): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        roles: {
          some: { role: { name: { in: ['TENANT_ADMIN', 'GLOBAL_ADMIN'] } } },
        },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** Active managers currently assigned to the given warehouse. */
  async warehouseManagerIdsOf(
    tenantId: string,
    warehouseId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.warehouseManagerAssignment.findMany({
      where: { tenantId, warehouseId, unassignedAt: null },
      select: { managerId: true },
    });
    return rows.map((r) => r.managerId);
  }

  // ── Composed shortcuts the call sites use ────────────────────────────────

  notifyTenantAdmins(
    tenantId: string,
    payload: Omit<DispatchInput, 'userId' | 'tenantId'>,
    tx?: Tx,
  ) {
    return this.tenantAdminIds(tenantId).then((ids) =>
      this.dispatchMany(ids, { tenantId, ...payload }, tx),
    );
  }

  notifyWarehouseManagersOf(
    tenantId: string,
    warehouseId: string,
    payload: Omit<DispatchInput, 'userId' | 'tenantId'>,
    tx?: Tx,
  ) {
    return this.warehouseManagerIdsOf(tenantId, warehouseId).then((ids) =>
      this.dispatchMany(ids, { tenantId, ...payload }, tx),
    );
  }

  notifyUser(
    userId: string,
    payload: Omit<DispatchInput, 'userId'>,
    tx?: Tx,
  ) {
    return this.dispatch({ userId, ...payload }, tx);
  }
}
