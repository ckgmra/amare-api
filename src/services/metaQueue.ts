import { v4 as uuidv4 } from 'uuid';
import { metaCAPIClient } from './meta.js';
import { bigQueryClient } from './bigquery.js';
import { logger } from '../utils/logger.js';
import type { MetaQueueMetadata, MetaQueueRecord, MetaCAPIEvent, MetaSendResult } from '../types/index.js';

/**
 * Compute next retry time with exponential backoff + jitter.
 * Schedule: min(2^attempt minutes, 60 minutes) + random(0-30s) jitter.
 */
function computeNextAttemptAt(attemptCount: number): string {
  const delayMinutes = Math.min(Math.pow(2, attemptCount), 60);
  const jitterMs = Math.random() * 30000;
  const nextTime = new Date(Date.now() + delayMinutes * 60000 + jitterMs);
  return nextTime.toISOString();
}

/**
 * Record the result of a CAPI send attempt as a new append-only row.
 */
async function recordAttemptResult(
  baseRecord: MetaQueueRecord,
  attemptCount: number,
  outcome: MetaSendResult
): Promise<void> {
  const now = new Date().toISOString();

  let status: MetaQueueRecord['status'];
  let nextAttemptAt: string;

  if (outcome.success) {
    status = 'SENT';
    nextAttemptAt = now;
  } else if (attemptCount >= 6) {
    status = 'DEAD';
    nextAttemptAt = now;
  } else {
    status = 'FAILED';
    nextAttemptAt = computeNextAttemptAt(attemptCount);
  }

  const statusRow: MetaQueueRecord = {
    created_at: baseRecord.created_at,
    updated_at: now,
    queue_id: baseRecord.queue_id,
    source: baseRecord.source,
    brand: baseRecord.brand,
    event_name: baseRecord.event_name,
    email: baseRecord.email,
    email_hash: baseRecord.email_hash,
    keap_contact_id: baseRecord.keap_contact_id,
    order_id: baseRecord.order_id,
    event_id: baseRecord.event_id,
    pixel_id: baseRecord.pixel_id,
    event_time: baseRecord.event_time,
    action_source: baseRecord.action_source,
    event_source_url: baseRecord.event_source_url,
    capi_payload_json: baseRecord.capi_payload_json,
    status,
    attempt_count: attemptCount,
    next_attempt_at: nextAttemptAt,
    last_http_status: outcome.httpStatus || null,
    last_error_message: outcome.error || null,
    last_response_json: outcome.responseJson || null,
    last_latency_ms: outcome.latencyMs,
  };

  await bigQueryClient.insertMetaQueueRow(statusRow);
}

/**
 * Send a Meta CAPI event through the durable queue.
 *
 * 1. Generate queue_id
 * 2. INSERT PENDING row
 * 3. Attempt Meta send immediately
 * 4. INSERT SENT/FAILED row (fire-and-forget)
 */
export async function sendMetaWithQueue(
  metadata: MetaQueueMetadata,
  capiEvent: MetaCAPIEvent
): Promise<MetaSendResult> {
  const queueId = uuidv4();
  const now = new Date().toISOString();
  const capiPayloadJson = JSON.stringify([capiEvent]);

  const baseRecord: MetaQueueRecord = {
    created_at: now,
    updated_at: now,
    queue_id: queueId,
    source: metadata.source,
    brand: metadata.brand,
    event_name: metadata.eventName,
    email: metadata.email || null,
    email_hash: metadata.emailHash || null,
    keap_contact_id: metadata.keapContactId || null,
    order_id: metadata.orderId || null,
    event_id: metadata.eventId || null,
    pixel_id: metadata.pixelId,
    event_time: capiEvent.event_time,
    action_source: capiEvent.action_source,
    event_source_url: capiEvent.event_source_url || null,
    capi_payload_json: capiPayloadJson,
    status: 'PENDING',
    attempt_count: 0,
    next_attempt_at: now,
    last_http_status: null,
    last_error_message: null,
    last_response_json: null,
    last_latency_ms: null,
  };

  // Insert PENDING row
  await bigQueryClient.insertMetaQueueRow(baseRecord);

  // Attempt Meta send immediately
  const accessToken = metaCAPIClient.getAccessToken(metadata.brand);
  if (!accessToken) {
    const result: MetaSendResult = {
      success: false,
      latencyMs: 0,
      error: `No access token for brand: ${metadata.brand}`,
    };
    // Record failure (fire-and-forget)
    recordAttemptResult(baseRecord, 1, result).catch((err) => {
      logger.error({ err, queueId }, 'Failed to record CAPI attempt result');
    });
    return result;
  }

  const result = await metaCAPIClient.sendEvent({
    pixelId: metadata.pixelId,
    accessToken,
    events: [capiEvent as unknown as Record<string, unknown>],
    brand: metadata.brand,
  });

  // Record result (fire-and-forget)
  recordAttemptResult(baseRecord, 1, result).catch((err) => {
    logger.error({ err, queueId }, 'Failed to record CAPI attempt result');
  });

  return result;
}

/**
 * Replay worker that retries failed/pending CAPI events.
 * Runs on an interval, processes up to 50 events per tick.
 */
export function startReplayWorker(): void {
  let isRunning = false;

  const tick = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      const events = await bigQueryClient.getRetryableMetaEvents(50);
      if (events.length === 0) {
        isRunning = false;
        return;
      }

      let sent = 0;
      let failed = 0;

      for (const event of events) {
        try {
          const accessToken = metaCAPIClient.getAccessToken(event.brand);
          if (!accessToken) {
            const result: MetaSendResult = {
              success: false,
              latencyMs: 0,
              error: `No access token for brand: ${event.brand}`,
            };
            await recordAttemptResult(event, event.attempt_count + 1, result);
            failed++;
            continue;
          }

          const capiEvents = JSON.parse(event.capi_payload_json) as Record<string, unknown>[];
          const result = await metaCAPIClient.sendEvent({
            pixelId: event.pixel_id!,
            accessToken,
            events: capiEvents,
            brand: event.brand,
          });

          await recordAttemptResult(event, event.attempt_count + 1, result);
          if (result.success) {
            sent++;
          } else {
            failed++;
          }
        } catch (err) {
          logger.error({ err, queueId: event.queue_id }, 'Replay worker: error processing event');
          failed++;
        }
      }

      logger.info(
        { processed: events.length, sent, failed },
        'Replay worker: tick complete'
      );
    } catch (err) {
      logger.error({ err }, 'Replay worker: tick error');
    } finally {
      isRunning = false;
    }
  };

  // Run every 30 seconds
  setInterval(tick, 30000);
  logger.info('Meta CAPI replay worker started (30s interval)');
}
