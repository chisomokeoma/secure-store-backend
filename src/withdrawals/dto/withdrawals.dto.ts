import { IsString, IsNumber, IsOptional, IsDateString } from 'class-validator';

export class CalculateWithdrawalDto {
  @IsString()
  receiptId!: string;

  @IsNumber()
  quantity!: number;
}

export class CreateWithdrawalDto extends CalculateWithdrawalDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsString()
  plannedDate!: string;

  // 2FA fields — required only when the acting client has 2FA enabled.
  // `pin` is the client's 4-digit transaction PIN (skipped on WM-on-behalf
  // because the WM doesn't have it). `otp` is the 6-digit code delivered
  // to the client via email (POST /me/transactions/request-otp client side,
  // POST /manager/clients/:id/transactions/request-otp on-behalf side).
  @IsOptional()
  @IsString()
  pin?: string;

  @IsOptional()
  @IsString()
  otp?: string;
}

export class WithdrawalCalculationResponseDto {
  totalFee!: number;
  breakdown!: any;
}

export class WithdrawalListItemDto {
  id!: string;
  reference!: string;
  receiptNumber!: string;
  commodity!: string;
  quantity!: number;
  status!: string;
  createdAt!: Date;
}

export class PaginationMetaDto {
  total!: number;
  page!: number;
  limit!: number;
  totalPages!: number;
}

export class PaginatedWithdrawalResponseDto {
  data!: WithdrawalListItemDto[];
  meta!: PaginationMetaDto;
}

export class WithdrawalResponseDto {
  id!: string;
  status!: string;
  quantity!: number;
  reference?: string;
  fee?: number;
  reason?: string;
  plannedDate?: Date;
}

/**
 * Patch payload for editing a previously-filed withdrawal. Every field is
 * optional — omit a field to leave the existing value untouched.
 *
 * Authorisation + state restrictions live in the service:
 *   • WM/owner edit  → only while the withdrawal is PENDING_PAYMENT
 *   • TA edit        → any state EXCEPT terminal (COMPLETED, REJECTED).
 *                      In APPROVED state the editable surface shrinks
 *                      further (no `reason` rewrites once the admin has
 *                      committed) — see the service for the exact rules.
 *
 * `quantity` is intentionally NOT editable here — changing it would require
 * releasing the existing held receipt and re-holding a different child,
 * which is a different flow. If the quantity is wrong, reject the
 * withdrawal and refile it.
 */
export class EditWithdrawalDto {
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsDateString() plannedDate?: string;
  // Free-text audit reason — recorded on the ActivityLog row so the trail
  // captures WHY the edit happened.
  @IsOptional() @IsString() editReason?: string;
}
