import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Receipt, ReceiptStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Errors — flow through the existing GlobalExceptionFilter unchanged.
// ---------------------------------------------------------------------------
export class ReceiptNotFoundException extends NotFoundException {
  constructor(id: string) {
    super(`Receipt not found: ${id}`);
  }
}

export class ReceiptNotTransactableException extends ConflictException {
  constructor(id: string, status: string, approval: string) {
    super(
      `Receipt ${id} is not transactable (status=${status}, approval=${approval})`,
    );
  }
}

export class InsufficientQuantityException extends BadRequestException {
  constructor(requested: string, available: string) {
    super(
      `Requested quantity ${requested} exceeds available ${available}`,
    );
  }
}

export class LedgerConflictException extends ConflictException {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidStateTransitionException extends ConflictException {
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------
export type HeldStatus =
  | 'HELD_WITHDRAWAL'
  | 'HELD_LOAN'
  | 'HELD_TRADE';

export type ReceiptNode = Receipt;

export interface HoldResult {
  source: Receipt;
  held: Receipt;
  remainder: Receipt | null;
}

export interface SeizeResult {
  seized: Receipt;
  remainder: Receipt | null;
}

export type ReceiptGroup = 'ACTIVE' | 'LIENED' | 'CANCELLED';

const HELD: ReceiptStatus[] = [
  'HELD_WITHDRAWAL',
  'HELD_LOAN',
  'HELD_TRADE',
];

const CLOSED: ReceiptStatus[] = [
  'WITHDRAWN',
  'TRADED_OUT',
  'SEIZED',
  'EXPIRED',
  'CANCELLED',
  'SPLIT',
];

/**
 * The locked filter-group contract for the Receipt Management table.
 * Active = ACTIVE; Liened = PENDING_APPROVAL | HELD_* | approval=PENDING;
 * Cancelled = terminal/closed + superseded SPLIT parents.
 */
export function deriveGroup(r: {
  status: ReceiptStatus;
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
}): ReceiptGroup {
  if (CLOSED.includes(r.status)) return 'CANCELLED';
  if (
    r.status === 'PENDING_APPROVAL' ||
    HELD.includes(r.status) ||
    r.approvalStatus === 'PENDING'
  ) {
    return 'LIENED';
  }
  return 'ACTIVE';
}

/** status sets a group maps to — used to build list-query WHERE clauses. */
export function statusesForGroup(group: ReceiptGroup): ReceiptStatus[] {
  if (group === 'CANCELLED') return CLOSED;
  if (group === 'LIENED') return ['PENDING_APPROVAL', ...HELD];
  return ['ACTIVE'];
}

export const HELD_STATUSES = HELD;
export const CLOSED_STATUSES = CLOSED;

export const D = (v: Prisma.Decimal.Value): Prisma.Decimal =>
  new Prisma.Decimal(v);
