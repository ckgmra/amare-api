/**
 * Keap Custom Field Definitions
 *
 * These are the custom fields defined in Keap for subscriber and customer tracking.
 * The field IDs need to be looked up via the Keap API and configured
 * in environment variables.
 *
 * To get field IDs, run:
 * curl https://api.infusionsoft.com/crm/rest/v1/contactCustomFields \
 *   -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
 */

// ============================================
// SUBSCRIBER FIELDS (Newsletter Signups)
// ============================================

/**
 * Subscriber Fields - Shared across all brands
 *
 * - Brand: Which brand the contact signed up for
 * - DP_IP_ADDRESS: IP address at signup
 * - MAIL_FREQUENCY: Email frequency preference
 * - LAST_VISIT_DATE: Last website visit
 * - OPT_OUT_FORM_DATE: When they opted out
 */
export const SHARED_SUBSCRIBER_FIELDS = {
  brand: 'Brand',
  ipAddress: 'DP_IP_ADDRESS',
  mailFrequency: 'MAIL_FREQUENCY',
  lastVisitDate: 'LAST_VISIT_DATE',
  optOutFormDate: 'OPT_OUT_FORM_DATE',
} as const;

/**
 * Subscriber Fields - Brand-specific (append _CHKH, _HRYW, _GKH, _FLO)
 *
 * - DP_SOURCE_ID_{BRAND}: Where they signed up from
 * - DP_SUBSCRIBER_ID_ENCODED_{BRAND}: Encoded subscriber ID
 * - SUBSCRIBE_DATE_{BRAND}: When they subscribed
 * - DP_FIRST_UPLOAD_TIME_{BRAND}: First data upload timestamp
 * - DP_OPTIONAL_INPUTS_{BRAND}: Additional form inputs
 * - REACTIVATE_DATE_{BRAND}: When they reactivated
 * - AR_START_DATE_{BRAND}: Autoresponder start date
 */
export const BRAND_SUBSCRIBER_FIELDS = {
  sourceId: 'DP_SOURCE_ID',
  subscriberIdEncoded: 'DP_SUBSCRIBER_ID_ENCODED',
  subscribeDate: 'SUBSCRIBE_DATE',
  firstUploadTime: 'DP_FIRST_UPLOAD_TIME',
  optionalInputs: 'DP_OPTIONAL_INPUTS',
  reactivateDate: 'REACTIVATE_DATE',
  arStartDate: 'AR_START_DATE',
} as const;

// ============================================
// CUSTOM FIELDS (General)
// ============================================

/**
 * General Custom Fields
 *
 * - PayPal Address: Customer's PayPal email
 * - FE_SOURCEID: Frontend source identifier
 * - product_name: Product name
 * - redirect_link: Redirect link after action
 */
export const GENERAL_CUSTOM_FIELDS = {
  paypalAddress: 'PayPal Address',
  feSourceId: 'FE_SOURCEID',
  productName: 'product_name',
  redirectLink: 'redirect_link',
} as const;

// ============================================
// CUSTOMER PURCHASE HISTORY FIELDS
// ============================================

/**
 * Customer Purchase History - Brand-specific subscription tracking
 *
 * Format: {BRAND}_{PRODUCT}_START_DATE / {BRAND}_{PRODUCT}_CANCEL_DATE
 *
 * CHKH Products:
 * - HTH (Heal Thy Heart)
 * - MM (Meditation Mastery)
 *
 * FLO Products:
 * - MI (Manifestation Intelligence)
 * - PARMI (Partner MI)
 *
 * GKH Products:
 * - LLED (Live Life Every Day)
 * - LLC (Live Life Course)
 *
 * HRYW Products:
 * - MI (Manifestation Intelligence)
 * - HTH (Heal Thy Heart)
 * - MCC (Mind Control Course)
 */
export const CUSTOMER_SUBSCRIPTION_FIELDS = {
  chkh: {
    hth: { start: 'CHKH_HTH_START_DATE', cancel: 'CHKH_HTH_CANCEL_DATE' },
    mm: { start: 'CHKH_MM_START_DATE', cancel: 'CHKH_MM_CANCEL_DATE' },
  },
  flo: {
    mi: {
      start: 'FLO_MI_START_DATE',
      cancel: 'FLO_MI_CANCEL_DATE',
      billingReminder: 'FLO_MI_BILLING_REMINDER',
    },
    parmi: {
      start: 'FLO_PARMI_START_DATE',
      cancel: 'FLO_PARMI_CANCEL_DATE',
      billingReminder: 'FLO_PARMI_BILLING_REMINDER',
    },
  },
  gkh: {
    lled: { start: 'GKH_LLED_START_DATE', cancel: 'GKH_LLED_CANCEL_DATE' },
    llc: { start: 'GKH_LLC_START_DATE', cancel: 'GKH_LLC_CANCEL_DATE' },
  },
  hryw: {
    mi: { start: 'HRYW_MI_START_DATE', cancel: 'HRYW_MI_CANCEL_DATE' },
    hth: { start: 'HRYW_HTH_START_DATE', cancel: 'HRYW_HTH_CANCEL_DATE' },
    mcc: { start: 'HRYW_MCC_START_DATE', cancel: 'HRYW_MCC_CANCEL_DATE' },
  },
} as const;

/**
 * Customer Purchase Date Fields
 *
 * - FIRST_PURCHASE_DATE: First purchase ever (any brand)
 * - LAST_PURCHASE_DATE: Last purchase ever (any brand)
 * - FIRST_PURCHASE_DATE_{BRAND}: First purchase for specific brand
 * - LAST_PURCHASE_DATE_{BRAND}: Last purchase for specific brand
 */
