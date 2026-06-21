-- Transaction PIN + 2FA. Adds four columns to `users` and a new
-- `transaction_otps` table.
--
-- New columns are all nullable / default-false so existing rows remain
-- valid — every user starts with no PIN and 2FA off, preserving today's
-- behavior. Enabling 2FA on a user is a deliberate per-account action.

BEGIN;

-- 1) Per-user PIN + 2FA toggle on the existing users table.
ALTER TABLE "users"
  ADD COLUMN "transaction_pin_hash"       TEXT,
  ADD COLUMN "transaction_pin_updated_at" TIMESTAMP(3),
  ADD COLUMN "two_factor_enabled"         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "two_factor_enabled_at"      TIMESTAMP(3);

-- 2) Purpose enum — pins an OTP to a specific transaction type so a
--    withdrawal code can't be replayed against a loan.
CREATE TYPE "TransactionOtpPurpose" AS ENUM (
  'WITHDRAWAL',
  'LOAN',
  'TRADE',
  'DISABLE_2FA'
);

-- 3) OTP storage. `code_hash` is SHA-256 of the 6-digit code; the raw
--    code is never persisted. `attempts` counts wrong submissions so a
--    bot can be locked out without affecting a fresh request.
CREATE TABLE "transaction_otps" (
  "id"         TEXT                    NOT NULL,
  "user_id"    TEXT                    NOT NULL,
  "code_hash"  TEXT                    NOT NULL,
  "purpose"    "TransactionOtpPurpose" NOT NULL,
  "expires_at" TIMESTAMP(3)            NOT NULL,
  "used_at"    TIMESTAMP(3),
  "attempts"   INTEGER                 NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transaction_otps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transaction_otps_user_id_purpose_used_at_idx"
  ON "transaction_otps" ("user_id", "purpose", "used_at");

ALTER TABLE "transaction_otps"
  ADD CONSTRAINT "transaction_otps_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
