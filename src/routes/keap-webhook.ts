import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { bigQueryClient } from '../services/bigquery.js';
import { metaCAPIClient } from '../services/meta.js';
import { keapClient } from '../services/keap.js';
import { sendMetaWithQueue } from '../services/metaQueue.js';
import { logger } from '../utils/logger.js';
import type { MetaCAPIEvent, MetaQueueMetadata, TrackingContextRecord } from '../types/index.js';

/**
 * Keap REST Hook payload format:
 * - Verification: POST with X-Hook-Secret header (no body or empty body)
 * - Event: POST with { event_key: string, object_keys: Array<{ id, apiUrl, timestamp }> }
 */
interface KeapObjectKey {
  id: number;
  apiUrl?: string;
  timestamp?: string;
}

interface KeapHookEventBody {
  event_key?: string;
  object_keys?: KeapObjectKey[];
  [key: string]: unknown;
}

export async function keapWebhookRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: KeapHookEventBody }>(
    '/webhooks/keap/invoice-payment',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: true,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              received: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: KeapHookEventBody }>, reply: FastifyReply) => {
      const reqLogger = logger.child({ requestId: request.id });

      // ── Keap REST Hook Verification ──
      // When Keap creates/verifies a hook, it sends a POST with X-Hook-Secret header.
      // We must echo it back in the response header to verify ownership.
      const hookSecret = request.headers['x-hook-secret'];
      if (hookSecret) {
        reqLogger.info('Keap hook verification request received — echoing X-Hook-Secret');
        return reply
          .header('X-Hook-Secret', hookSecret)
          .send({ received: true });
      }

      // ── Event Processing ──
      // Always return 200 to prevent Keap marking hook as inactive
      const ack = () => reply.send({ received: true });

      try {
        const { event_key, object_keys } = request.body;

        reqLogger.info({ event_key, object_keys }, 'Keap webhook event received');

        if (!event_key || !object_keys || object_keys.length === 0) {
          reqLogger.warn('Missing event_key or object_keys in webhook payload');
          return ack();
        }

        if (event_key !== 'invoice.payment.add') {
          reqLogger.info({ event_key }, 'Ignoring non-payment event');
          return ack();
        }

        // Process each payment — object_keys are objects with { id, apiUrl, timestamp }
        // Payments with id=0 are deferred (Keap fires before transaction is ready)
        const immediate: number[] = [];
        const deferred: KeapObjectKey[] = [];

        for (const objectKey of object_keys) {
          const paymentId = typeof objectKey === 'object' ? objectKey.id : objectKey;
          if (paymentId && paymentId > 0) {
            immediate.push(paymentId);
          } else {
            deferred.push(typeof objectKey === 'object' ? objectKey : { id: 0 });
          }
        }

        // Process ready payments immediately, track which transaction IDs we handled
        // and capture the contactId for deferred payment lookups
        const processedTxnIds = new Set<number>();
        let knownContactId: number | null = null;

        for (const paymentId of immediate) {
          try {
            const contactId = await processPayment(paymentId, reqLogger);
            processedTxnIds.add(paymentId);
            if (contactId) knownContactId = contactId;
          } catch (err) {
            reqLogger.error({ err, paymentId }, 'Error processing payment');
          }
        }

        // Defer id=0 payments — retry in background after delays
        // Uses the contactId from the first processed payment to find new transactions
        if (deferred.length > 0 && knownContactId) {
          reqLogger.info(
            { count: deferred.length, knownContactId, processedTxnIds: [...processedTxnIds] },
            'Deferring id=0 payments for background retry'
          );
          retryDeferredPayments(knownContactId, deferred.length, processedTxnIds, reqLogger).catch(err => {
            reqLogger.error({ err }, 'Deferred payment retry failed');
          });
        } else if (deferred.length > 0) {
          reqLogger.warn(
            { count: deferred.length },
            'Cannot retry deferred payments — no contactId from immediate payments'
          );
        }

        return ack();
      } catch (error) {
        reqLogger.error({ error }, 'Keap webhook processing error');
        return ack();
      }
    }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry deferred payments (id=0) with backoff.
 * Keap sometimes fires invoice.payment.add before the transaction ID is assigned
 * (common with upsells). We retry 3 times: wait 10s, 20s, 30s.
 *
 * Strategy: Query the contact's recent transactions from Keap and process
 * any we haven't already handled.
 */
