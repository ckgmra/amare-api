import { BigQuery } from '@google-cloud/bigquery';
import type { IpnLogEntry, TagAction, ClickbankTransaction } from '../types/index.js';
import { logger } from '../utils/logger.js';

class BigQueryClient {
  private client: BigQuery;
  private projectId: string;
  private dataset: string;
  private productTagsTable: string;
  private ipnLogTable: string;
  private transactionsTable: string;

  constructor() {
    this.projectId = process.env.GCP_PROJECT_ID || 'watchful-force-477418-b9';
    this.dataset = process.env.BIGQUERY_DATASET || 'keap_integration';
    this.productTagsTable = process.env.BIGQUERY_TABLE_PRODUCT_TAGS || 'clickbank_product_tags';
    this.ipnLogTable = process.env.BIGQUERY_TABLE_IPN_LOG || 'clickbank_ipn_log';
    this.transactionsTable =
      process.env.BIGQUERY_TABLE_TRANSACTIONS || 'clickbank_transactions';

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
   * Log raw IPN data (for debugging/auditing)
   */
  async logIpn(entry: IpnLogEntry): Promise<void> {
    try {
      const tableRef = this.client.dataset(this.dataset).table(this.ipnLogTable);

      await tableRef.insert([entry]);
      logger.info({ receipt: entry.receipt }, 'IPN logged to BigQuery');
    } catch (error) {
      const bqError = error as { errors?: Array<{ errors: unknown[] }> };
      if (bqError.errors) {
        logger.error({ errors: bqError.errors }, 'BigQuery insert errors');
      } else {
        logger.error({ error }, 'Failed to log IPN to BigQuery');
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

      // IPN log table schema (raw IPN logging)
      const ipnLogSchema = [
        { name: 'receipt', type: 'STRING', mode: 'NULLABLE' },
        { name: 'transaction_type', type: 'STRING', mode: 'NULLABLE' },
        { name: 'vendor', type: 'STRING', mode: 'NULLABLE' },
        { name: 'email', type: 'STRING', mode: 'NULLABLE' },
        { name: 'product_id', type: 'STRING', mode: 'NULLABLE' },
        { name: 'raw_payload', type: 'STRING', mode: 'NULLABLE' },
        { name: 'is_test', type: 'BOOLEAN', mode: 'REQUIRED' },
        { name: 'is_encrypted', type: 'BOOLEAN', mode: 'REQUIRED' },
        { name: 'source_ip', type: 'STRING', mode: 'NULLABLE' },
        { name: 'user_agent', type: 'STRING', mode: 'NULLABLE' },
        { name: 'processing_status', type: 'STRING', mode: 'REQUIRED' },
        { name: 'processing_error', type: 'STRING', mode: 'NULLABLE' },
        { name: 'tags_applied', type: 'STRING', mode: 'NULLABLE' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ];

      // Transactions table schema (main transaction log)
      const transactionsSchema = [
        { name: 'receipt', type: 'STRING', mode: 'REQUIRED' },
        { name: 'email', type: 'STRING', mode: 'REQUIRED' },
        { name: 'first_name', type: 'STRING', mode: 'NULLABLE' },
        { name: 'last_name', type: 'STRING', mode: 'NULLABLE' },
        { name: 'product_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'transaction_type', type: 'STRING', mode: 'REQUIRED' },
        { name: 'amount', type: 'NUMERIC', mode: 'NULLABLE' },
        { name: 'currency', type: 'STRING', mode: 'NULLABLE' },
        { name: 'affiliate', type: 'STRING', mode: 'NULLABLE' },
        { name: 'clickbank_timestamp', type: 'TIMESTAMP', mode: 'NULLABLE' },
        { name: 'keap_contact_id', type: 'INTEGER', mode: 'NULLABLE' },
        { name: 'tags_applied', type: 'INTEGER', mode: 'REPEATED' },
        { name: 'tags_removed', type: 'INTEGER', mode: 'REPEATED' },
        { name: 'processed_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
        { name: 'processing_status', type: 'STRING', mode: 'NULLABLE' },
        { name: 'error_message', type: 'STRING', mode: 'NULLABLE' },
        { name: 'brand', type: 'STRING', mode: 'REQUIRED' },
      ];

      // Create product tags table if not exists
      const productTagsTableRef = dataset.table(this.productTagsTable);
      const [productTagsExists] = await productTagsTableRef.exists();
      if (!productTagsExists) {
        await productTagsTableRef.create({ schema: productTagsSchema });
        logger.info({ table: this.productTagsTable }, 'Created product tags table');
      }

      // Create IPN log table if not exists
      const ipnLogTableRef = dataset.table(this.ipnLogTable);
      const [ipnLogExists] = await ipnLogTableRef.exists();
      if (!ipnLogExists) {
        await ipnLogTableRef.create({ schema: ipnLogSchema });
        logger.info({ table: this.ipnLogTable }, 'Created IPN log table');
      }

      // Create transactions table if not exists
      const transactionsTableRef = dataset.table(this.transactionsTable);
      const [transactionsExists] = await transactionsTableRef.exists();
      if (!transactionsExists) {
        await transactionsTableRef.create({
          schema: transactionsSchema,
          timePartitioning: {
            type: 'DAY',
            field: 'processed_at',
          },
          clustering: {
            fields: ['brand', 'product_id', 'transaction_type'],
          },
        });
        logger.info({ table: this.transactionsTable }, 'Created transactions table');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to ensure BigQuery tables exist');
    }
  }
}

export const bigQueryClient = new BigQueryClient();
export default bigQueryClient;
