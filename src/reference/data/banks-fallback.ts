// Fallback Nigerian bank list — served by GET /reference/banks ONLY when the
// upstream Paystack proxy is unreachable or PAYSTACK_SECRET_KEY is unset.
//
// CANONICAL SOURCE: Paystack's `GET https://api.paystack.co/bank?country=nigeria`
// is the production-of-truth at runtime — it carries the live CBN-licensed
// list (commercial banks, merchant banks, microfinance, mobile-money).
// Paystack docs: https://paystack.com/docs/api/miscellaneous/#bank
//
// This static list is intentionally limited to the top retail banks
// (commercial + selected fintechs the average client would use), enough
// to keep client onboarding functional in dev / offline. Codes are NIBSS
// sort codes (the 3-digit prefix is the institutional code). If you need
// the full list (~350+ entries including MFBs), let Paystack respond.

export interface BankRecord {
  name: string;
  slug: string; // kebab-case identifier, matches Paystack's slug field
  code: string; // NIBSS bank code
  type: 'nuban' | 'mobile_money';
}

export const BANKS_FALLBACK: ReadonlyArray<BankRecord> = [
  { name: 'Access Bank', slug: 'access-bank', code: '044', type: 'nuban' },
  { name: 'Citibank Nigeria', slug: 'citibank-nigeria', code: '023', type: 'nuban' },
  { name: 'Ecobank Nigeria', slug: 'ecobank-nigeria', code: '050', type: 'nuban' },
  { name: 'Fidelity Bank', slug: 'fidelity-bank', code: '070', type: 'nuban' },
  { name: 'First Bank of Nigeria', slug: 'first-bank-of-nigeria', code: '011', type: 'nuban' },
  { name: 'First City Monument Bank', slug: 'first-city-monument-bank', code: '214', type: 'nuban' },
  { name: 'Globus Bank', slug: 'globus-bank', code: '00103', type: 'nuban' },
  { name: 'Guaranty Trust Bank', slug: 'guaranty-trust-bank', code: '058', type: 'nuban' },
  { name: 'Heritage Bank', slug: 'heritage-bank', code: '030', type: 'nuban' },
  { name: 'Jaiz Bank', slug: 'jaiz-bank', code: '301', type: 'nuban' },
  { name: 'Keystone Bank', slug: 'keystone-bank', code: '082', type: 'nuban' },
  { name: 'Kuda Bank', slug: 'kuda-bank', code: '50211', type: 'nuban' },
  { name: 'Opay', slug: 'opay', code: '999992', type: 'mobile_money' },
  { name: 'PalmPay', slug: 'palmpay', code: '999991', type: 'mobile_money' },
  { name: 'Polaris Bank', slug: 'polaris-bank', code: '076', type: 'nuban' },
  { name: 'Providus Bank', slug: 'providus-bank', code: '101', type: 'nuban' },
  { name: 'Stanbic IBTC Bank', slug: 'stanbic-ibtc-bank', code: '221', type: 'nuban' },
  { name: 'Standard Chartered Bank', slug: 'standard-chartered-bank', code: '068', type: 'nuban' },
  { name: 'Sterling Bank', slug: 'sterling-bank', code: '232', type: 'nuban' },
  { name: 'SunTrust Bank', slug: 'suntrust-bank', code: '100', type: 'nuban' },
  { name: 'Titan Trust Bank', slug: 'titan-trust-bank', code: '102', type: 'nuban' },
  { name: 'Union Bank of Nigeria', slug: 'union-bank-of-nigeria', code: '032', type: 'nuban' },
  { name: 'United Bank For Africa', slug: 'united-bank-for-africa', code: '033', type: 'nuban' },
  { name: 'Unity Bank', slug: 'unity-bank', code: '215', type: 'nuban' },
  { name: 'VFD Microfinance Bank', slug: 'vfd-microfinance-bank', code: '566', type: 'nuban' },
  { name: 'Wema Bank', slug: 'wema-bank', code: '035', type: 'nuban' },
  { name: 'Zenith Bank', slug: 'zenith-bank', code: '057', type: 'nuban' },
];
