import 'dotenv/config';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { v4 as uuidv4 } from 'uuid';

import { subscribeRoutes } from './routes/subscribe.js';
import { clickbankRoutes } from './routes/clickbank.js';
import { keapWebhookRoutes } from './routes/keap-webhook.js';
import { productInfoRoutes } from './routes/product-info.js';
import { keapClient } from './services/keap.js';
import { bigQueryClient } from './services/bigquery.js';
import { startReplayWorker } from './services/metaQueue.js';
import { logger } from './utils/logger.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

async function buildApp() {
  const fastify = Fastify({
    logger: false, // We use our own pino logger
    genReqId: () => uuidv4(),
  });

  // CORS configuration
  const corsOrigins = process.env.CORS_ORIGINS?.split(',').map((origin) => origin.trim()) || [];

  await fastify.register(cors, {
    origin: NODE_ENV === 'development' ? true : corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Webhook-Secret'],
    credentials: true,
  });

  // Rate limiting for subscribe endpoint
  await fastify.register(rateLimit, {
    max: 10,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const forwardedFor = request.headers['x-forwarded-for'];
      const ip = Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : forwardedFor?.split(',')[0]?.trim() || request.ip;
      return ip;
    },
    skipOnError: true,
    // Only apply rate limiting to /subscribe
    allowList: (request) => {
      return !request.url.startsWith('/subscribe');
    },
  });

  // Request logging hook
  fastify.addHook('onRequest', async (request) => {
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        ip: request.ip,
      },
      'Incoming request'
    );
  });

  // Response logging hook
  fastify.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        requestId: request.id,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request completed'
    );
  });

  // Health check endpoint
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register routes
  await fastify.register(subscribeRoutes);
  await fastify.register(clickbankRoutes);
  await fastify.register(keapWebhookRoutes);
  await fastify.register(productInfoRoutes);

  // Admin endpoints for managing Keap REST hooks
  // All require X-API-Key header matching SUBSCRIBE_API_KEY

  const adminAuth = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const apiKey = request.headers['x-api-key'];
    if (!process.env.SUBSCRIBE_API_KEY || apiKey !== process.env.SUBSCRIBE_API_KEY) {
      reply.status(401).send({ error: 'Unauthorized' });
      return false;
    }
    return true;
  };

  const keapErrMsg = (err: unknown): string => {
    const e = err as { response?: { data?: unknown; status?: number }; message?: string };
    if (e.response?.data) return `Keap ${e.response.status}: ${JSON.stringify(e.response.data)}`;
    return e.message || String(err);
  };

  fastify.get('/admin/keap-hooks', async (request, reply) => {
    if (!adminAuth(request, reply)) return;
    try {
      return reply.send(await keapClient.listHooks());
    } catch (err) {
      return reply.status(502).send({ error: keapErrMsg(err) });
    }
  });

  fastify.post('/admin/create-hook', async (request, reply) => {
    if (!adminAuth(request, reply)) return;
    try {
      const { eventKey, hookUrl } = request.body as Record<string, string>;
      return reply.send(await keapClient.createHook(eventKey, hookUrl));
    } catch (err) {
      return reply.status(502).send({ error: keapErrMsg(err) });
    }
  });

  fastify.delete('/admin/keap-hooks/:hookId', async (request, reply) => {
    if (!adminAuth(request, reply)) return;
    try {
      const { hookId } = request.params as Record<string, string>;
      await keapClient.deleteHook(Number(hookId));
      return reply.send({ deleted: true });
    } catch (err) {
      return reply.status(502).send({ error: keapErrMsg(err) });
    }
  });

  fastify.post('/admin/verify-hook', async (request, reply) => {
    if (!adminAuth(request, reply)) return;
    try {
      const { hookKey } = request.body as Record<string, number>;
      return reply.send(await keapClient.verifyHook(hookKey));
    } catch (err) {
      return reply.status(502).send({ error: keapErrMsg(err) });
    }
  });

  // Error handler
  fastify.setErrorHandler((error, request, reply) => {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error(
      {
        requestId: request.id,
        error: errorMessage,
        stack: errorStack,
      },
      'Request error'
    );

    // Don't expose internal errors to clients
    const errorObj = error as { statusCode?: number };
    const statusCode = errorObj.statusCode ?? 500;
    if (statusCode < 500) {
      return reply.status(statusCode).send({
        success: false,
        error: errorMessage,
      });
    }

    return reply.status(500).send({
      success: false,
      error: 'Internal server error',
    });
  });

  return fastify;
}

async function main() {
  try {
    logger.info({ env: NODE_ENV }, 'Starting Amare API');

    // Ensure BigQuery tables exist (non-blocking in production)
    if (NODE_ENV !== 'development') {
      bigQueryClient.ensureTablesExist().catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        logger.warn({ error: errMsg }, 'Failed to ensure BigQuery tables exist');
      });
    }

    const app = await buildApp();

    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info({ port: PORT }, `Server listening on port ${PORT}`);

    // Start Meta CAPI replay worker (production only)
    if (NODE_ENV !== 'development') {
      startReplayWorker();
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errMsg }, 'Failed to start server');
    process.exit(1);
  }
}

main();
