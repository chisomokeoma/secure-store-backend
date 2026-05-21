import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { COUNTRIES, Country } from './data/countries';
import { NIGERIAN_STATES, NigerianState } from './data/nigerian-states';
import {
  NIGERIAN_LGAS,
  NIGERIAN_LGAS_VERIFIED_AT,
} from './data/nigerian-lgas';
import { BANKS_FALLBACK, BankRecord } from './data/banks-fallback';

const PAYSTACK_BANK_URL = 'https://api.paystack.co/bank?country=nigeria';
const BANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface CachedBanks {
  fetchedAt: number;
  source: 'paystack' | 'fallback';
  banks: BankRecord[];
}

@Injectable()
export class ReferenceService {
  private readonly log = new Logger(ReferenceService.name);
  private bankCache: CachedBanks | null = null;
  private inFlight: Promise<CachedBanks> | null = null;

  // ── Countries ─────────────────────────────────────────────────────────
  getCountries(): { data: Country[]; meta: { total: number } } {
    return { data: [...COUNTRIES], meta: { total: COUNTRIES.length } };
  }

  // ── Nigerian states ───────────────────────────────────────────────────
  getNigerianStates(): { data: NigerianState[]; meta: { total: number } } {
    return {
      data: [...NIGERIAN_STATES],
      meta: { total: NIGERIAN_STATES.length },
    };
  }

  // ── LGAs for a state ──────────────────────────────────────────────────
  /**
   * Returns LGAs for the named state (case-insensitive match against the
   * canonical state name). 404 if the state isn't a Nigerian state at all;
   * 200 with empty `data` if the state exists but isn't yet hydrated from
   * the INEC dataset (UI should render a "not yet loaded" hint then).
   */
  getLgasForState(state: string): {
    state: string;
    data: string[];
    provenance: { source: string; verifiedAt: string; note?: string };
  } {
    const canonical = NIGERIAN_STATES.find(
      (s) => s.name.toLowerCase() === state.trim().toLowerCase(),
    );
    if (!canonical) {
      throw new NotFoundException(`Unknown Nigerian state: ${state}`);
    }
    const lgas = NIGERIAN_LGAS[canonical.name] ?? [];
    return {
      state: canonical.name,
      data: [...lgas],
      provenance: {
        source: 'INEC (https://www.inecnigeria.org/)',
        verifiedAt: NIGERIAN_LGAS_VERIFIED_AT,
        ...(lgas.length === 0
          ? { note: 'Not yet hydrated from the canonical INEC dataset.' }
          : {}),
      },
    };
  }

  // ── Banks (Paystack proxy with 24h cache + fallback) ──────────────────
  async getBanks(): Promise<{
    data: BankRecord[];
    meta: {
      total: number;
      source: 'paystack' | 'fallback';
      cachedAt: string;
      ttlSeconds: number;
    };
  }> {
    const cached = this.readFreshCache();
    if (cached) return this.shape(cached);

    // Coalesce concurrent requests so we don't dog-pile Paystack.
    if (!this.inFlight) {
      this.inFlight = this.fetchBanks().finally(() => {
        this.inFlight = null;
      });
    }
    const result = await this.inFlight;
    return this.shape(result);
  }

  private readFreshCache(): CachedBanks | null {
    if (!this.bankCache) return null;
    const age = Date.now() - this.bankCache.fetchedAt;
    return age < BANK_CACHE_TTL_MS ? this.bankCache : null;
  }

  private shape(c: CachedBanks) {
    return {
      data: c.banks,
      meta: {
        total: c.banks.length,
        source: c.source,
        cachedAt: new Date(c.fetchedAt).toISOString(),
        ttlSeconds: Math.floor(BANK_CACHE_TTL_MS / 1000),
      },
    };
  }

  private async fetchBanks(): Promise<CachedBanks> {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) {
      this.log.warn(
        'PAYSTACK_SECRET_KEY not set — serving static bank fallback.',
      );
      return this.cacheFallback();
    }

    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(PAYSTACK_BANK_URL, {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      clearTimeout(t);

      if (!res.ok) {
        this.log.warn(
          `Paystack /bank returned ${res.status} — using fallback list.`,
        );
        return this.cacheFallback();
      }
      const json = (await res.json()) as {
        status?: boolean;
        data?: Array<{
          name: string;
          slug: string;
          code: string;
          type?: string;
        }>;
      };
      if (!json?.status || !Array.isArray(json.data)) {
        this.log.warn('Paystack /bank shape unexpected — using fallback list.');
        return this.cacheFallback();
      }
      const banks: BankRecord[] = json.data
        .map((b) => ({
          name: b.name,
          slug: b.slug,
          code: b.code,
          type: (b.type === 'mobile_money' ? 'mobile_money' : 'nuban') as
            | 'nuban'
            | 'mobile_money',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      this.bankCache = {
        fetchedAt: Date.now(),
        source: 'paystack',
        banks,
      };
      return this.bankCache;
    } catch (err: any) {
      this.log.warn(
        `Paystack /bank fetch failed (${err?.message ?? err}) — using fallback list.`,
      );
      return this.cacheFallback();
    }
  }

  private cacheFallback(): CachedBanks {
    const banks = [...BANKS_FALLBACK].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    // Cache the fallback briefly (1h) so a missing key doesn't hammer the
    // logger on every request, but recover quickly once it's configured.
    this.bankCache = {
      fetchedAt: Date.now() - (BANK_CACHE_TTL_MS - 60 * 60 * 1000),
      source: 'fallback',
      banks,
    };
    return this.bankCache;
  }
}
