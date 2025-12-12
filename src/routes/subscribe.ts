import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { keapClient } from '../services/keap.js';
import { bigQueryClient } from '../services/bigquery.js';
import { getBrandConfig } from '../config/brands.js';
import { buildCustomFields, SUPPORTED_BRANDS } from '../config/keapFields.js';
import type { SubscribeResponse, SubscriberQueueEntry } from '../types/index.js';
import { logger } from '../utils/logger.js';

/**
 * Subscribe endpoint request body
 *
 * Required fields:
 * - fname: First name
 * - em: Email address
 * - brand: Brand code (chkh, hryw, gkh, flo)
 *
 * Optional fields:
 * - sourceId: Tracking source identifier (e.g., "homepage-popup", "blog-sidebar")
 * - redirectSlug: Custom redirect path after signup
 * - optionalInputs: Additional data to store (JSON string or comma-separated values)
 * - website: Honeypot field - must be empty (bots fill this in)
 */
interface SubscribeBody {
  fname?: string;
  em?: string;
  brand?: string;
  sourceId?: string;
  redirectSlug?: string;
  optionalInputs?: string;
  website?: string; // honeypot
}

export async function subscribeRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: SubscribeBody }>(
    '/subscribe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['fname', 'em', 'brand'],
          properties: {
            fname: { type: 'string', description: 'First name' },
            em: { type: 'string', format: 'email', description: 'Email address' },
            brand: {
              type: 'string',
              enum: [...SUPPORTED_BRANDS],
              description: 'Brand code (chkh, hryw, gkh, flo)',
            },
            sourceId: {
              type: 'string',
              description: 'Tracking source identifier (e.g., homepage-popup)',
            },
            redirectSlug: {
              type: 'string',
              description: 'Custom redirect path after signup',
            },
            optionalInputs: {
              type: 'string',
              description: 'Additional data to store',
            },
            website: {
              type: 'string',
              description: 'Honeypot field - must be empty',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              redirectUrl: { type: 'string' },
            },
          },
          400: {
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

      try {
        const { fname, em, brand, sourceId, redirectSlug, optionalInputs, website } = request.body;

        // Honeypot check - reject if website field has any value
        if (website) {
          reqLogger.warn({ website }, 'Honeypot triggered');
          return reply.status(400).send({
            success: false,
            error: 'Invalid submission',
          } satisfies SubscribeResponse);
        }

        // Validate required fields
        if (!fname || !em || !brand) {
          return reply.status(400).send({
            success: false,
            error: 'Missing required fields: fname, em, brand',
          } satisfies SubscribeResponse);
        }

        // Get brand configuration
        const brandConfig = getBrandConfig(brand);
        if (!brandConfig) {
          reqLogger.warn({ brand }, 'Unknown brand');
          return reply.status(400).send({
            success: false,
            error: `Unknown brand: ${brand}. Supported brands: ${SUPPORTED_BRANDS.join(', ')}`,
          } satisfies SubscribeResponse);
        }

        // Extract request metadata
        const forwardedFor = request.headers['x-forwarded-for'];
        const ipAddress = Array.isArray(forwardedFor)
          ? forwardedFor[0]
          : forwardedFor?.split(',')[0]?.trim() || request.ip;
        const sourceUrl = (request.headers['referer'] as string) || null;
        const userAgent = (request.headers['user-agent'] as string) || null;
        const now = new Date().toISOString();

        // Create queue entry
        const queueEntry: SubscriberQueueEntry = {
          id: uuidv4(),
          email: em,
          first_name: fname,
          brand: brand.toUpperCase(),
          dp_source_id: sourceId || null,
          dp_ip_address: ipAddress,
          dp_first_upload_time: now,
          dp_optional_inputs: optionalInputs || null,
          redirect_slug: redirectSlug || null,
          source_url: sourceUrl,
          user_agent: userAgent,
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
          {
            queueId: queueEntry.id,
            email: em,
            brand: brandConfig.brandCode,
            sourceId,
            ipAddress,
          },
          'Subscriber queued'
        );

        // Now attempt to process immediately
        let contactId: number | null = null;
        let tagsApplied: number[] = [];
        let processingError: string | null = null;

        try {
          // Build custom fields for Keap (with brand suffix logic)
          const customFields = buildCustomFields(brand, {
            sourceId,
            ipAddress,
            optionalInputs,
            firstUploadTime: now,
          });

          // Create or update contact in Keap
          const contact = await keapClient.createOrUpdateContact(em, fname, customFields);
          contactId = contact.id;

          // Apply signup tags
          if (brandConfig.signupTagIds.length > 0) {
            await keapClient.applyTags(contact.id, brandConfig.signupTagIds);
            tagsApplied = brandConfig.signupTagIds;
          }

          reqLogger.info(
            { contactId, tagsApplied },
            'Keap processing completed'
          );
        } catch (keapError) {
          // Keap failed - subscriber is queued, will retry later
          processingError = keapError instanceof Error ? keapError.message : 'Keap processing failed';
          reqLogger.warn({ error: keapError, queueId: queueEntry.id }, 'Keap processing failed, subscriber queued for retry');
        }

        // Update queue entry with processing result
        await bigQueryClient.updateSubscriberStatus(
          queueEntry.id,
          contactId,
          tagsApplied,
          processingError
        );

        // Build redirect URL
        const redirectUrl = redirectSlug || brandConfig.defaultRedirect;

        // Always return success to the user (their submission is saved)
        return reply.send({
          success: true,
          redirectUrl,
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
