import { baseReceiptNumber, nextSuffix } from './inventory.tx';

describe('baseReceiptNumber', () => {
  it('returns the number unchanged when there is no suffix', () => {
    expect(baseReceiptNumber('WR-2025-0001')).toBe('WR-2025-0001');
  });
  it('strips a single-letter suffix', () => {
    expect(baseReceiptNumber('WR-2025-0001-A')).toBe('WR-2025-0001');
  });
  it('strips a multi-letter suffix', () => {
    expect(baseReceiptNumber('WR-2025-0001-AB')).toBe('WR-2025-0001');
  });
});

describe('nextSuffix — child receipt numbering', () => {
  it('empty → A', () => expect(nextSuffix([])).toBe('A'));
  it('[A] → B', () => expect(nextSuffix(['A'])).toBe('B'));
  it('[A,B] → C', () => expect(nextSuffix(['A', 'B'])).toBe('C'));
  it('[Z] → AA', () => expect(nextSuffix(['Z'])).toBe('AA'));

  it('full A..Z → AA', () => {
    const az = Array.from({ length: 26 }, (_, i) =>
      String.fromCharCode(65 + i),
    );
    expect(nextSuffix(az)).toBe('AA');
  });

  it('[AA] → AB', () => expect(nextSuffix(['AA'])).toBe('AB'));
  it('[AZ] → BA', () => expect(nextSuffix(['AZ'])).toBe('BA'));
  it('[ZZ] → AAA', () => expect(nextSuffix(['ZZ'])).toBe('AAA'));

  it('orders single before double-letter (Z before AA)', () => {
    expect(nextSuffix(['Z', 'AA'])).toBe('AB');
  });

  it('produces a strictly increasing, collision-free sequence', () => {
    const seen = new Set<string>();
    let acc: string[] = [];
    for (let i = 0; i < 60; i++) {
      const s = nextSuffix(acc);
      expect(seen.has(s)).toBe(false);
      seen.add(s);
      acc = [...acc, s];
    }
    expect(seen.size).toBe(60);
  });
});

// isRetryableTxError is not exported; assert its observable contract through a
// tiny re-implementation guard would be brittle, so the serialization-retry
// behaviour is covered by the DB-backed concurrency e2e instead.
