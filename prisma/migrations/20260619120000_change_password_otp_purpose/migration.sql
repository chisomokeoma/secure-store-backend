-- Add CHANGE_PASSWORD to TransactionOtpPurpose. Used by the in-app
-- password-rotation flow as a step-up gate: the client must prove they
-- control their inbox before the password is updated, even if 2FA on
-- transactions is otherwise off. Closes the "WM with session access
-- silently rotates the password" attack vector.
--
-- ALTER TYPE … ADD VALUE is the standard non-destructive way to extend a
-- Postgres enum; existing rows are untouched.

ALTER TYPE "TransactionOtpPurpose" ADD VALUE IF NOT EXISTS 'CHANGE_PASSWORD';
