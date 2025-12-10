import type { BrandConfig } from '../types/index.js';

/**
 * Brand configurations for all supported brands
 *
 * Each brand has:
 * - brandCode: Unique identifier (lowercase)
 * - signupTagIds: Keap tag IDs to apply on newsletter signup
 * - customFieldPrefix: Prefix for brand-specific custom fields in Keap
 * - defaultRedirect: Default redirect path after signup
 *
 * Tag IDs are configured via environment variables:
 * - CHKH_SIGNUP_TAG_IDS=123,456
 * - HRYW_SIGNUP_TAG_IDS=789
 * - GKH_SIGNUP_TAG_IDS=101,102
 * - FLO_SIGNUP_TAG_IDS=201
 */
const brandsConfig: Record<string, BrandConfig> = {
  chkh: {
    brandCode: 'chkh',
    signupTagIds: parseTagIds(process.env.CHKH_SIGNUP_TAG_IDS || ''),
    customFieldPrefix: 'CHKH',
    defaultRedirect: '/catalog/ebook',
  },
  hryw: {
    brandCode: 'hryw',
    signupTagIds: parseTagIds(process.env.HRYW_SIGNUP_TAG_IDS || ''),
    customFieldPrefix: 'HRYW',
    defaultRedirect: '/catalog/ebook',
  },
  gkh: {
    brandCode: 'gkh',
    signupTagIds: parseTagIds(process.env.GKH_SIGNUP_TAG_IDS || ''),
    customFieldPrefix: 'GKH',
    defaultRedirect: '/catalog/ebook',
  },
  flo: {
    brandCode: 'flo',
    signupTagIds: parseTagIds(process.env.FLO_SIGNUP_TAG_IDS || ''),
    customFieldPrefix: 'FLO',
    defaultRedirect: '/catalog/ebook',
  },
};

function parseTagIds(tagIdsString: string): number[] {
  if (!tagIdsString) return [];
  return tagIdsString
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id));
}

export function getBrandConfig(brandCode: string): BrandConfig | null {
  const normalizedCode = brandCode.toLowerCase();
  return brandsConfig[normalizedCode] || null;
}

export function getAllBrands(): string[] {
  return Object.keys(brandsConfig);
}

export function addBrand(config: BrandConfig): void {
  brandsConfig[config.brandCode.toLowerCase()] = config;
}

export default brandsConfig;
