import { BigQuery } from '@google-cloud/bigquery';
import type { TagAction, ClickbankTransaction, SubscriberQueueEntry, TrackingContextRecord, MetaQueueRecord, KeapWebhookLogRecord } from '../types/index.js';
import { logger } from '../utils/logger.js';

class BigQueryClient {
  private client: BigQuery;
  private projectId: string;
  private dataset: string;
  private productTagsTable: string;
  private transactionsTable: string;
  private subscriberQueueTable: string;
  private subscriberResultsTable: string;
  private trackingContextTable: string;
  private metaCapiQueueTable: string;

  constructor() {
    this.projectId = process.env.GCP_PROJECT_ID || 'watchful-force-477418-b9';
    this.dataset = process.env.BIGQUERY_DATASET || 'keap_integration';
    this.productTagsTable = process.env.BIGQUERY_TABLE_PRODUCT_TAGS || 'clickbank_product_tags';
    this.transactionsTable =
      process.env.BIGQUERY_TABLE_TRANSACTIONS || 'clickbank_transactions';
    this.subscriberQueueTable =
      process.env.BIGQUERY_TABLE_SUBSCRIBER_QUEUE || 'subscriber_queue';
    this.subscriberResultsTable = 'subscriber_processing_results';
    this.trackingContextTable = 'tracking_context';
    this.metaCapiQueueTable = 'meta_capi_queue';

    this.client = new BigQuery({
      projectId: this.projectId,
    });
  }

  /**
   * Get tag actions for a product and transaction type
   *
   * Returns array of action objects where action is 'apply_tag' or 'apply_note'
   * Supports pipe-delimited transaction types (e.g., 'SALE|TEST_SALE')
   * Matches if transactionType is in the pipe-delimited list
   */
  async getTagActionsForProduct(
    productId: string,
    transactionType: string
  ): Promise<TagAction[]> {
    try {
      // Query using LIKE with pipe delimiters to match
      // e.g., transaction_type 'SALE' matches row with 'SALE|TEST_SALE|REBILL'
      const query = `
        SELECT action, keap_tag_id, keap_tag_category, fulfillment_trigger_tag
        FROM \`${this.projectId}.${this.dataset}.${this.productTagsTable}\`
        WHERE clickbank_product_id = @productId
          AND (
            transaction_type = @transactionType
            OR transaction_type LIKE CONCAT(@transactionType, '|%')
            OR transaction_type LIKE CONCAT('%|', @transactionType, '|%')
            OR transaction_type LIKE CONCAT('%|', @transactionType)
          )
          AND active = true
      `;

      const [rows] = await this.client.query({
        query,
        params: { productId, transactionType },
      });

      const tagActions: TagAction[] = rows.map(
        (row: {
          action: string;
          keap_tag_id: number;
          keap_tag_category?: string;
          fulfillment_trigger_tag?: string;
        }) => ({
          action: row.action as 'apply_tag' | 'apply_note',
          tagId: row.keap_tag_id,
          tagCategory: row.keap_tag_category,
          triggerTag: row.fulfillment_trigger_tag,
        })
      );

      logger.info(
        { productId, transactionType, tagActions },
        'Retrieved tag actions for product'
      );
      return tagActions;
    } catch (error) {
      logger.error({ error, productId, transactionType }, 'Failed to get tag actions for product');
      return [];
    }
  }

  /**
   * Log a Clickbank transaction to BigQuery
   *
   * This is the main transaction log that tracks:
   * - All transaction details (receipt, email, product, amount, etc.)
   * - Affiliate information (for reporting, not as Keap tags)
   * - Tags applied/removed
   * - Processing status
   */
  async logTransaction(transaction: ClickbankTransaction): Promise<void> {
    try {
      const tableRef = this.client.dataset(this.dataset).table(this.transactionsTable);

      await tableRef.insert([transaction]);
      logger.info(
        { receipt: transaction.receipt, status: transaction.processing_status },
        'Transaction logged to BigQuery'
      );
    } catch (error) {
      const bqError = error as { errors?: Array<{ errors: unknown[] }> };
      if (bqError.errors) {
        logger.error({ errors: bqError.errors }, 'BigQuery transaction insert errors');
      } else {
        logger.error({ error }, 'Failed to log transaction to BigQuery');
      }
    }
  }

