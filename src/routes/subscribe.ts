import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { keapClient } from '../services/keap.js';
import { bigQueryClient } from '../services/bigquery.js';
import { SUPPORTED_BRANDS } from '../config/keapFields.js';
import { sendMetaWithQueue } from '../services/metaQueue.js';
import { metaCAPIClient } from '../services/meta.js';
import type { SubscriberQueueEntry, TrackingContextRecord, MetaCAPIEvent, MetaQueueMetadata } from '../types/index.js';
import { logger } from '../utils/logger.js';

// API key for authenticating requests from brand sites
const API_KEY = process.env.SUBSCRIBE_API_KEY;

/**
 * Subscribe endpoint request body
 *
 * Required fields:
 * - email: Email address
 * - firstName: First name
 * - brand: Brand code (chkh, hryw, gkh, flo)
 * - tag: Keap tag name to apply (e.g., "HRYW-WebSub")
 *
 * Optional fields:
 * - customFields: Object with Keap field names as keys (passed through to Keap)
 */
interface SubscribeBody {
  email: string;
  firstName: string;
  brand: string;
  tag: string;
  customFields?: Record<string, string>;
  sourceUrl?: string;
  redirectSlug?: string;
  eventId?: string;
  fbp?: string;
  fbc?: string;
  fbclid?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  pixelId?: string;
  userAgent?: string;
}

interface SubscribeResponse {
  success: boolean;
  error?: string;
}

