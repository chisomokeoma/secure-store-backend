# Phase 1 — Receipt-tree + ledger migration runbook

Three ordered parts. **Never run against the live Neon DB directly** — use a
Neon branch loaded with a copy of production data, prove the gate passes, then
promote.

| Part | What | Reversible? |
|---|---|---|
| 3a | `migrations/20260517120000_phase1_receipt_tree_ledger_ddl` | structural, non-destructive |
| 3b | `prisma/backfill/phase1-backfill.ts` (idempotent) | data backfill, re-runnable |
| 3c | `migrations/20260517120200_phase1_receipt_tree_ledger_tighten` | drops `quantity_available` (destructive) |

## ⚠️ Step 0 — Reconcile the squashed-migration baseline (REQUIRED FIRST)

Commit `7829e25` squashed 6 incremental migrations into the single
`20260511004840_init_multi_tenant`. The Neon DB was built from the **6 old
migrations**, so its `_prisma_migrations` does **not** record the squashed init.
Without fixing this, `prisma migrate deploy` will try to *run* the squashed init
against the existing schema and fail (`CREATE TYPE … already exists`).

This is NOT fixed by wiping the schema (that destroys the data `phase1:backfill`
reads). Baseline it instead — non-destructive, records only:

```bash
# On a Neon branch, DATABASE_URL pointed at it:
npx prisma migrate status
psql "$DATABASE_URL" -c \
  "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at;"

npx prisma migrate resolve --applied 20260511004840_init_multi_tenant

npx prisma migrate status   # MUST now show only the two phase1 migrations
                            # pending and NO drift. If drift -> stop, investigate
                            # (live schema diverged from the squashed baseline).
```

Only when `migrate status` is clean do the steps below apply.

## Order of operations

```bash
# 0. Branch prod data (Neon), point DATABASE_URL at the branch,
#    and complete "Step 0" above (baseline reconciliation).

# 1. Apply 3a only.
npx prisma migrate deploy        # applies 3a; 3c will FAIL FAST on its guard
                                 # (no NULL root_receipt_id yet) — this is SAFE,
                                 # nothing is corrupted, 3c simply rolls back.

# 2. Backfill, then verify (the Definition-of-Done gate).
npm run phase1:backfill
npm run phase1:verify            # must print "PHASE 1 VERIFICATION PASSED"

# 3. Only now apply 3c.
#    If step 1 left 3c marked failed:
npx prisma migrate resolve --rolled-back 20260517120200_phase1_receipt_tree_ledger_tighten
npx prisma migrate deploy        # guard passes → 3c applies cleanly

# 4. Re-run the gate post-tighten as a final check.
npm run phase1:verify
```

## Safety properties

- **3c guard**: aborts the whole tightening migration if any `root_receipt_id`
  is NULL *or* any parent ≠ Σ(children). Premature `migrate deploy` cannot
  corrupt data — it fails loudly and rolls back.
- **3b idempotent**: re-runnable; only writes missing/incorrect rows. Genesis
  and reconciliation events use deterministic `idempotency_key`s.
- **§5C**: any unattributable legacy gap becomes ONE explicit
  `LEGACY_RECONCILIATION` opening-balance node + event, so the invariant holds
  by construction. Over-allocation (leaves > root) aborts rather than fabricates.
- **Append-only**: optionally enable the commented `REVOKE` at the end of 3c.

## Known follow-on (NOT Phase 1)

After 3a the Prisma client changes (`quantity: Decimal`, no `quantityAvailable`).
Legacy services and `seed.ts` will not compile until Phases 3–5 rewire them onto
`InventoryLedgerService` (§9 of the Phase 2 design). Expected and intentional.
