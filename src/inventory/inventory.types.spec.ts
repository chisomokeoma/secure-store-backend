import { ReceiptStatus } from '@prisma/client';
import { deriveGroup, statusesForGroup } from './inventory.types';

describe('deriveGroup — locked Active/Liened/Cancelled contract', () => {
  it('ACTIVE + APPROVED → ACTIVE', () => {
    expect(
      deriveGroup({ status: 'ACTIVE', approvalStatus: 'APPROVED' }),
    ).toBe('ACTIVE');
  });

  it('ACTIVE but approval still PENDING → LIENED', () => {
    expect(
      deriveGroup({ status: 'ACTIVE', approvalStatus: 'PENDING' }),
    ).toBe('LIENED');
  });

  it('PENDING_APPROVAL → LIENED', () => {
    expect(
      deriveGroup({ status: 'PENDING_APPROVAL', approvalStatus: 'PENDING' }),
    ).toBe('LIENED');
  });

  it.each<ReceiptStatus>(['HELD_WITHDRAWAL', 'HELD_LOAN', 'HELD_TRADE'])(
    '%s → LIENED regardless of approval',
    (status) => {
      expect(deriveGroup({ status, approvalStatus: 'APPROVED' })).toBe(
        'LIENED',
      );
    },
  );

  it.each<ReceiptStatus>([
    'WITHDRAWN',
    'TRADED_OUT',
    'SEIZED',
    'EXPIRED',
    'CANCELLED',
    'SPLIT',
  ])('%s → CANCELLED (closed/superseded)', (status) => {
    expect(deriveGroup({ status, approvalStatus: 'APPROVED' })).toBe(
      'CANCELLED',
    );
  });
});

describe('statusesForGroup', () => {
  it('ACTIVE group is exactly [ACTIVE]', () => {
    expect(statusesForGroup('ACTIVE')).toEqual(['ACTIVE']);
  });

  it('LIENED group covers pending-approval + every held status', () => {
    const s = statusesForGroup('LIENED');
    expect(s).toEqual(
      expect.arrayContaining([
        'PENDING_APPROVAL',
        'HELD_WITHDRAWAL',
        'HELD_LOAN',
        'HELD_TRADE',
      ]),
    );
    expect(s).not.toContain('ACTIVE');
  });

  it('CANCELLED group covers all terminal + SPLIT', () => {
    expect(statusesForGroup('CANCELLED')).toEqual(
      expect.arrayContaining([
        'WITHDRAWN',
        'TRADED_OUT',
        'SEIZED',
        'EXPIRED',
        'CANCELLED',
        'SPLIT',
      ]),
    );
  });

  it('every status maps into exactly one group (round-trip)', () => {
    const all: ReceiptStatus[] = [
      'ACTIVE',
      'PENDING_APPROVAL',
      'HELD_WITHDRAWAL',
      'HELD_LOAN',
      'HELD_TRADE',
      'WITHDRAWN',
      'TRADED_OUT',
      'SEIZED',
      'EXPIRED',
      'CANCELLED',
      'SPLIT',
    ];
    for (const status of all) {
      const g = deriveGroup({ status, approvalStatus: 'APPROVED' });
      expect(statusesForGroup(g)).toContain(status);
    }
  });
});
