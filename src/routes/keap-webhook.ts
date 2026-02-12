import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { bigQueryClient } from '../services/bigquery.js';
import { metaCAPIClient } from '../services/meta.js';
import { sendMetaWithQueue } from '../services/metaQueue.js';
import { logger } from '../utils/logger.js';
import type { MetaCAPIEvent, MetaQueueMetadata, TrackingContextRecord } from '../types/index.js';

const WEBHOOK_SECRET = process.env.KEAP_WEBHOOK_SECRET;

interface InvoicePaymentBody {
  contact_id?: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  line_items?: Array<{
    product_id?: string;
    product_name?: string;
    quantity?: number;
    price?: number;
  }>;
  [key: string]: unknown;
}

export async function keapWebhookRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: InvoicePaymentBody }>(
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
    async (request: FastifyRequest<{ Body: InvoicePaymentBody }>, reply: FastifyReply) => {
      const reqLogger = logger.child({ requestId: request.id });

      // Always return 200 to prevent Keap retries
      const ack = () => reply.send({ received: true });

      // Validate webhook secret
      const secret = request.headers['x-webhook-secret'];
      if (!WEBHOOK_SECRET) {
        reqLogger.error('KEAP_WEBHOOK_SECRET not configured');
        return ack();
      }
      if (secret !== WEBHOOK_SECRET) {
        reqLogger.warn('Invalid webhook secret');
        return ack();
      }

      try {
        const {
          contact_id, email, first_name, last_name, phone,
          order_id, amount, currency, line_items,
        } = request.body;

        reqLogger.info(
          { contact_id, email, order_id, amount },
          'Keap invoice payment webhook received'
        );

        if (!contact_id && !email) {
          reqLogger.warn('No contact_id or email in webhook payload');
          return ack();
        }

        const contactIdStr = contact_id ? String(contact_id) : null;

        // Look up tracking context
        const trackingCtx = await bigQueryClient.lookupTrackingContext(contactIdStr, email || null);

        if (!trackingCtx) {
          reqLogger.info(
            { contact_id, email },
            'No tracking context found for purchase — skipping CAPI'
          );
          return ack();
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
          return ack();
        }

        // Build Purchase CAPI event
        const hashedUserData = metaCAPIClient.hashUserData({
          em: email || trackingCtx.email,
          fn: first_name || null,
          ln: last_name || null,
          ph: phone || null,
          external_id: contactIdStr,
        });

        const userData: Record<string, unknown> = { ...hashedUserData };
        if (trackingCtx.fbp) userData.fbp = trackingCtx.fbp;
        if (trackingCtx.fbc) userData.fbc = trackingCtx.fbc;
        if (trackingCtx.ip_address) userData.client_ip_address = trackingCtx.ip_address;
        if (trackingCtx.user_agent) userData.client_user_agent = trackingCtx.user_agent;

        const customData: Record<string, unknown> = {};
        if (amount != null) customData.value = amount;
        customData.currency = currency || 'USD';
        if (order_id) customData.order_id = order_id;
        if (line_items && line_items.length > 0) {
          customData.contents = line_items.map(item => ({
            id: item.product_id || item.product_name || 'unknown',
            quantity: item.quantity || 1,
            item_price: item.price || 0,
          }));
        }

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
          orderId: order_id || null,
          pixelId: trackingCtx.pixel_id,
        };

        // Send via durable queue (fire-and-forget from webhook perspective)
        sendMetaWithQueue(queueMetadata, capiEvent).catch(err => {
          reqLogger.error({ err }, 'Failed to queue Purchase CAPI event');
        });

        reqLogger.info(
          { contact_id, order_id, pixelId: trackingCtx.pixel_id },
          'Purchase CAPI event queued'
        );

        return ack();
      } catch (error) {
        reqLogger.error({ error }, 'Keap webhook processing error');
        return ack();
      }
    }
  );
}