async function retryDeferredPayments(
  contactId: number,
  expectedCount: number,
  processedTxnIds: Set<number>,
  reqLogger: typeof logger
): Promise<void> {
  const delays = [10000, 20000, 30000]; // 10s, 20s, 30s
  const newlyProcessed = new Set<number>();

  for (let i = 0; i < delays.length; i++) {
    if (newlyProcessed.size >= expectedCount) break;

    reqLogger.info(
      { attempt: i + 1, delayMs: delays[i], contactId, remaining: expectedCount - newlyProcessed.size },
      'Waiting to retry deferred payments'
    );
    await sleep(delays[i]);

    try {
      const recentTxns = await keapClient.getRecentTransactionsForContact(contactId, 10);

      for (const txn of recentTxns) {
        const txnId = txn.id as number;
        if (!txnId || processedTxnIds.has(txnId) || newlyProcessed.has(txnId)) continue;

        try {
          await processPayment(txnId, reqLogger);
          newlyProcessed.add(txnId);
          reqLogger.info(
            { txnId, contactId, attempt: i + 1 },
            'Deferred payment (upsell) processed successfully'
          );
        } catch (err) {
          reqLogger.warn({ err, txnId, attempt: i + 1 }, 'Deferred payment retry failed');
        }
      }
    } catch (err) {
      reqLogger.warn({ err, attempt: i + 1 }, 'Error querying recent transactions for deferred retry');
    }
  }

  if (newlyProcessed.size < expectedCount) {
    reqLogger.warn(
      { contactId, expected: expectedCount, processed: newlyProcessed.size },
      'Some deferred payments could not be resolved after all retries'
    );
  } else {
    reqLogger.info(
      { contactId, processed: newlyProcessed.size },
      'All deferred payments resolved'
    );
  }
}

/**
 * Process a single payment from Keap webhook.
 * Fetches payment details from Keap API, looks up tracking context
 * for enrichment, and always sends a Purchase CAPI event as long as
 * we can determine the brand/pixel.
 */