export const CUSTOMER_PURCHASE_DATE_FIELDS = {
  shared: {
    firstPurchaseDate: 'FIRST_PURCHASE_DATE',
    lastPurchaseDate: 'LAST_PURCHASE_DATE',
  },
  brandSpecific: {
    firstPurchaseDate: 'FIRST_PURCHASE_DATE', // append _CHKH, _HRYW, _GKH, _FLO
    lastPurchaseDate: 'LAST_PURCHASE_DATE', // append _CHKH, _HRYW, _GKH, _FLO
  },
} as const;

// ============================================
// STANDARD CONTACT FIELDS (Built into Keap)
// ============================================

/**
 * Standard Keap Contact Fields
 *
 * These are built-in fields that don't need custom field IDs.
 * Use the Keap API field names directly.
 */
export const STANDARD_CONTACT_FIELDS = {
  // General Information
  firstName: 'given_name',
  lastName: 'family_name',
  company: 'company',
  jobTitle: 'job_title',
  email: 'email_addresses',
  website: 'website',

  // Social
  twitter: 'social_accounts', // type: TWITTER
  facebook: 'social_accounts', // type: FACEBOOK
  linkedin: 'social_accounts', // type: LINKEDIN

  // Phone
  phone: 'phone_numbers',
  fax: 'fax_numbers',

  // Address (nested under 'addresses')
  streetAddress1: 'line1',
  streetAddress2: 'line2',
  city: 'locality',
  state: 'region',
  postalCode: 'postal_code',
  country: 'country_code',

  // Global
  language: 'language',
  timeZone: 'time_zone',
} as const;

// ============================================
// SUPPORTED BRANDS
// ============================================

export const SUPPORTED_BRANDS = ['chkh', 'hryw', 'gkh', 'flo'] as const;
export type SupportedBrand = (typeof SUPPORTED_BRANDS)[number];

// ============================================
// FIELD ID CONFIGURATION
// ============================================

export interface KeapFieldIds {
  // Shared fields
  brand?: number;
  ipAddress?: number;
  mailFrequency?: number;
  lastVisitDate?: number;
  optOutFormDate?: number;

  // Brand-specific fields (keyed by brand code)
  brandFields: Record<
    string,
    {
      sourceId?: number;
      subscriberIdEncoded?: number;
      subscribeDate?: number;
      firstUploadTime?: number;
      optionalInputs?: number;
      reactivateDate?: number;
      arStartDate?: number;
    }
  >;
}

/**
 * Parse field IDs from environment variables
 */
export function getKeapFieldIds(): KeapFieldIds {
  const fieldIds: KeapFieldIds = {
    brand: parseFieldId('KEAP_FIELD_BRAND'),
    ipAddress: parseFieldId('KEAP_FIELD_IP_ADDRESS'),
    mailFrequency: parseFieldId('KEAP_FIELD_MAIL_FREQUENCY'),
    lastVisitDate: parseFieldId('KEAP_FIELD_LAST_VISIT_DATE'),
    optOutFormDate: parseFieldId('KEAP_FIELD_OPT_OUT_FORM_DATE'),
    brandFields: {},
  };

  for (const brand of SUPPORTED_BRANDS) {
    const prefix = `KEAP_FIELD_${brand.toUpperCase()}`;
    fieldIds.brandFields[brand] = {
      sourceId: parseFieldId(`${prefix}_SOURCE_ID`),
      subscriberIdEncoded: parseFieldId(`${prefix}_SUBSCRIBER_ID_ENCODED`),
      subscribeDate: parseFieldId(`${prefix}_SUBSCRIBE_DATE`),
      firstUploadTime: parseFieldId(`${prefix}_FIRST_UPLOAD_TIME`),
      optionalInputs: parseFieldId(`${prefix}_OPTIONAL_INPUTS`),
      reactivateDate: parseFieldId(`${prefix}_REACTIVATE_DATE`),
      arStartDate: parseFieldId(`${prefix}_AR_START_DATE`),
    };
  }

  return fieldIds;
}

function parseFieldId(envVar: string): number | undefined {
  const value = process.env[envVar];
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * Build custom fields array for Keap API
 */
export function buildCustomFields(
  brandCode: string,
  data: {
    sourceId?: string;
    ipAddress?: string;
    subscriberIdEncoded?: string;
    optionalInputs?: string;
    firstUploadTime?: string;
  }
): Array<{ id: number; content: string }> {
  const fieldIds = getKeapFieldIds();
  const brandFields = fieldIds.brandFields[brandCode.toLowerCase()];
  const customFields: Array<{ id: number; content: string }> = [];

  // Shared fields
  if (fieldIds.brand) {
    customFields.push({ id: fieldIds.brand, content: brandCode.toUpperCase() });
  }

  if (fieldIds.ipAddress && data.ipAddress) {
    customFields.push({ id: fieldIds.ipAddress, content: data.ipAddress });
  }

  // Brand-specific fields
  if (brandFields) {
    if (brandFields.sourceId && data.sourceId) {
      customFields.push({ id: brandFields.sourceId, content: data.sourceId });
    }

    if (brandFields.subscriberIdEncoded && data.subscriberIdEncoded) {
      customFields.push({ id: brandFields.subscriberIdEncoded, content: data.subscriberIdEncoded });
    }

    if (brandFields.firstUploadTime && data.firstUploadTime) {
      customFields.push({ id: brandFields.firstUploadTime, content: data.firstUploadTime });
    }

    if (brandFields.subscribeDate) {
      customFields.push({ id: brandFields.subscribeDate, content: data.firstUploadTime || new Date().toISOString() });
    }

    if (brandFields.optionalInputs && data.optionalInputs) {
      customFields.push({ id: brandFields.optionalInputs, content: data.optionalInputs });
    }
  }

  return customFields;
}
