import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import {
  decryptClickbankNotification,
  isEncryptedFormat,
  isTestTransaction,
} from '../services/clickbank.js';
import { keapClient } from '../services/keap.js';
import { bigQueryClient } from '../services/bigquery.js';
import type {
  ClickbankIpnDecrypted,
  IpnLogEntry,
  ClickbankTransaction,
} from '../types/index.js';
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

    let ipnData: ClickbankIpnDecrypted | null = null;
    let isEncrypted = false;
    const sourceIp =
      (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip;
    const userAgent = request.headers['user-agent'] || null;

    // Initialize IPN log entry (raw logging)
    const ipnLogEntry: IpnLogEntry = {
      receipt: null,
      transaction_type: null,
      vendor: null,
      email: null,
      product_id: null,
      raw_payload: null,
      is_test: false,
      is_encrypted: false,
      source_ip: sourceIp,
      user_agent: userAgent,
      processing_status: 'unknown',
      processing_error: null,
      tags_applied: null,
      created_at: new Date().toISOString(),
    };

    try {
      const body = request.body;

      // Check if this is encrypted v6.0+ format
      if (isEncryptedFormat(body)) {
        isEncrypted = true;
        ipnLogEntry.is_encrypted = true;
        ipnData = decryptClickbankNotification(body);

        if (!ipnData) {
          ipnLogEntry.processing_status = 'decryption_failed';
          ipnLogEntry.processing_error = 'Failed to decrypt notification';
          await bigQueryClient.logIpn(ipnLogEntry);
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
      const email = ipnData.email;
      const productId = ipnData.itemNo;
      const isTest = isTestTransaction(transactionType);

      // Update IPN log entry
      ipnLogEntry.receipt = receipt;
      ipnLogEntry.transaction_type = transactionType;
      ipnLogEntry.vendor = vendor;
      ipnLogEntry.email = email || null;
      ipnLogEntry.product_id = productId || null;
      ipnLogEntry.is_test = isTest;
      ipnLogEntry.raw_payload = JSON.stringify(ipnData);

      reqLogger.info(
        {
          receipt,
          transactionType,
          vendor,
          productId,
          email,
          isEncrypted,
          isTest,
        },
        'ClickBank IPN received'
      );

      // Handle TEST (ClickBank URL validation test - not TEST_SALE)
      if (transactionType === 'TEST') {
        ipnLogEntry.processing_status = 'success';
        await bigQueryClient.logIpn(ipnLogEntry);
        return reply.status(200).send('OK');
      }

      // Validate required fields
      if (!receipt || !transactionType) {
        reqLogger.warn('Missing required fields in IPN');
        ipnLogEntry.processing_status = 'validation_failed';
        ipnLogEntry.processing_error = 'Missing required fields';
        await bigQueryClient.logIpn(ipnLogEntry);
        return reply.status(200).send('OK');
      }

      // Process the transaction
      if (PROCESSABLE_TYPES.includes(transactionType)) {
        await processTransaction(reqLogger, ipnData, vendor, ipnLogEntry);
      } else if (SKIP_TYPES.includes(transactionType)) {
        reqLogger.info({ receipt, transactionType }, 'Transaction type skipped');
        ipnLogEntry.processing_status = 'skipped';

        // Still log to transactions table with SKIPPED status
        await logSkippedTransaction(ipnData, vendor);
      } else {
        reqLogger.warn({ transactionType }, 'Unknown transaction type');
        ipnLogEntry.processing_status = 'unknown_type';
        ipnLogEntry.processing_error = `Unknown type: ${transactionType}`;
      }

      await bigQueryClient.logIpn(ipnLogEntry);
      return reply.status(200).send('OK');
    } catch (error) {
      reqLogger.error({ error }, 'ClickBank IPN processing error');
      ipnLogEntry.processing_status = 'exception';
      ipnLogEntry.processing_error = error instanceof Error ? error.message : 'Unknown error';
      await bigQueryClient.logIpn(ipnLogEntry);
      return reply.status(200).send('OK');
    }
  });
}

/**
 * Process a Clickbank transaction (SALE, RFND, CGBK, REBILL)
 *
 * Flow:
 * 1. Query tag actions for product + transaction type
 * 2. Find or create contact in Keap (with CB_Customer fields)
 * 3. Apply tags (APPLY actions)
 * 4. Remove tags (REMOVE actions)
 * 5. Log transaction to BigQuery
 */