async function processPayment(
  paymentId: number,
  reqLogger: typeof logger
): Promise<number | null> {
  // Fetch the transaction/payment details from Keap
  const transaction = await keapClient.getTransaction(paymentId);
  if (!transaction) {
    reqLogger.warn({ paymentId }, 'Transaction not found in Keap');
    return null;
  }

  reqLogger.info({ paymentId, transaction }, 'Fetched transaction from Keap');

  const contactId = transaction.contact_id as number | undefined;
  const amount = transaction.amount as number | undefined;
  const currency = (transaction.currency as string) || 'USD';

  // order_ids is a STRING (e.g., "74775"), not an array
  const rawOrderIds = transaction.order_ids;
  const orderId: string | null = rawOrderIds ? String(rawOrderIds) : null;

  if (!contactId) {
    reqLogger.warn({ paymentId }, 'No contact_id in transaction');
    return null;
  }

  // Fetch contact details for email + name
  const contact = await keapClient.getContactById(contactId);
  if (!contact) {
    reqLogger.warn({ contactId }, 'Contact not found in Keap');
    return contactId;
  }

  const email = contact.email_addresses?.[0]?.email || null;
  const firstName = contact.given_name || null;
  const lastName = contact.family_name || null;

  // Extract phone — try transaction's shipping info first, then contact
  const txnOrders = transaction.orders as Array<Record<string, unknown>> | undefined;
  const shippingPhone = txnOrders?.[0]?.shipping_information
    ? (txnOrders[0].shipping_information as Record<string, unknown>).phone as string | undefined
    : undefined;
  const contactPhone = (contact as unknown as Record<string, unknown>).phone1 as string | undefined;
  const phone = shippingPhone || contactPhone || null;

  reqLogger.info(
    { contactId, email, firstName, paymentId, amount },
    'Processing purchase CAPI event'
  );

  const contactIdStr = String(contactId);

  // Look up tracking context for enrichment (fbp, fbc, pixel_id, etc.)
  const trackingCtx = await bigQueryClient.lookupTrackingContext(contactIdStr, email);

  // If we found tracking context by email but it had no keap_contact_id, backfill
  if (trackingCtx && contactIdStr && !trackingCtx.keap_contact_id) {
    const backfillRecord: TrackingContextRecord = {
      created_at: new Date().toISOString(),
      brand: trackingCtx.brand,
      email: trackingCtx.email,
      keap_contact_id: contactIdStr,
      pixel_id: trackingCtx.pixel_id,
      fbp: trackingCtx.fbp,
      fbc: trackingCtx.fbc,
      fbclid: trackingCtx.fbclid,
      event_id: null,
      utm_source: trackingCtx.utm_source,
      utm_medium: trackingCtx.utm_medium,
      utm_campaign: trackingCtx.utm_campaign,
      utm_content: trackingCtx.utm_content,
      utm_term: trackingCtx.utm_term,
      source_url: trackingCtx.source_url,
      user_agent: trackingCtx.user_agent,
      ip_address: trackingCtx.ip_address,
    };
    bigQueryClient.insertTrackingContext(backfillRecord).catch(err => {
      reqLogger.error({ err }, 'Failed to backfill tracking context with contact_id');
    });
  }

  // Determine brand + pixel_id — tracking context first, then fallback to subscriber_queue + env var
  let brand: string | null = trackingCtx?.brand?.toLowerCase() || null;
  let pixelId: string | null = trackingCtx?.pixel_id || null;

  if (!brand && email) {
    brand = await bigQueryClient.lookupBrandByEmail(email);
    if (brand) brand = brand.toLowerCase();
  }

  // Fallback: detect brand from transaction's gateway_account_name (e.g., "HRYW-Auth.net")
  if (!brand) {
    const gatewayName = (transaction.gateway_account_name as string) || '';
    const brandPrefixes = ['hryw', 'chkh', 'gkh', 'flo'];
    const matched = brandPrefixes.find(b => gatewayName.toLowerCase().startsWith(b));
    if (matched) {
      brand = matched;
      reqLogger.info({ gatewayName, brand }, 'Brand detected from gateway_account_name');
    }
  }

  // Fallback: detect brand from contact's Keap tags (e.g., HRYW-WebSub, FLO-Customer)
  if (!brand && contactId) {
    brand = await keapClient.detectBrandFromTags(contactId);
    if (brand) reqLogger.info({ contactId, brand }, 'Brand detected from Keap tags');
  }

  if (!brand) {
    reqLogger.warn({ contactId, email }, 'Cannot determine brand for purchase — skipping CAPI');
    return contactId;
  }

  if (!pixelId) {
    pixelId = metaCAPIClient.getPixelId(brand);
  }

  if (!pixelId) {
    reqLogger.info({ contactId, brand }, 'No pixel_id available for brand — skipping CAPI');
    return contactId;
  }

  // Fetch order details for line items if we have an order ID
  let lineItems: Array<{ id: string; quantity: number; item_price: number }> = [];

  if (orderId) {
    try {
      const order = await keapClient.getOrder(Number(orderId));
      if (order) {
        const items = order.order_items as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(items)) {
          lineItems = items.map((item) => ({
            id: String(item.id || item.name || 'unknown'),
            quantity: (item.quantity as number) || 1,
            item_price: (item.price as number) || 0,
          }));
        }
      }
    } catch (err) {
      reqLogger.warn({ err, orderId }, 'Failed to fetch order details');
    }
  }

  // Build Purchase CAPI event
  const hashedUserData = metaCAPIClient.hashUserData({
    em: email,
    fn: firstName,
    ln: lastName,
    ph: phone,
    external_id: contactIdStr,
  });

  const userData: Record<string, unknown> = { ...hashedUserData };
  // Enrich with tracking context if available (fbp, fbc, IP, UA)
  if (trackingCtx?.fbp) userData.fbp = trackingCtx.fbp;
  if (trackingCtx?.fbc) userData.fbc = trackingCtx.fbc;
  if (trackingCtx?.ip_address) userData.client_ip_address = trackingCtx.ip_address;
  if (trackingCtx?.user_agent) userData.client_user_agent = trackingCtx.user_agent;

  // Log what enrichment data we have for match quality debugging
  reqLogger.info(
    {
      contactId,
      hasEmail: !!email,
      hasPhone: !!phone,
      hasFbp: !!trackingCtx?.fbp,
      hasFbc: !!trackingCtx?.fbc,
      hasIp: !!trackingCtx?.ip_address,
      hasUa: !!trackingCtx?.user_agent,
    },
    'Purchase CAPI match quality fields'
  );

  const customData: Record<string, unknown> = {};
  if (amount != null) customData.value = amount;
  customData.currency = currency;
  if (orderId) customData.order_id = orderId;
  if (lineItems.length > 0) customData.contents = lineItems;

  const capiEvent: MetaCAPIEvent = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    event_source_url: trackingCtx?.source_url || undefined,
    user_data: userData,
    custom_data: customData,
  };

  const queueMetadata: MetaQueueMetadata = {
    source: 'purchase',
    brand,
    eventName: 'Purchase',
    email,
    emailHash: hashedUserData.em || null,
    keapContactId: contactIdStr,
    orderId,
    pixelId,
  };

  // Send via durable queue (fire-and-forget from webhook perspective)
  sendMetaWithQueue(queueMetadata, capiEvent).catch(err => {
    reqLogger.error({ err }, 'Failed to queue Purchase CAPI event');
  });

  reqLogger.info(
    { contactId, orderId, pixelId, brand, hasTrackingContext: !!trackingCtx },
    'Purchase CAPI event queued'
  );

  return contactId;
}
