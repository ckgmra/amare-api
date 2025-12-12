import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import {
  decryptClickbankNotification,
  isEncryptedFormat,
  isTestTransaction,
} from '../services/clickbank.js';
import { keapClient } from '../services/keap.js';
import { bigQueryClient } from '../services/bigquery.js';
import type { ClickbankIpnDecrypted, ClickbankTransaction } from '../types/index.js';
import { logger } from '../utils/logger.js';

interface LegacyIpnBody {
  ctransaction?: string;
  cvendor?: string;
  ctransreceipt?: string;
  ccustemail?: string;
  cproditem?: string;
  ccustfirstname?: string;
  ccustlastname?: string;
  ctransamount?: string;
  caffitid?: string;
  ctranstime?: string;
  [key: string]: unknown;
}

// Transaction types that should trigger tag processing
const SALE_TYPES = ['SALE', 'REBILL', 'TEST_SALE'];
const REFUND_TYPES = ['RFND', 'CGBK', 'INSF', 'TEST_RFND'];
const PROCESSABLE_TYPES = [...SALE_TYPES, ...REFUND_TYPES];

// Transaction types to skip (log only, no tag changes)
const SKIP_TYPES = ['CANCEL-REBILL', 'UNCANCEL-REBILL'];

export async function clickbankRoutes(fastify: FastifyInstance) {
  // GET handler for ClickBank URL validation test
  fastify.get('/ipn/clickbank', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send('OK');
  });

  // POST handler for IPN processing
  fastify.post('/ipn/clickbank', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    const reqLogger = logger.child({ requestId });
    const now = new Date().toISOString();

    const sourceIp =
      (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip;
    const userAgent = (request.headers['user-agent'] as string) || null;

    let ipnData: ClickbankIpnDecrypted | null = null;
    let isEncrypted = false;

    try {
      const body = request.body;

      // Check if this is encrypted v6.0+ format
      if (isEncryptedFormat(body)) {
        isEncrypted = true;
        ipnData = decryptClickbankNotification(body);

        if (!ipnData) {
          // Log decryption failure
          const transaction = createTransaction({
            receipt: '',
            transactionType: 'UNKNOWN',
            brand: '',
            email: '',
            productId: '',
            rawPayload: JSON.stringify(body),
            isTest: false,
            isEncrypted: true,
            sourceIp,
            userAgent,
            processingStatus: 'DECRYPTION_FAILED',
            errorMessage: 'Failed to decrypt notification',
            now,
          });
          await bigQueryClient.logTransaction(transaction);
          return reply.status(200).send('OK');
        }
      } else {
        // Legacy form format
        const legacyBody = body as LegacyIpnBody;
        ipnData = {
          transactionType: legacyBody.ctransaction || '',
          vendor: legacyBody.cvendor || '',
          receipt: legacyBody.ctransreceipt || '',
          email: legacyBody.ccustemail,
          firstName: legacyBody.ccustfirstname,
          lastName: legacyBody.ccustlastname,
          itemNo: legacyBody.cproditem,
          totalOrderAmount: legacyBody.ctransamount
            ? parseFloat(legacyBody.ctransamount) / 100
            : undefined,
          affiliate: legacyBody.caffitid,
          transactionTime: legacyBody.ctranstime,
        };
      }

      // Extract transaction details
      const transactionType = ipnData.transactionType;
      const vendor = ipnData.vendor?.toLowerCase() || '';
      const receipt = ipnData.receipt;
      const email = ipnData.email || '';
      const productId = ipnData.itemNo || '';
      const isTest = isTestTransaction(transactionType);

      reqLogger.info(
        { receipt, transactionType, vendor, productId, email, isEncrypted, isTest },
        'ClickBank IPN received'
      );

      // Handle TEST (ClickBank URL validation test - not TEST_SALE)
      if (transactionType === 'TEST') {
        const transaction = createTransaction({
          receipt,
          transactionType,
          brand: vendor,
          email,
          productId,
          rawPayload: JSON.stringify(ipnData),
          isTest: true,
          isEncrypted,
          sourceIp,
          userAgent,
          processingStatus: 'TEST',
          errorMessage: null,
          now,
          isProcessed: true,
        });
        await bigQueryClient.logTransaction(transaction);
        return reply.status(200).send('OK');
      }

      // Validate required fields
      if (!receipt || !transactionType) {
        const transaction = createTransaction({
          receipt: receipt || '',
          transactionType: transactionType || 'UNKNOWN',
          brand: vendor,
          email,
          productId,
          rawPayload: JSON.stringify(ipnData),
          isTest,
          isEncrypted,
          sourceIp,
          userAgent,
          processingStatus: 'VALIDATION_FAILED',
          errorMessage: 'Missing required fields',
          now,
        });
        await bigQueryClient.logTransaction(transaction);
        return reply.status(200).send('OK');
      }

      // Build full transaction object
      const transaction: ClickbankTransaction = {
        id: uuidv4(),
        receipt,
        transaction_type: transactionType,
        brand: vendor,
        email,
        first_name: ipnData.firstName || null,
        last_name: ipnData.lastName || null,
        product_id: productId,
        amount: ipnData.totalOrderAmount || null,
        currency: ipnData.currency || 'USD',
        affiliate: ipnData.affiliate || null,
        clickbank_timestamp: ipnData.transactionTime || null,
        raw_payload: JSON.stringify(ipnData),
        is_test: isTest,
        is_encrypted: isEncrypted,
        source_ip: sourceIp,
        user_agent: userAgent,
        is_processed: false,
        keap_contact_id: null,
        tags_applied: [],
        tags_removed: [],
        processing_status: 'PENDING',
        error_message: null,
        created_at: now,
        processed_at: null,
      };

      // Process based on transaction type
      if (PROCESSABLE_TYPES.includes(transactionType)) {
        // Validate email for processable transactions
        if (!email) {
          transaction.is_processed = true;
          transaction.processed_at = now;
          transaction.processing_status = 'FAILED';
          transaction.error_message = 'No email in IPN data';
          await bigQueryClient.logTransaction(transaction);
          return reply.status(200).send('OK');
        }

        // Validate product ID
        if (!productId) {
          transaction.is_processed = true;
          transaction.processed_at = now;
          transaction.processing_status = 'FAILED';
          transaction.error_message = 'No product ID in IPN data';
          await bigQueryClient.logTransaction(transaction);
          return reply.status(200).send('OK');
        }

        // Queue transaction first (never lose data)
        await bigQueryClient.logTransaction(transaction);
        reqLogger.info({ transactionId: transaction.id, receipt }, 'Transaction queued');

        // Attempt to process immediately
        await processQueuedTransaction(reqLogger, transaction);
      } else if (SKIP_TYPES.includes(transactionType)) {
        transaction.is_processed = true;
        transaction.processed_at = now;
        transaction.processing_status = 'SKIPPED';
        await bigQueryClient.logTransaction(transaction);
        reqLogger.info({ receipt, transactionType }, 'Transaction type skipped');
      } else {
        transaction.is_processed = true;
        transaction.processed_at = now;
        transaction.processing_status = 'FAILED';
        transaction.error_message = `Unknown transaction type: ${transactionType}`;
        await bigQueryClient.logTransaction(transaction);
        reqLogger.warn({ transactionType }, 'Unknown transaction type');
      }

      // After processing current IPN, try to retry any failed transactions
      retryFailedTransactions(reqLogger).catch((err) => {
        reqLogger.error({ error: err }, 'Failed to retry transactions');
      });

      return reply.status(200).send('OK');
    } catch (error) {
      reqLogger.error({ error }, 'ClickBank IPN processing error');
      const transaction = createTransaction({
        receipt: ipnData?.receipt || '',
        transactionType: ipnData?.transactionType || 'UNKNOWN',
        brand: ipnData?.vendor?.toLowerCase() || '',
        email: ipnData?.email || '',
        productId: ipnData?.itemNo || '',
        rawPayload: ipnData ? JSON.stringify(ipnData) : null,
        isTest: false,
        isEncrypted,
        sourceIp,
        userAgent,
        processingStatus: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        now,
      });
      await bigQueryClient.logTransaction(transaction);
      return reply.status(200).send('OK');
    }
  });
}