  /**
   * Queue a subscriber for processing
   * Returns the queue entry ID for tracking
   */
  async queueSubscriber(entry: SubscriberQueueEntry): Promise<string> {
    try {
      const tableRef = this.client.dataset(this.dataset).table(this.subscriberQueueTable);

      await tableRef.insert([entry]);
      logger.info({ id: entry.id, email: entry.email, brand: entry.brand }, 'Subscriber queued');
      return entry.id;
    } catch (error) {
      const bqError = error as { errors?: Array<{ errors: unknown[] }> };
      if (bqError.errors) {
        logger.error({ errors: bqError.errors }, 'BigQuery subscriber queue insert errors');
      } else {
        logger.error({ error }, 'Failed to queue subscriber');
      }
      throw error;
    }
  }

  /**
   * Record subscriber processing result (append-only pattern)
   *
   * Instead of UPDATE (which fails on streaming buffer), we INSERT to a
   * separate results table. Use the subscriber_with_status view to see
   * the combined data.
   */
  async updateSubscriberStatus(
    id: string,
    keapContactId: number | null,
    tagsApplied: string[],
    error: string | null
  ): Promise<void> {
    try {
      const tableRef = this.client.dataset(this.dataset).table(this.subscriberResultsTable);

      const resultRecord = {
        subscriber_id: id,
        keap_contact_id: keapContactId,
        tags_applied: tagsApplied,
        processing_error: error,
        is_success: !error,
        processed_at: new Date().toISOString(),
      };

      await tableRef.insert([resultRecord]);
      logger.info({ id, keapContactId, tagsApplied, success: !error }, 'Subscriber processing result recorded');
    } catch (err) {
      const bqError = err as { errors?: Array<{ errors: unknown[] }> };
      if (bqError.errors) {
        logger.error({ errors: bqError.errors, id }, 'BigQuery result insert errors');
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error({ error: errorMessage, id }, 'Failed to record subscriber processing result');
      }
    }
  }

  /**
   * Get unprocessed subscribers for retry processing
   *
   * Uses LEFT JOIN with results table to find subscribers that don't
   * have a processing result yet (append-only pattern).
   */
  async getUnprocessedSubscribers(limit: number = 100): Promise<SubscriberQueueEntry[]> {
    try {
      const query = `
        SELECT q.*
        FROM \`${this.projectId}.${this.dataset}.${this.subscriberQueueTable}\` q
        LEFT JOIN \`${this.projectId}.${this.dataset}.${this.subscriberResultsTable}\` r
          ON q.id = r.subscriber_id
        WHERE r.subscriber_id IS NULL
        ORDER BY q.created_at ASC
        LIMIT @limit
      `;

      const [rows] = await this.client.query({
        query,
        params: { limit },
      });

      return rows as SubscriberQueueEntry[];
    } catch (error) {
      logger.error({ error }, 'Failed to get unprocessed subscribers');
      return [];
    }
  }

  /**
   * Get unprocessed transactions for retry processing
   */
  async getUnprocessedTransactions(limit: number = 100): Promise<ClickbankTransaction[]> {
    try {
      const query = `
        SELECT *
        FROM \`${this.projectId}.${this.dataset}.${this.transactionsTable}\`
        WHERE is_processed = false
        ORDER BY created_at ASC
        LIMIT @limit
      `;

      const [rows] = await this.client.query({
        query,
        params: { limit },
      });

      return rows as ClickbankTransaction[];
    } catch (error) {
      logger.error({ error }, 'Failed to get unprocessed transactions');
      return [];
    }
  }

  /**
   * Update transaction status after processing
   */
  async updateTransactionStatus(
    id: string,
    keapContactId: number | null,
    tagsApplied: number[],
    tagsRemoved: number[],
    error: string | null
  ): Promise<void> {
    try {
      const query = `
        UPDATE \`${this.projectId}.${this.dataset}.${this.transactionsTable}\`
        SET is_processed = true,
            keap_contact_id = @keapContactId,
            tags_applied = @tagsApplied,
            tags_removed = @tagsRemoved,
            processing_status = @status,
            error_message = @error,
            processed_at = CURRENT_TIMESTAMP()
        WHERE id = @id
      `;

      const status = error ? 'FAILED' : 'SUCCESS';

      await this.client.query({
        query,
        params: { id, keapContactId, tagsApplied, tagsRemoved, status, error },
      });

      logger.info({ id, keapContactId, success: !error }, 'Transaction status updated');
    } catch (err) {
      logger.error({ error: err, id }, 'Failed to update transaction status');
    }
  }

