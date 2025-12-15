import { BigQuery } from '@google-cloud/bigquery';
import type { TagAction, ClickbankTransaction, SubscriberQueueEntry } from '../types/index.js';
import { logger } from '../utils/logger.js';

class BigQueryClient {
  private client: BigQuery;
  private projectId: string;
  private dataset: string;
  private productTagsTable: string;
  private transactionsTable: string;
  private subscriberQueueTable: string;
  private subscriberResultsTable: string;

  constructor() {
    this.projectId = process.env.GCP_PROJECT_ID || 'watchful-force-477418-b9';
    this.dataset = process.env.BIGQUERY_DATASET || 'keap_integration';
    this.productTagsTable = process.env.BIGQUERY_TABLE_PRODUCT_TAGS || 'clickbank_product_tags';
    this.transactionsTable =
      process.env.BIGQUERY_TABLE_TRANSACTIONS || 'clickbank_transactions';
    this.subscriberQueueTable =
      process.env.BIGQUERY_TABLE_SUBSCRIBER_QUEUE || 'subscriber_queue';
    this.subscriberResultsTable = 'subscriber_processing_results';

    this.client = new BigQuery({
      projectId: this.projectId,
    });
  }

  /**
   * Get tag actions for a product and transaction type
   *
   * Returns array of {action, tagId} objects where action is 'APPLY' or 'REMOVE'
   * This allows different behavior for SALE vs RFND vs CGBK transactions
   */
  async getTagActionsForProduct(
    productId: string,
    transactionType: string
  ): Promise<TagAction[]> {
    try {
      const query = `
        SELECT action, tag_id, tag_name
        FROM \`${this.projectId}.${this.dataset}.${this.productTagsTable}\`
        WHERE product_id = @productId
          AND transaction_type = @transactionType
          AND active = true
      `;

      const [rows] = await this.client.query({
        query,
        params: { productId, transactionType },
      });

      const tagActions: TagAction[] = rows.map(
        (row: { action: string; tag_id: number; tag_name?: string }) => ({
          action: row.action as 'APPLY' | 'REMOVE',
          tagId: row.tag_id,
          tagName: row.tag_name,
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

  async ensureTablesExist(): Promise<void> {
    try {
      const dataset = this.client.dataset(this.dataset);

      // Check if dataset exists, create if not
      const [datasetExists] = await dataset.exists();
      if (!datasetExists) {
        await dataset.create();
        logger.info({ dataset: this.dataset }, 'Created BigQuery dataset');
      }

      // Product tags table schema (updated with transaction_type and action)
      const productTagsSchema = [
        { name: 'product_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'brand', type: 'STRING', mode: 'REQUIRED' },
        { name: 'transaction_type', type: 'STRING', mode: 'REQUIRED' },
        { name: 'action', type: 'STRING', mode: 'REQUIRED' },
        { name: 'tag_id', type: 'INTEGER', mode: 'REQUIRED' },
        { name: 'tag_name', type: 'STRING', mode: 'NULLABLE' },
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