/**
 * Helper to create a transaction record
 */
function createTransaction(opts: {
  receipt: string;
  transactionType: string;
  brand: string;
  email: string;
  productId: string;
  rawPayload: string | null;
  isTest: boolean;
  isEncrypted: boolean;
  sourceIp: string;
  userAgent: string | null;
  processingStatus: ClickbankTransaction['processing_status'];
  errorMessage: string | null;
  now: string;
  isProcessed?: boolean;
}): ClickbankTransaction {
  return {
    id: uuidv4(),
    receipt: opts.receipt,
    transaction_type: opts.transactionType,
    brand: opts.brand,
    email: opts.email,
    first_name: null,
    last_name: null,
    product_id: opts.productId,
    amount: null,
    currency: 'USD',
    affiliate: null,
    clickbank_timestamp: null,
    raw_payload: opts.rawPayload,
    is_test: opts.isTest,
    is_encrypted: opts.isEncrypted,
    source_ip: opts.sourceIp,
    user_agent: opts.userAgent,
    is_processed: opts.isProcessed ?? true,
    keap_contact_id: null,
    tags_applied: [],
    tags_removed: [],
    processing_status: opts.processingStatus,
    error_message: opts.errorMessage,
    created_at: opts.now,
    processed_at: opts.isProcessed ?? true ? opts.now : null,
  };
}