  /**
   * Insert a tracking context record (append-only).
   * Fire-and-forget — caller should .catch() errors.
   */
  async insertTrackingContext(record: TrackingContextRecord): Promise<void> {
    try {
      const tableRef = this.client.dataset(this.dataset).table(this.trackingContextTable);
      await tableRef.insert([record]);
      logger.info({ email: record.email, brand: record.brand }, 'Tracking context inserted');
    } catch (error) {
      const bqError = error as { errors?: Array<{ errors: unknown[] }> };
      if (bqError.errors) {
        logger.error({ errors: bqError.errors }, 'BigQuery tracking context insert errors');
      } else {
        logger.error({ error }, 'Failed to insert tracking context');
      }
    }
  }

  /**
   * Look up tracking context for a contact.
   * Step 1: by keap_contact_id (WHERE pixel_id IS NOT NULL).
   * Step 2: fallback by email.
   * Returns null if nothing found.
   */
  async lookupTrackingContext(
    keapContactId: string | null,
    email: string | null
  ): Promise<TrackingContextRecord | null> {
    try {
      // Step 1: Try by keap_contact_id
      if (keapContactId) {
        const query1 = `
          SELECT *
          FROM \`${this.projectId}.${this.dataset}.${this.trackingContextTable}\`
          WHERE keap_contact_id = @keapContactId
            AND pixel_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
        `;
        const [rows1] = await this.client.query({
          query: query1,
          params: { keapContactId },
        });
        if (rows1.length > 0) {
          return rows1[0] as TrackingContextRecord;
        }
      }

      // Step 2: Fallback by email
      if (email) {
        const query2 = `
          SELECT *
          FROM \`${this.projectId}.${this.dataset}.${this.trackingContextTable}\`
          WHERE email = @email
            AND pixel_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
        `;
        const [rows2] = await this.client.query({
          query: query2,
          params: { email },
        });
        if (rows2.length > 0) {
          return rows2[0] as TrackingContextRecord;
        }
      }

      return null;
    } catch (error) {
      logger.error({ error, keapContactId, email }, 'Failed to lookup tracking context');
      return null;
    }
  }

