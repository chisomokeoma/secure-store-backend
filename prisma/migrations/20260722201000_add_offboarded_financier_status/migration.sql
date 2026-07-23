-- Add OFFBOARDED terminal status to FinancierOrgStatus.
--
-- GA-only action, blocked if the financier has any active liens.
-- Distinct from SUSPENDED (which is reversible) — OFFBOARDED is terminal;
-- a returning financier is a new org row.

ALTER TYPE "FinancierOrgStatus" ADD VALUE IF NOT EXISTS 'OFFBOARDED';
