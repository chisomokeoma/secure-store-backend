import { IsString, IsNumber, IsOptional, IsPositive } from 'class-validator';

export class CalculateLoanDto {
  @IsString()
  receiptId!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsString()
  financierId!: string;
}

export class CreateLoanDto extends CalculateLoanDto {
  @IsOptional()
  @IsString()
  notes?: string;

  // 2FA fields — see CreateWithdrawalDto for semantics.
  @IsOptional()
  @IsString()
  pin?: string;

  @IsOptional()
  @IsString()
  otp?: string;
}

export class FinancierDto {
  id!: string;
  name!: string;
  interestRate!: number;
  minTenure!: number;
  maxTenure!: number;
  approvalTime!: string;
}

export class PledgeableReceiptDto {
  id!: string;
  receiptNumber!: string;
  availableQuantity!: number;
  commodity!: string;
}

export class LoanCalculationResponseDto {
  totalInterest!: number;
  monthlyPayment!: number;
  tenureMonths!: number;
  interestRate!: number;
}

export class LoanResponseDto {
  id!: string;
  reference!: string;
  status!: string;
  amount!: number;
  totalInterest!: number;
  monthlyPayment!: number;
  tenureMonths!: number;
  pledgedReceipt!: string;
}

/**
 * Patch payload for editing a previously-filed loan. Every field is optional;
 * omit a field to leave the existing value untouched.
 *
 * Authorisation + state restrictions live in the service:
 *   • Owner / WM (assigned to the pledged receipt's warehouse) edit  →
 *     only while the loan is PENDING (not yet approved).
 *   • Admin edit  →  any state EXCEPT terminal (REPAID, DEFAULTED,
 *     REJECTED, CANCELLED). After APPROVED/ACTIVE the editable surface
 *     is limited to `notes` only — see service for exact rules.
 *
 * `amount` / `financierId` are intentionally edit-locked once the loan has
 * been approved, because both feed downstream interest/payment math that
 * was already disclosed to the client. Recreate the loan if those need to
 * change.
 */
export class EditLoanDto {
  // Only honoured while the loan is PENDING. Service rejects amount edits
  // on APPROVED/ACTIVE.
  @IsOptional() @IsNumber() @IsPositive() amount?: number;
  @IsOptional() @IsString() financierId?: string;

  // Always editable (in any non-terminal state).
  @IsOptional() @IsString() notes?: string;

  // Free-text audit reason — recorded on the ActivityLog row.
  @IsOptional() @IsString() editReason?: string;
}