  /**
   * Get the set of Keap transaction IDs we've already processed (sent to Meta CAPI).
   * Purchase events store event_id as "purchase_txn_{transactionId}".
   * Returns a Set of transaction ID strings (just the numeric part).
   */
  async getRecentlyProcessedTransactionIds(minutesBack: number = 30): Promise<Set<string>> {
    try {
      const query = `
        SELECT DISTINCT event_id
        FROM \`${this.projectId}.${this.dataset}.${this.metaCapiQueueTable}\`
        WHERE source = 'purchase'
          AND event_id IS NOT NULL
          AND event_id LIKE 'purchase_txn_%'
          AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${minutesBack} MINUTE)
      `;
      const [rows] = await this.client.query({ query });
      return new Set(rows.map((r: Record<string, unknown>) => {
        const eventId = String(r.event_id);
        // Extract transaction ID from "purchase_txn_845325" → "845325"
        return eventId.replace('purchase_txn_', '');
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get recently processed transaction IDs');
      return new Set();
    }
  }

  /**
   * Insert a meta CAPI queue row (append-only).
   * Used for both initial PENDING and subsequent status rows.
   */
  async insertMetaQueueRow(record: MetaQueueRecord): Promise<void> {
    try {
      const tableRef = this.client.dataset(this.dataset).table(this.metaCapiQueueTable);
      await tableRef.insert([record]);
      logger.info(
        { queueId: record.queue_id, status: record.status, attempt: record.attempt_count },
        'Meta CAPI queue row inserted'
      );
    } catch (error) {
      const bqError = error as { errors?: Array<{ errors: unknown[] }> };
      if (bqError.errors) {
        logger.error({ errors: bqError.errors }, 'BigQuery meta queue insert errors');
      } else {
        logger.error({ error }, 'Failed to insert meta queue row');
      }
    }
  }

  /**
   * Get retryable meta CAPI events.
   * Uses WITH latest AS (ARRAY_AGG ... ORDER BY updated_at DESC LIMIT 1) pattern
   * to find the most recent status for each queue_id.
   */
  async getRetryableMetaEvents(limit: number = 50): Promise<MetaQueueRecord[]> {
    try {
      const query = `
        WITH latest AS (
          SELECT AS VALUE ARRAY_AGG(t ORDER BY updated_at DESC LIMIT 1)[OFFSET(0)]
          FROM \`${this.projectId}.${this.dataset}.${this.metaCapiQueueTable}\` t
          GROUP BY queue_id
        )
        SELECT * FROM latest
        WHERE status IN ('PENDING', 'FAILED')
          AND next_attempt_at <= CURRENT_TIMESTAMP()
        ORDER BY next_attempt_at ASC
        LIMIT @limit
      `;

      const [rows] = await this.client.query({
        query,
        params: { limit },
      });

      return rows as MetaQueueRecord[];
    } catch (error) {
      logger.error({ error }, 'Failed to get retryable meta events');
      return [];
    }
  }

  /**
   * Look up brand for a contact by email (from subscriber_queue).
   * Returns the most recent brand, or null if never subscribed.
   */
  async lookupBrandByEmail(email: string): Promise<string | null> {
    try {
      const query = `
        SELECT brand
        FROM \`${this.projectId}.${this.dataset}.${this.subscriberQueueTable}\`
        WHERE email = @email
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const [rows] = await this.client.query({
        query,
        params: { email },
      });
      if (rows.length > 0) {
        return rows[0].brand as string;
      }
      return null;
    } catch (error) {
      logger.error({ error, email }, 'Failed to lookup brand by email');
      return null;
    }
  }

  /**
   * Insert a keap webhook log row for classification debugging.
   * Fire-and-forget — caller should .catch() errors.
   */
  async insertWebhookLog(record: KeapWebhookLogRecord): Promise<void> {
    try {
      const tableRef = this.client.dataset(this.dataset).table('keap_webhook_log');
      await tableRef.insert([record]);
      logger.info(
        { paymentId: record.payment_id, eventName: record.event_name, subscriptionPlanId: record.subscription_plan_id },
        'Webhook log row inserted'
      );
    } catch (error) {
      const bqError = error as { errors?: Array<{ errors: unknown[] }> };
      if (bqError.errors) {
        logger.error({ errors: bqError.errors }, 'BigQuery webhook log insert errors');
      } else {
        logger.error({ error }, 'Failed to insert webhook log row');
      }
    }
  }

  async ensureTablesExist(): Promise<void> {
    try {
      const dataset = this.client.dataset(this.dataset);

      // Check if dataset exists, create if not
      const [datasetExists] = await dataset.exists();
      if (!datasetExists) {
        await dataset.create();
        logger.info({ dataset: this.dataset }, 'Created BigQuery dataset');
      }

      // Product tags table schema (redesigned for fulfillment tracking)
      const productTagsSchema = [
        { name: 'clickbank_product_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'brand', type: 'STRING', mode: 'REQUIRED' },
        { name: 'transaction_type', type: 'STRING', mode: 'REQUIRED' }, // Pipe-delimited: 'SALE|TEST_SALE'
        { name: 'action', type: 'STRING', mode: 'REQUIRED' }, // 'apply_tag' or 'apply_note'
        { name: 'fulfillment_trigger_tag', type: 'STRING', mode: 'NULLABLE' }, // Human-readable tag name or ADDNOTE: text
        { name: 'keap_tag_id', type: 'INTEGER', mode: 'REQUIRED' }, // Keap numeric tag ID (0 for notes)
        { name: 'keap_tag_category', type: 'STRING', mode: 'NULLABLE' }, // e.g., 'CustomerHub', 'Products Purchased'
        { name: 'active', type: 'BOOLEAN', mode: 'NULLABLE' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
        { name: 'updated_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      ];

      // Transactions table schema (consolidated: audit log + processing queue)
      const transactionsSchema = [
        { name: 'id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'receipt', type: 'STRING', mode: 'REQUIRED' },
        { name: 'transaction_type', type: 'STRING', mode: 'REQUIRED' },
        { name: 'brand', type: 'STRING', mode: 'REQUIRED' },
        { name: 'email', type: 'STRING', mode: 'REQUIRED' },
        { name: 'first_name', type: 'STRING', mode: 'NULLABLE' },
        { name: 'last_name', type: 'STRING', mode: 'NULLABLE' },
        { name: 'product_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'amount', type: 'NUMERIC', mode: 'NULLABLE' },
        { name: 'currency', type: 'STRING', mode: 'NULLABLE' },
        { name: 'affiliate', type: 'STRING', mode: 'NULLABLE' },
        { name: 'clickbank_timestamp', type: 'TIMESTAMP', mode: 'NULLABLE' },
        // Audit fields
        { name: 'raw_payload', type: 'STRING', mode: 'NULLABLE' },
        { name: 'is_test', type: 'BOOLEAN', mode: 'REQUIRED' },
        { name: 'is_encrypted', type: 'BOOLEAN', mode: 'REQUIRED' },
        { name: 'source_ip', type: 'STRING', mode: 'NULLABLE' },
        { name: 'user_agent', type: 'STRING', mode: 'NULLABLE' },
        // Processing queue fields
        { name: 'is_processed', type: 'BOOLEAN', mode: 'REQUIRED' },
        { name: 'keap_contact_id', type: 'INTEGER', mode: 'NULLABLE' },
        { name: 'tags_applied', type: 'INTEGER', mode: 'REPEATED' },
        { name: 'tags_removed', type: 'INTEGER', mode: 'REPEATED' },
        { name: 'processing_status', type: 'STRING', mode: 'REQUIRED' },
        { name: 'error_message', type: 'STRING', mode: 'NULLABLE' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
        { name: 'processed_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      ];

      // Subscriber queue table schema (initial submission data only)
      const subscriberQueueSchema = [
        { name: 'id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'email', type: 'STRING', mode: 'REQUIRED' },
        { name: 'first_name', type: 'STRING', mode: 'REQUIRED' },
        { name: 'brand', type: 'STRING', mode: 'REQUIRED' },
        { name: 'dp_source_id', type: 'STRING', mode: 'NULLABLE' },
        { name: 'dp_ip_address', type: 'STRING', mode: 'NULLABLE' },
        { name: 'dp_first_upload_time', type: 'STRING', mode: 'NULLABLE' },
        { name: 'dp_optional_inputs', type: 'STRING', mode: 'NULLABLE' },
        { name: 'redirect_slug', type: 'STRING', mode: 'NULLABLE' },
        { name: 'source_url', type: 'STRING', mode: 'NULLABLE' },
        { name: 'user_agent', type: 'STRING', mode: 'NULLABLE' },
        { name: 'raw_payload', type: 'STRING', mode: 'NULLABLE' },
        { name: 'tag_name', type: 'STRING', mode: 'NULLABLE' },
        { name: 'is_processed', type: 'BOOLEAN', mode: 'REQUIRED' },
        { name: 'keap_contact_id', type: 'INTEGER', mode: 'NULLABLE' },
        { name: 'tags_applied', type: 'STRING', mode: 'REPEATED' },
        { name: 'processing_error', type: 'STRING', mode: 'NULLABLE' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
        { name: 'processed_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      ];

      // Subscriber processing results table schema (append-only)
      // This avoids the streaming buffer UPDATE limitation
      const subscriberResultsSchema = [
        { name: 'subscriber_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'keap_contact_id', type: 'INTEGER', mode: 'NULLABLE' },
        { name: 'tags_applied', type: 'STRING', mode: 'REPEATED' },
        { name: 'processing_error', type: 'STRING', mode: 'NULLABLE' },
        { name: 'is_success', type: 'BOOLEAN', mode: 'REQUIRED' },
        { name: 'processed_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ];

      // Create product tags table if not exists
      const productTagsTableRef = dataset.table(this.productTagsTable);
      const [productTagsExists] = await productTagsTableRef.exists();
      if (!productTagsExists) {
        await productTagsTableRef.create({ schema: productTagsSchema });
        logger.info({ table: this.productTagsTable }, 'Created product tags table');
      }

      // Create transactions table if not exists
      const transactionsTableRef = dataset.table(this.transactionsTable);
      const [transactionsExists] = await transactionsTableRef.exists();
      if (!transactionsExists) {
        await transactionsTableRef.create({
          schema: transactionsSchema,
          timePartitioning: {
            type: 'DAY',
            field: 'created_at',
          },
          clustering: {
            fields: ['brand', 'product_id', 'is_processed'],
          },
        });
        logger.info({ table: this.transactionsTable }, 'Created transactions table');
      }

      // Create subscriber queue table if not exists
      const subscriberQueueTableRef = dataset.table(this.subscriberQueueTable);
      const [subscriberQueueExists] = await subscriberQueueTableRef.exists();
      if (!subscriberQueueExists) {
        await subscriberQueueTableRef.create({
          schema: subscriberQueueSchema,
          timePartitioning: {
            type: 'DAY',
            field: 'created_at',
          },
          clustering: {
            fields: ['brand', 'is_processed'],
          },
        });
        logger.info({ table: this.subscriberQueueTable }, 'Created subscriber queue table');
      }

      // Create subscriber processing results table if not exists
      const subscriberResultsTableRef = dataset.table(this.subscriberResultsTable);
      const [subscriberResultsExists] = await subscriberResultsTableRef.exists();
      if (!subscriberResultsExists) {
        await subscriberResultsTableRef.create({
          schema: subscriberResultsSchema,
          timePartitioning: {
            type: 'DAY',
            field: 'processed_at',
          },
          clustering: {
            fields: ['subscriber_id', 'is_success'],
          },
        });
        logger.info({ table: this.subscriberResultsTable }, 'Created subscriber processing results table');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to ensure BigQuery tables exist');
    }
  }
}

export const bigQueryClient = new BigQueryClient();
export default bigQueryClient;
