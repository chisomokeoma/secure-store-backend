-- Shared warehouse credential. Managers log in with the warehouse's email +
-- password, then identify themselves from the currently-assigned roster.
-- Audit (`actorUserId`, `Notification.userId`, etc.) still records the
-- specific human, so attribution stays intact.
--
-- New columns are all nullable (or default-true for the rotation flag) so
-- existing warehouses remain valid. Admins set the initial email/password
-- via the admin endpoint; until then, the warehouse can't be used for
-- shared-credential login but everything else works as before.

BEGIN;

ALTER TABLE "warehouses"
  ADD COLUMN "email"                TEXT,
  ADD COLUMN "password_hash"        TEXT,
  ADD COLUMN "password_set_at"      TIMESTAMP(3),
  ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT TRUE;

-- Unique on email so two warehouses can't share a login. NULLs are allowed
-- and multiple — Postgres treats them as distinct under UNIQUE.
CREATE UNIQUE INDEX "warehouses_email_key" ON "warehouses" ("email");

COMMIT;