export async function subscribeRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: SubscribeBody }>(
    '/subscribe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'firstName', 'brand', 'tag'],
          properties: {
            email: { type: 'string', format: 'email' },
            firstName: { type: 'string' },
            brand: { type: 'string', enum: [...SUPPORTED_BRANDS] },
            tag: { type: 'string', description: 'Keap tag name to apply' },
            customFields: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Keap custom fields (field name → value)',
            },
            sourceUrl: { type: 'string', description: 'Original page URL where form was submitted' },
            redirectSlug: { type: 'string', description: 'Redirect path after signup (for forensic tracking)' },
            eventId: { type: 'string', description: 'Event ID for Meta deduplication' },
            fbp: { type: 'string', description: 'Meta _fbp cookie value' },
            fbc: { type: 'string', description: 'Meta _fbc cookie value' },
            fbclid: { type: 'string', description: 'Facebook click ID from URL' },
            utm_source: { type: 'string' },
            utm_medium: { type: 'string' },
            utm_campaign: { type: 'string' },
            utm_content: { type: 'string' },
            utm_term: { type: 'string' },
            pixelId: { type: 'string', description: 'Meta pixel ID for this brand' },
            userAgent: { type: 'string', description: 'Browser user agent string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
            },
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
          401: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: SubscribeBody }>, reply: FastifyReply) => {
      const requestId = request.id;
      const reqLogger = logger.child({ requestId });

      // Validate API key
      const apiKey = request.headers['x-api-key'];
      if (!API_KEY) {
        reqLogger.error('SUBSCRIBE_API_KEY not configured');
        return reply.status(500).send({
          success: false,
          error: 'Server configuration error',
        } satisfies SubscribeResponse);
      }

      if (apiKey !== API_KEY) {
        reqLogger.warn({ providedKey: apiKey ? 'present' : 'missing' }, 'Invalid API key');
        return reply.status(401).send({
          success: false,
          error: 'Unauthorized',
        } satisfies SubscribeResponse);
      }

      try {
        const {
          email, firstName, brand, tag, customFields, sourceUrl, redirectSlug,
          eventId, fbp, fbc, fbclid,
          utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          pixelId, userAgent: browserUA,
        } = request.body;

        // Store raw payload for debugging
        const rawPayload = JSON.stringify(request.body);

        // Validate required fields
        if (!email || !firstName || !brand || !tag) {
          return reply.status(400).send({
            success: false,
            error: 'Missing required fields: email, firstName, brand, tag',
          } satisfies SubscribeResponse);
        }

        // Validate brand
        if (!SUPPORTED_BRANDS.includes(brand.toLowerCase() as any)) {
          return reply.status(400).send({
            success: false,
            error: `Unknown brand: ${brand}. Supported: ${SUPPORTED_BRANDS.join(', ')}`,
          } satisfies SubscribeResponse);
        }

        // Extract request metadata
        const forwardedFor = request.headers['x-forwarded-for'];
        const ipAddress = Array.isArray(forwardedFor)
          ? forwardedFor[0]
          : forwardedFor?.split(',')[0]?.trim() || request.ip;
        // Use sourceUrl from body (passed from frontend) or fall back to referer header
        const resolvedSourceUrl = sourceUrl || (request.headers['referer'] as string) || null;
        const userAgent = (request.headers['user-agent'] as string) || null;
        const now = new Date().toISOString();

        // Create queue entry
        const queueEntry: SubscriberQueueEntry = {
          id: uuidv4(),
          email,
          first_name: firstName,
          brand: brand.toUpperCase(),
          dp_source_id: customFields?.['DP_SOURCE_ID_' + brand.toUpperCase()] || null,
          dp_ip_address: customFields?.['DP_IP_ADDRESS'] || ipAddress,
          dp_first_upload_time: customFields?.['DP_FIRST_UPLOAD_TIME_' + brand.toUpperCase()] || now,
          dp_optional_inputs: customFields?.['DP_OPTIONAL_INPUTS_' + brand.toUpperCase()] || null,
          redirect_slug: redirectSlug || null, // For forensic tracking of subscriber journey
          source_url: resolvedSourceUrl,
          user_agent: userAgent,
          raw_payload: rawPayload,
          tag_name: tag,
          is_processed: false,
          keap_contact_id: null,
          tags_applied: [],
          processing_error: null,
          created_at: now,
          processed_at: null,
        };

        // Queue to BigQuery first (ensures we never lose a submission)
        await bigQueryClient.queueSubscriber(queueEntry);

        reqLogger.info(
          { queueId: queueEntry.id, email, brand, tag },
          'Subscriber queued'
        );

        // Now attempt to process immediately
        let contactId: number | null = null;
        let processingError: string | null = null;
        let tagsApplied: string[] = [];

        try {
          // Create or update contact in Keap with custom fields passed through
          const contact = await keapClient.createOrUpdateContactWithFields(
            email,
            firstName,
            customFields || {}
          );
          contactId = contact.id;

          // Apply tags - support pipe-delimited multiple tags (e.g., "HRYW-WebSub|HRYW-Clickbank-Lead")
          const tagNames = tag.split('|').map(t => t.trim()).filter(t => t.length > 0);
          for (const tagName of tagNames) {
            await keapClient.applyTagByName(contact.id, tagName);
            tagsApplied.push(tagName);
          }

          // Opt-in the contact for email marketing
          // This is REQUIRED for them to receive welcome emails and marketing
          await keapClient.optInEmail(email, 'Website signup form');

          reqLogger.info(
            { contactId, tags: tagsApplied },
            'Keap processing completed'
          );
        } catch (keapError) {
          // Keap failed - subscriber is queued, will retry later
          processingError = keapError instanceof Error ? keapError.message : 'Keap processing failed';
          reqLogger.warn(
            { error: keapError, queueId: queueEntry.id },
            'Keap processing failed, subscriber queued for retry'
          );
        }

        // Record processing result to BigQuery (append-only, no streaming buffer issues)
        // Fire and forget - don't make client wait
        bigQueryClient.updateSubscriberStatus(
          queueEntry.id,
          contactId,
          tagsApplied,
          processingError
        ).catch(bqError => {
          reqLogger.error({ queueId: queueEntry.id, error: bqError }, 'Failed to record processing result');
        });

        // Insert tracking context + send Meta CAPI (fire-and-forget)
        const trackingBlock = async () => {
          try {
            const keapContactIdStr = contactId ? String(contactId) : null;

            // Insert tracking context row
            const trackingRecord: TrackingContextRecord = {
              created_at: now,
              brand: brand.toUpperCase(),
              email,
              keap_contact_id: keapContactIdStr,
              pixel_id: pixelId || null,
              fbp: fbp || null,
              fbc: fbc || null,
              fbclid: fbclid || null,
              event_id: eventId || null,
              utm_source: utm_source || null,
              utm_medium: utm_medium || null,
              utm_campaign: utm_campaign || null,
              utm_content: utm_content || null,
              utm_term: utm_term || null,
              source_url: resolvedSourceUrl,
              user_agent: browserUA || userAgent,
              ip_address: ipAddress,
            };
            await bigQueryClient.insertTrackingContext(trackingRecord);

            // Send Meta CAPI Subscribe event
            // Use pixelId from frontend, or fall back to env var for the brand
            const resolvedPixelId = pixelId || metaCAPIClient.getPixelId(brand);
            if (resolvedPixelId) {
              // Enrich with Keap contact data if available (last name, phone, address)
              let lastName: string | null = null;
              let phone: string | null = null;
              let city: string | null = null;
              let state: string | null = null;
              let zip: string | null = null;
              if (contactId) {
                try {
                  const keapContact = await keapClient.getContactById(contactId);
                  if (keapContact) {
                    lastName = keapContact.family_name || null;
                    const kc = keapContact as unknown as Record<string, unknown>;
                    phone = kc.phone1 as string || null;
                    const addresses = kc.addresses as Array<Record<string, unknown>> | undefined;
                    const addr = addresses?.[0];
                    if (addr) {
                      city = (addr.locality as string) || null;
                      state = (addr.region as string) || null;
                      zip = (addr.zip_code as string) || (addr.postal_code as string) || null;
                    }
                  }
                } catch {
                  // Non-critical — proceed without extra fields
                }
              }

              const hashedUserData = metaCAPIClient.hashUserData({
                em: email,
                fn: firstName,
                ln: lastName,
                ph: phone,
                external_id: keapContactIdStr,
                ct: city,
                st: state,
                zp: zip,
              });
              const userData: Record<string, unknown> = { ...hashedUserData };
              if (fbp) userData.fbp = fbp;
              if (fbc) userData.fbc = fbc;
              if (ipAddress) userData.client_ip_address = ipAddress;
              if (browserUA || userAgent) userData.client_user_agent = browserUA || userAgent;

              const capiEvent: MetaCAPIEvent = {
                event_name: 'Subscribe',
                event_time: Math.floor(Date.now() / 1000),
                action_source: 'website',
                event_source_url: resolvedSourceUrl || undefined,
                event_id: eventId || undefined,
                user_data: userData,
              };

              const queueMetadata: MetaQueueMetadata = {
                source: 'subscribe',
                brand: brand.toLowerCase(),
                eventName: 'Subscribe',
                email,
                emailHash: hashedUserData.em || null,
                keapContactId: keapContactIdStr,
                eventId: eventId || null,
                pixelId: resolvedPixelId,
              };

              await sendMetaWithQueue(queueMetadata, capiEvent);
            }
          } catch (err) {
            reqLogger.error({ err }, 'Tracking context / Meta CAPI failed');
          }
        };
        trackingBlock().catch(err => {
          reqLogger.error({ err }, 'Tracking block error');
        });

        // Return success immediately
        return reply.send({
          success: true,
        } satisfies SubscribeResponse);
      } catch (error) {
        reqLogger.error({ error }, 'Subscribe request failed');
        return reply.status(500).send({
          success: false,
          error: 'An error occurred processing your request',
        } satisfies SubscribeResponse);
      }
    }
  );
}
