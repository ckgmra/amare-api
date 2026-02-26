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
  // v8+ encrypted format has nested customer object
  customer?: {
    shipping?: {
      email?: string;
      firstName?: string;
      lastName?: string;
      fullName?: string;
    };
    billing?: {
      email?: string;
      firstName?: string;
      lastName?: string;
      fullName?: string;
    };
  };
  // v8+ has lineItems array
  lineItems?: Array<{
    itemNo?: string;
    productTitle?: string;
    accountAmount?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// Tag action from BigQuery product_tags table
export interface TagAction {
  action: 'apply_tag' | 'apply_note';
  tagId: number; // Keap tag ID (0 for notes)
  tagCategory?: string; // e.g., 'CustomerHub', 'Products Purchased', 'n/a'
  triggerTag?: string; // Human-readable tag name or ADDNOTE: text
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
  source_url: string | null;           // Original page URL where form was submitted
  user_agent: string | null;           // from User-Agent header
  raw_payload: string | null;          // Full JSON payload for debugging
  tag_name: string | null;             // Keap tag name to apply (e.g., "HRYW-WebSub")
  is_processed: boolean;
  keap_contact_id: number | null;
  tags_applied: string[];              // Tag names that were applied
  processing_error: string | null;
  created_at: string;
  processed_at: string | null;
}

// Tracking context record for BigQuery (append-only, stores Meta pixel + UTM data)
export interface TrackingContextRecord {
  created_at: string;
  brand: string;
  email: string;
  keap_contact_id: string | null;
  pixel_id: string | null;
  fbp: string | null;
  fbc: string | null;
  fbclid: string | null;
  event_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  source_url: string | null;
  user_agent: string | null;
  ip_address: string | null;
}

// Meta CAPI event payload
export interface MetaCAPIEvent {
  event_name: string;
  event_time: number;
  action_source: string;
  event_source_url?: string;
  event_id?: string;
  user_data: Record<string, unknown>;
  custom_data?: Record<string, unknown>;
}

// Structured return from Meta CAPI sendEvent
export interface MetaSendResult {
  success: boolean;
  httpStatus?: number;
  responseJson?: string;
  latencyMs: number;
  error?: string;
}

// Meta CAPI queue record for BigQuery (append-only status rows)
export interface MetaQueueRecord {
  created_at: string;
  updated_at: string;
  queue_id: string;
  source: string;
  brand: string;
  event_name: string;
  email: string | null;
  email_hash: string | null;
  keap_contact_id: string | null;
  order_id: string | null;
  event_id: string | null;
  pixel_id: string | null;
  event_time: number;
  action_source: string;
  event_source_url: string | null;
  capi_payload_json: string;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'DEAD';
  attempt_count: number;
  next_attempt_at: string;
  last_http_status: number | null;
  last_error_message: string | null;
  last_response_json: string | null;
  last_latency_ms: number | null;
}

// Metadata passed alongside CAPI payload for queue tracking
export interface MetaQueueMetadata {
  source: 'subscribe' | 'purchase';
  brand: string;
  eventName: string;
  email: string | null;
  emailHash: string | null;
  keapContactId?: string | null;
  orderId?: string | null;
  eventId?: string | null;
  pixelId: string;
}

// Keap webhook log record — one row per payment processed, for classification debugging
export interface KeapWebhookLogRecord {
  created_at: string;
  payment_id: number;
  contact_id: number | null;
  brand: string | null;
  event_name: string | null;
  subscription_plan_id: number | null;
  prior_order_count: number | null;
  order_id: string | null;
  amount: number | null;
  currency: string | null;
  raw_transaction_json: string | null;
  raw_order_json: string | null;
  classification_note: string | null;
}

// Clickbank transaction record for BigQuery (consolidated: audit log + processing queue)
export interface ClickbankTransaction {
  id: string;
  receipt: string;
  transaction_type: string;
  brand: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  product_id: string;
  amount: number | null;
  currency: string;
  affiliate: string | null;
  clickbank_timestamp: string | null;
  // Audit fields
  raw_payload: string | null;
  is_test: boolean;
  is_encrypted: boolean;
  source_ip: string | null;
  user_agent: string | null;
  // Processing queue fields
  is_processed: boolean;
  keap_contact_id: number | null;
  tags_applied: number[];
  tags_removed: number[];
  processing_status: 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'NO_TAGS' | 'PENDING' | 'TEST' | 'DECRYPTION_FAILED' | 'VALIDATION_FAILED';
  error_message: string | null;
  created_at: string;
  processed_at: string | null;
}
