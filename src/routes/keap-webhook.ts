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
interface KeapHookEventBody {
  event_key?: string;
  object_keys?: Array<{ id: number; [key: string]: unknown }>;
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
        // Payments with id=0 are deferred (Keap fires before transaction is ready, common with upsells).
        // Keap does NOT fire again with the real ID, so we must retry to find the transaction.
        const immediate: number[] = [];
        let deferredCount = 0;

        for (const objectKey of object_keys) {
          const paymentId = typeof objectKey === 'object' ? objectKey.id : objectKey;
          if (paymentId && paymentId > 0) {
            immediate.push(paymentId);
          } else {
            deferredCount++;
          }
        }

        // Process immediate (real-ID) payments
        for (const paymentId of immediate) {
          try {
            await processPayment(paymentId, reqLogger);
          } catch (err) {
            reqLogger.error({ err, paymentId }, 'Error processing payment');
          }
        }

        // Handle deferred (id=0) payments — reconcile by querying ALL recent
        // Keap transactions and diffing against what we've already sent to Meta.
        // No contactId needed — we catch any unprocessed transaction.
        if (deferredCount > 0) {
          reqLogger.info({ deferredCount }, 'Deferring id=0 payments for background reconciliation');
          reconcileDeferredPayments(deferredCount, reqLogger).catch(err => {
            reqLogger.error({ err }, 'Deferred payment reconciliation failed');
          });
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
 * Reconcile deferred (id=0) payments by querying ALL recent Keap transactions
 * and diffing against what we've already sent to Meta CAPI.
 *
 * Keap fires invoice.payment.add for upsells before the transaction ID is assigned
 * and does NOT fire again with the real ID. Instead of trying to correlate by
 * contactId (which we don't have from id=0), we query all recent transactions
 * from Keap and process any we haven't already handled.
 *
 * Retries 3 times: wait 15s, 30s, 60s.
 */
async function reconcileDeferredPayments(
  expectedCount: number,
  reqLogger: typeof logger
): Promise<void> {
  const delays = [15000, 30000, 60000]; // 15s, 30s, 60s
  const reconciled = new Set<number>();

  for (let i = 0; i < delays.length; i++) {
    if (reconciled.size >= expectedCount) break;

    reqLogger.info(
      { attempt: i + 1, delayMs: delays[i], remaining: expectedCount - reconciled.size },
      'Waiting to reconcile deferred payments'
    );
    await sleep(delays[i]);

    try {
      // Query all Keap transactions from the last 15 minutes
      const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const recentTxns = await keapClient.getRecentTransactions(since, 50);

      // Get transaction IDs we've already sent to Meta
      const alreadyProcessed = await bigQueryClient.getRecentlyProcessedTransactionIds(30);

      reqLogger.info(
        { attempt: i + 1, keapTxnCount: recentTxns.length, alreadyProcessedCount: alreadyProcessed.size },
        'Reconciliation: fetched recent transactions'
      );

      for (const txn of recentTxns) {
        const txnId = txn.id as number;
        if (!txnId || txnId <= 0) continue;

        // Skip if we've already processed this transaction (in queue or this reconciliation run)
        const txnIdStr = String(txnId);
        if (alreadyProcessed.has(txnIdStr) || reconciled.has(txnId)) continue;

        try {
          await processPayment(txnId, reqLogger);
          reconciled.add(txnId);
          reqLogger.info(
            { txnId, attempt: i + 1 },
            'Deferred payment (upsell) reconciled successfully'
          );
        } catch (err) {
          reqLogger.warn({ err, txnId, attempt: i + 1 }, 'Deferred payment reconciliation failed for txn');
        }
      }
    } catch (err) {
      reqLogger.warn({ err, attempt: i + 1 }, 'Error during deferred payment reconciliation');
    }
  }

  if (reconciled.size > 0) {
    reqLogger.info(
      { expected: expectedCount, reconciled: reconciled.size, txnIds: [...reconciled] },
      'Deferred payment reconciliation complete'
    );
  } else {
    reqLogger.warn(
      { expected: expectedCount },
      'Deferred payment reconciliation found no new transactions after all retries'
    );
  }
}

/**
 * Process a single payment from Keap webhook.
 * Fetches payment details from Keap API, looks up tracking context
 * for enrichment, and sends a Purchase or RecurringPayment CAPI event
 * depending on whether prior subscription invoices exist for this contact.
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

  // Extract address fields (city, state, zip) from Keap contact addresses
  const contactAny = contact as unknown as Record<string, unknown>;
  const addresses = contactAny.addresses as Array<Record<string, unknown>> | undefined;
  const primaryAddr = addresses?.[0];
  const city = (primaryAddr?.locality as string) || null;
  const state = (primaryAddr?.region as string) || null;
  const zip = (primaryAddr?.zip_code as string) || (primaryAddr?.postal_code as string) || null;

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

  // Fetch order details for line items + subscription detection
  let lineItems: Array<{ id: string; quantity: number; item_price: number }> = [];
  let subscriptionPlanId: number | null = null;
  let rawOrderJson: string | null = null;
  let classificationNote: string | null = null;

  if (!orderId) {
    classificationNote = 'no_order_id';
  } else {
    try {
      const order = await keapClient.getOrder(Number(orderId));
      if (order) {
        rawOrderJson = JSON.stringify(order);

        // If the order was created on a prior date, this is an installment payment
        // (multi-pay plan) on an order already reported to Meta. Skip CAPI entirely.
        const orderCreationDate = order.creation_date as string | undefined;
        if (orderCreationDate) {
          const orderDay = new Date(orderCreationDate).toISOString().slice(0, 10);
          const today = new Date().toISOString().slice(0, 10);
          if (orderDay !== today) {
            classificationNote = 'installment_skip';
            reqLogger.info(
              { paymentId, orderId, orderDay, today },
              'Skipping CAPI — installment payment on old order'
            );
            bigQueryClient.insertWebhookLog({
              created_at: new Date().toISOString(),
              payment_id: paymentId,
              contact_id: contactId,
              brand,
              event_name: null,
              subscription_plan_id: null,
              prior_order_count: null,
              order_id: orderId,
              amount: amount ?? null,
              currency,
              raw_transaction_json: JSON.stringify(transaction),
              raw_order_json: rawOrderJson,
              classification_note: classificationNote,
            }).catch(err => {
              reqLogger.error({ err, paymentId }, 'Failed to insert webhook log');
            });
            return contactId;
          }
        }

        const items = order.order_items as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(items)) {
          lineItems = items.map((item) => ({
            id: String(item.id || item.name || 'unknown'),
            quantity: (item.quantity as number) || 1,
            item_price: (item.price as number) || 0,
          }));
        }
        // Check if this order is tied to a subscription plan
        const subPlan = order.subscription_plan as Record<string, unknown> | undefined;
        if (subPlan?.id) {
          subscriptionPlanId = subPlan.id as number;
        } else {
          classificationNote = 'no_subscription_plan';
        }
      }
    } catch (err) {
      reqLogger.warn({ err, orderId }, 'Failed to fetch order details');
    }
  }

  // Determine event name: RecurringPayment if this is a subscription rebill with prior invoices,
  // Purchase otherwise (initial payment or one-time product).
  let eventName = 'Purchase';
  let priorOrderCount: number | null = null;
  if (subscriptionPlanId && contactId) {
    try {
      const contactOrders = await keapClient.getOrdersByContact(contactId, 'PAID');
      const priorSubscriptionOrders = contactOrders.filter((o) => {
        const sp = o.subscription_plan as Record<string, unknown> | undefined;
        return sp?.id === subscriptionPlanId && String(o.id) !== orderId;
      });
      priorOrderCount = priorSubscriptionOrders.length;
      if (priorOrderCount > 0) {
        eventName = 'RecurringPayment';
      }
      reqLogger.info(
        { contactId, subscriptionPlanId, priorCount: priorOrderCount, eventName },
        'Subscription payment classification'
      );
    } catch (err) {
      classificationNote = 'classification_error';
      reqLogger.warn({ err, contactId, subscriptionPlanId }, 'Failed to classify subscription payment — defaulting to Purchase');
    }
  }

  // Log every processed payment for classification debugging
  bigQueryClient.insertWebhookLog({
    created_at: new Date().toISOString(),
    payment_id: paymentId,
    contact_id: contactId,
    brand,
    event_name: eventName,
    subscription_plan_id: subscriptionPlanId,
    prior_order_count: priorOrderCount,
    order_id: orderId,
    amount: amount ?? null,
    currency,
    raw_transaction_json: JSON.stringify(transaction),
    raw_order_json: rawOrderJson,
    classification_note: classificationNote,
  }).catch(err => {
    reqLogger.error({ err, paymentId }, 'Failed to insert webhook log');
  });

  // Build CAPI event
  const hashedUserData = metaCAPIClient.hashUserData({
    em: email,
    fn: firstName,
    ln: lastName,
    ph: phone,
    external_id: contactIdStr,
    ct: city,
    st: state,
    zp: zip,
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
      eventName,
      hasEmail: !!email,
      hasPhone: !!phone,
      hasFbp: !!trackingCtx?.fbp,
      hasFbc: !!trackingCtx?.fbc,
      hasIp: !!trackingCtx?.ip_address,
      hasUa: !!trackingCtx?.user_agent,
    },
    'CAPI event match quality fields'
  );

  const customData: Record<string, unknown> = {};
  if (amount != null) customData.value = amount;
  customData.currency = currency;
  if (orderId) customData.order_id = orderId;
  if (lineItems.length > 0) customData.contents = lineItems;

  // Use transaction ID as event_id for Meta dedup + reconciliation tracking
  const eventId = `purchase_txn_${paymentId}`;

  const capiEvent: MetaCAPIEvent = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    event_source_url: trackingCtx?.source_url || undefined,
    user_data: userData,
    custom_data: customData,
  };

  const queueMetadata: MetaQueueMetadata = {
    source: 'purchase',
    brand,
    eventName,
    email,
    emailHash: hashedUserData.em || null,
    keapContactId: contactIdStr,
    orderId,
    eventId,
    pixelId,
  };

  // Send via durable queue (fire-and-forget from webhook perspective)
  sendMetaWithQueue(queueMetadata, capiEvent).catch(err => {
    reqLogger.error({ err, eventName }, 'Failed to queue CAPI event');
  });

  reqLogger.info(
    { contactId, orderId, pixelId, brand, eventName, hasTrackingContext: !!trackingCtx },
    'CAPI event queued'
  );

  return contactId;
}
