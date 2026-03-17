import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { bigQueryClient } from '../services/bigquery.js';

/**
 * GET /product-info?item=<clickbank_product_id>
 *
 * Returns the human-readable product name (fulfillment_trigger_tag) and
 * cc_descriptor for a given ClickBank product ID. Used by thank-you pages
 * to display the correct product name regardless of which upsell was purchased.
 */
export async function productInfoRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/product-info',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['item'],
          properties: {
            item: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              fulfillment_trigger_tag: { type: 'string', nullable: true },
              cc_descriptor: { type: 'string', nullable: true },
            },
          },
          400: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
          404: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: { item: string } }>, reply: FastifyReply) => {
      const { item } = request.query;

      if (!item) {
        return reply.status(400).send({ error: 'Missing required query parameter: item' });
      }

      const info = await bigQueryClient.getProductInfo(item);
      if (!info) {
        return reply.status(404).send({ error: `No product found for item: ${item}` });
      }

      return reply.send(info);
    }
  );
}
