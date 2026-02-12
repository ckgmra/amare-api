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
 * - Event: POST with { event_key: string, object_keys: number[] }
 */
interface KeapHookEventBody {
  event_key?: string;
  object_keys?: number[];
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

        // Process each payment ID
        for (const paymentId of object_keys) {
          try {
            await processPayment(paymentId, reqLogger);
          } catch (err) {
            reqLogger.error({ err, paymentId }, 'Error processing payment');
          }
        }

        return ack();
      } catch (error) {
        reqLogger.error({ error }, 'Keap webhook processing error');
        return ack();
      }
    }
  );
}

/**
 * Process a single payment from Keap webhook.
 * Fetches payment details from Keap API, looks up tracking context,
 * and sends a Purchase CAPI event if tracking data exists.
 */
async function processPayment(
  paymentId: number,
  reqLogger: typeof logger
): Promise<void> {
  // Fetch the transaction/payment details from Keap
  const transaction = await keapClient.getTransaction(paymentId);
  if (!transaction) {
    reqLogger.warn({ paymentId }, 'Transaction not found in Keap');
    return;
  }

  reqLogger.info({ paymentId, transaction }, 'Fetched transaction from Keap');

  const contactId = transaction.contact_id as number | undefined;
  const orderIds = transaction.order_ids as number[] | undefined;
  const amount = transaction.amount as number | undefined;
  const currency = (transaction.currency as string) || 'USD';

  if (!contactId) {
    reqLogger.warn({ paymentId }, 'No contact_id in transaction');
    return;
  }

  // Fetch contact details for email + name
  const contact = await keapClient.getContactById(contactId);
  if (!contact) {
    reqLogger.warn({ contactId }, 'Contact not found in Keap');
    return;
  }

  const email = contact.email_addresses?.[0]?.email || null;
  const firstName = contact.given_name || null;
  const lastName = contact.family_name || null;

  reqLogger.info(
    { contactId, email, firstName, paymentId, amount },
    'Processing purchase CAPI event'
  );

  const contactIdStr = String(contactId);

  // Look up tracking context
  const trackingCtx = await bigQueryClient.lookupTrackingContext(contactIdStr, email);

  if (!trackingCtx) {
    reqLogger.info(
      { contactId, email },
      'No tracking context found for purchase — skipping CAPI'
    );
    return;
  }

  // If we found by email but tracking row had no keap_contact_id, backfill
  if (contactIdStr && !trackingCtx.keap_contact_id) {
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

  if (!trackingCtx.pixel_id) {
    reqLogger.info('Tracking context found but no pixel_id — skipping CAPI');
    return;
  }

  // Fetch order details for line items if we have order IDs
  let lineItems: Array<{ id: string; quantity: number; item_price: number }> = [];
  const orderId = orderIds?.[0] ? String(orderIds[0]) : null;

  if (orderIds && orderIds.length > 0) {
    try {
      const order = await keapClient.getOrder(orderIds[0]);
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
      reqLogger.warn({ err, orderId: orderIds[0] }, 'Failed to fetch order details');
    }
  }

  // Build Purchase CAPI event
  const hashedUserData = metaCAPIClient.hashUserData({
    em: email,
    fn: firstName,
    ln: lastName,
    ph: null,
    external_id: contactIdStr,
  });

  const userData: Record<string, unknown> = { ...hashedUserData };
  if (trackingCtx.fbp) userData.fbp = trackingCtx.fbp;
  if (trackingCtx.fbc) userData.fbc = trackingCtx.fbc;
  if (trackingCtx.ip_address) userData.client_ip_address = trackingCtx.ip_address;
  if (trackingCtx.user_agent) userData.client_user_agent = trackingCtx.user_agent;

  const customData: Record<string, unknown> = {};
  if (amount != null) customData.value = amount;
  customData.currency = currency;
  if (orderId) customData.order_id = orderId;
  if (lineItems.length > 0) customData.contents = lineItems;

  const capiEvent: MetaCAPIEvent = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    event_source_url: trackingCtx.source_url || undefined,
    // No event_id for server-only Purchase events
    user_data: userData,
    custom_data: customData,
  };

  const queueMetadata: MetaQueueMetadata = {
    source: 'purchase',
    brand: trackingCtx.brand.toLowerCase(),
    eventName: 'Purchase',
    emailHash: hashedUserData.em || null,
    keapContactId: contactIdStr,
    orderId,
    pixelId: trackingCtx.pixel_id,
  };

  // Send via durable queue (fire-and-forget from webhook perspective)
  sendMetaWithQueue(queueMetadata, capiEvent).catch(err => {
    reqLogger.error({ err }, 'Failed to queue Purchase CAPI event');
  });

  reqLogger.info(
    { contactId, orderId, pixelId: trackingCtx.pixel_id },
    'Purchase CAPI event queued'
  );
}