/**
 * Process a queued transaction (used for both new and retry)
 */
async function processQueuedTransaction(
  reqLogger: Logger,
  transaction: ClickbankTransaction
): Promise<void> {
  const { id, receipt, email, first_name, last_name, product_id, transaction_type } = transaction;

  let contactId: number | null = null;
  let tagsApplied: number[] = [];
  let tagsRemoved: number[] = [];
  let errorMessage: string | null = null;

  try {
    // Get tag actions for this product + transaction type
    const tagActions = await bigQueryClient.getTagActionsForProduct(product_id, transaction_type);

    tagsApplied = tagActions.filter((t) => t.action === 'APPLY').map((t) => t.tagId);
    tagsRemoved = tagActions.filter((t) => t.action === 'REMOVE').map((t) => t.tagId);

    if (tagActions.length === 0) {
      reqLogger.warn({ product_id, transaction_type }, 'No tag actions configured');
    }

    // Find or create contact in Keap
    const contact = await keapClient.findOrCreateClickbankContact(
      email,
      first_name || '',
      last_name || '',
      receipt,
      transaction.clickbank_timestamp
    );

    contactId = contact.id;

    // Apply tags
    if (tagsApplied.length > 0) {
      await keapClient.applyTags(contact.id, tagsApplied);
      reqLogger.info({ contactId: contact.id, tags: tagsApplied }, 'Tags applied');
    }

    // Remove tags
    if (tagsRemoved.length > 0) {
      await keapClient.removeTags(contact.id, tagsRemoved);
      reqLogger.info({ contactId: contact.id, tags: tagsRemoved }, 'Tags removed');
    }

    reqLogger.info(
      { transactionId: id, receipt, contactId, tagsApplied, tagsRemoved },
      'Transaction processed successfully'
    );
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    reqLogger.error({ error, transactionId: id, receipt, email }, 'Failed to process transaction');
  }

  // Update transaction status in BigQuery
  await bigQueryClient.updateTransactionStatus(id, contactId, tagsApplied, tagsRemoved, errorMessage);
}

/**
 * Retry failed transactions (triggered by new IPNs)
 */
async function retryFailedTransactions(reqLogger: Logger): Promise<void> {
  const unprocessed = await bigQueryClient.getUnprocessedTransactions(10);

  if (unprocessed.length === 0) {
    return;
  }

  reqLogger.info({ count: unprocessed.length }, 'Retrying unprocessed transactions');

  for (const transaction of unprocessed) {
    reqLogger.info({ transactionId: transaction.id, receipt: transaction.receipt }, 'Retrying transaction');
    await processQueuedTransaction(reqLogger, transaction);
  }
}
