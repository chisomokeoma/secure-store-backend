/**
 * Unit conversion utilities for warehouse-utilisation math.
 *
 * The problem: warehouses hold commodities in mixed units (KG, MT, BAG,
 * LITRE, ...). The utilisation meter needs everything in one unit —
 * megatons (MT) since that's how `Warehouse.capacityMt` is denominated.
 *
 * This helper converts a per-commodity (quantity, unit) pair to MT using
 * the commodity's metadata. When conversion isn't possible (e.g. a BAG
 * commodity with no standardBagWeightKg set, or a LITRE commodity with
 * no standardDensityKgPerLitre set), it returns `null` — the caller
 * must skip that commodity from the sum rather than approximate. Under-
 * reporting utilisation is better than lying about it.
 */

export interface CommodityUnitMetadata {
  unitOfMeasure: string;
  standardBagWeightKg: number | null;
  standardDensityKgPerLitre: number | null;
}

/**
 * Convert `quantity` (in the commodity's declared unit) to metric tons.
 * Returns `null` when conversion isn't possible — the caller should
 * skip this line rather than attempt an approximation.
 *
 * Supported conversions:
 *   • KILOGRAM        → qty / 1000
 *   • METRIC_TON      → qty
 *   • BAG             → qty * standardBagWeightKg / 1000  (needs bag weight)
 *   • LITRE           → qty * standardDensityKgPerLitre / 1000  (needs density)
 *   • Anything else   → null
 */
export function quantityToMt(
  quantity: number,
  commodity: CommodityUnitMetadata,
): number | null {
  const q = Number(quantity);
  if (!Number.isFinite(q)) return null;

  switch (commodity.unitOfMeasure) {
    case 'KILOGRAM':
      return q / 1000;

    case 'METRIC_TON':
      return q;

    case 'BAG': {
      const kgPerBag = commodity.standardBagWeightKg;
      if (!kgPerBag || kgPerBag <= 0) return null;
      return (q * kgPerBag) / 1000;
    }

    case 'LITRE': {
      const density = commodity.standardDensityKgPerLitre;
      if (!density || density <= 0) return null;
      return (q * density) / 1000;
    }

    default:
      return null;
  }
}

/**
 * Sum a list of (quantity, commodity) pairs into a single MT figure.
 * Silently skips lines that can't be converted — the returned total
 * reflects only the convertible portion.
 *
 * Returned tuple:
 *   • [0] totalMt          — sum of convertible lines in MT
 *   • [1] skippedLineCount — how many lines were dropped (missing metadata)
 *
 * Callers that want to reflect the skip count in the response body
 * (e.g. "utilisation is a lower bound — 2 commodities lack conversion
 * metadata") can read [1]. The current admin surfaces don't; they'd
 * rather show a slightly-low number than an "incomplete" disclaimer.
 */
export function sumInMt(
  lines: Array<{ quantity: number; commodity: CommodityUnitMetadata }>,
): [totalMt: number, skippedLineCount: number] {
  let totalMt = 0;
  let skipped = 0;
  for (const line of lines) {
    const mt = quantityToMt(line.quantity, line.commodity);
    if (mt === null) {
      skipped++;
      continue;
    }
    totalMt += mt;
  }
  return [totalMt, skipped];
}