async function processTransaction(
  reqLogger: Logger,
  ipnData: ClickbankIpnDecrypted,
  vendor: string,
  ipnLogEntry: IpnLogEntry
): Promise<void> {
  const {
    receipt,
    email,
    firstName,
    lastName,
    itemNo: productId,
    transactionType,
    totalOrderAmount,
    currency,
    affiliate,
    transactionTime,
  } = ipnData;

  // Initialize transaction record
  const transaction: ClickbankTransaction = {
    receipt: receipt,
    email: email || '',
    first_name: firstName || null,
    last_name: lastName || null,
    product_id: productId || '',
    transaction_type: transactionType,
    amount: totalOrderAmount || null,
    currency: currency || 'USD',
    affiliate: affiliate || null,
    clickbank_timestamp: transactionTime || null,
    keap_contact_id: null,
    tags_applied: [],
    tags_removed: [],
    processed_at: new Date().toISOString(),
    processing_status: 'SUCCESS',
    error_message: null,
    brand: vendor,
  };

  try {
    // Validate email
    if (!email) {
      reqLogger.warn({ receipt }, 'No email in IPN data');
      transaction.processing_status = 'FAILED';
      transaction.error_message = 'No email in IPN data';
      ipnLogEntry.processing_status = 'no_email';
      ipnLogEntry.processing_error = 'No email in IPN data';
      await bigQueryClient.logTransaction(transaction);
      return;
    }

    // Validate product ID
    if (!productId) {
      reqLogger.warn({ receipt }, 'No product ID in IPN data');
      transaction.processing_status = 'FAILED';
      transaction.error_message = 'No product ID in IPN data';
      ipnLogEntry.processing_status = 'no_product';
      ipnLogEntry.processing_error = 'No product ID in IPN data';
      await bigQueryClient.logTransaction(transaction);
      return;
    }

    // Get tag actions for this product + transaction type
    const tagActions = await bigQueryClient.getTagActionsForProduct(productId, transactionType);

    const tagsToApply = tagActions.filter((t) => t.action === 'APPLY').map((t) => t.tagId);
    const tagsToRemove = tagActions.filter((t) => t.action === 'REMOVE').map((t) => t.tagId);

    if (tagActions.length === 0) {
      reqLogger.warn({ productId, transactionType }, 'No tag actions configured');
      transaction.processing_status = 'NO_TAGS';
      transaction.error_message = `No tags configured for ${productId}/${transactionType}`;
      ipnLogEntry.processing_status = 'no_tags';
      ipnLogEntry.processing_error = `No tags for ${productId}/${transactionType}`;
    }

    // Find or create contact in Keap (sets CB_Customer, CB_Last_Purchase_Date, CB_Last_Order_ID)
    const contact = await keapClient.findOrCreateClickbankContact(
      email,
      firstName || '',
      lastName || '',
      receipt,
      transactionTime || null
    );

    transaction.keap_contact_id = contact.id;

    // Apply tags
    if (tagsToApply.length > 0) {
      await keapClient.applyTags(contact.id, tagsToApply);
      transaction.tags_applied = tagsToApply;
      reqLogger.info({ contactId: contact.id, tags: tagsToApply }, 'Tags applied');
    }

    // Remove tags
    if (tagsToRemove.length > 0) {
      await keapClient.removeTags(contact.id, tagsToRemove);
      transaction.tags_removed = tagsToRemove;
      reqLogger.info({ contactId: contact.id, tags: tagsToRemove }, 'Tags removed');
    }

    // Update IPN log entry
    ipnLogEntry.processing_status = transaction.processing_status === 'NO_TAGS' ? 'no_tags' : 'success';
    ipnLogEntry.tags_applied = JSON.stringify({
      applied: tagsToApply,
      removed: tagsToRemove,
    });

    // Log transaction to BigQuery
    await bigQueryClient.logTransaction(transaction);

    reqLogger.info(
      {
        receipt,
        contactId: contact.id,
        tagsApplied: tagsToApply,
        tagsRemoved: tagsToRemove,
        affiliate,
      },
      'Transaction processed successfully'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    reqLogger.error({ error, receipt, email, productId }, 'Failed to process transaction');

    transaction.processing_status = 'FAILED';
    transaction.error_message = errorMessage;
    ipnLogEntry.processing_status = 'keap_error';
    ipnLogEntry.processing_error = errorMessage;

    await bigQueryClient.logTransaction(transaction);
  }
}

/**
 * Log a skipped transaction (CANCEL-REBILL, etc.)
 */
async function logSkippedTransaction(
  ipnData: ClickbankIpnDecrypted,
  vendor: string
): Promise<void> {
  const transaction: ClickbankTransaction = {
    receipt: ipnData.receipt,
    email: ipnData.email || '',
    first_name: ipnData.firstName || null,
    last_name: ipnData.lastName || null,
    product_id: ipnData.itemNo || '',
    transaction_type: ipnData.transactionType,
    amount: ipnData.totalOrderAmount || null,
    currency: ipnData.currency || 'USD',
    affiliate: ipnData.affiliate || null,
    clickbank_timestamp: ipnData.transactionTime || null,
    keap_contact_id: null,
    tags_applied: [],
    tags_removed: [],
    processed_at: new Date().toISOString(),
    processing_status: 'SKIPPED',
    error_message: null,
    brand: vendor,
  };

  await bigQueryClient.logTransaction(transaction);
}
