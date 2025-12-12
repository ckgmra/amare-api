export interface BrandConfig {
  brandCode: string;
  signupTagIds: number[];
  customFieldPrefix: string;
  defaultRedirect: string;
}

export interface SubscribeRequest {
  fname: string;
  em: string;
  brand: string;
  sourceId?: string;
  redirectSlug?: string;
  website?: string; // honeypot field
}

export interface SubscribeResponse {
  success: boolean;
  redirectUrl?: string;
  error?: string;
}

export interface KeapContact {
  id: number;
  email_addresses: Array<{
    email: string;
    field: string;
  }>;
  given_name?: string;
  family_name?: string;
  custom_fields?: Array<{
    id: number;
    content: string;
  }>;
}

export interface KeapTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface ClickbankIpnEncrypted {
  notification: string;
  iv: string;
}

export interface ClickbankIpnDecrypted {
  transactionType: string;
  vendor: string;
  receipt: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  productTitle?: string;
  itemNo?: string;
  transactionTime?: string;
  totalOrderAmount?: number;
  currency?: string;
  affiliate?: string;
  [key: string]: unknown;
}

// Legacy IPN log entry (for raw IPN logging)
export interface IpnLogEntry {
  receipt: string | null;
  transaction_type: string | null;
  vendor: string | null;
  email: string | null;
  product_id: string | null;
  raw_payload: string | null;
  is_test: boolean;
  is_encrypted: boolean;
  source_ip: string | null;
  user_agent: string | null;
  processing_status: string;
  processing_error: string | null;
  tags_applied: string | null;
  created_at: string;
}

// Tag action from BigQuery product_tags table
export interface TagAction {
  action: 'APPLY' | 'REMOVE';
  tagId: number;
  tagName?: string;
}

// Subscriber queue entry for BigQuery
export interface SubscriberQueueEntry {
  id: string;
  email: string;
  first_name: string;
  brand: string;
  dp_source_id: string | null;        // → DP_SOURCE_ID_{BRAND}
  dp_ip_address: string | null;        // → DP_IP_ADDRESS (shared)
  dp_first_upload_time: string | null; // → DP_FIRST_UPLOAD_TIME_{BRAND}
  dp_optional_inputs: string | null;   // → DP_OPTIONAL_INPUTS_{BRAND}
  redirect_slug: string | null;
  source_url: string | null;           // from Referer header
  user_agent: string | null;           // from User-Agent header
  is_processed: boolean;
  keap_contact_id: number | null;
  tags_applied: number[];
  processing_error: string | null;
  created_at: string;
  processed_at: string | null;
}

// Clickbank transaction record for BigQuery
export interface ClickbankTransaction {
  receipt: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  product_id: string;
  transaction_type: string;
  amount: number | null;
  currency: string;
  affiliate: string | null;
  clickbank_timestamp: string | null;
  keap_contact_id: number | null;
  tags_applied: number[];
  tags_removed: number[];
  processed_at: string;
  processing_status: 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'NO_TAGS';
  error_message: string | null;
  brand: string;
}
