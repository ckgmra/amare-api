import crypto from 'crypto';
import type { ClickbankIpnEncrypted, ClickbankIpnDecrypted } from '../types/index.js';
import { logger } from '../utils/logger.js';

export function decryptClickbankNotification(
  encryptedData: ClickbankIpnEncrypted
): ClickbankIpnDecrypted | null {
  try {
    const { notification, iv } = encryptedData;

    if (!notification || !iv) {
      logger.error('Missing notification or iv in encrypted IPN');
      return null;
    }

    const secretKey = process.env.CLICKBANK_SECRET_KEY;
    if (!secretKey) {
      logger.error('CLICKBANK_SECRET_KEY not configured');
      return null;
    }

    const encryptedBytes = Buffer.from(notification, 'base64');
    const ivBytes = Buffer.from(iv, 'base64');

    // Derive key using ClickBank's method:
    // PHP: substr(sha1($secretKey), 0, 32) - uses the first 32 hex chars AS-IS as ASCII bytes
    const sha1Hash = crypto.createHash('sha1').update(secretKey).digest('hex');
    const key = sha1Hash.substring(0, 32);

    // Decrypt using AES-256-CBC
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, ivBytes);
    let decrypted = decipher.update(encryptedBytes);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    // Trim null bytes and control characters (ASCII 0-32)
    // This matches PHP's trim($str, "\0..\32")
    let decryptedStr = decrypted.toString('utf8');
    decryptedStr = decryptedStr.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');

    // Parse JSON
    const ipnData = JSON.parse(decryptedStr) as ClickbankIpnDecrypted;

    logger.info(
      {
        transactionType: ipnData.transactionType,
        receipt: ipnData.receipt,
      },
      'Successfully decrypted ClickBank IPN'
    );

    return ipnData;
  } catch (error) {
    logger.error({ error }, 'ClickBank decryption error');
    return null;
  }
}

export function isEncryptedFormat(body: unknown): body is ClickbankIpnEncrypted {
  return (
    typeof body === 'object' &&
    body !== null &&
    'notification' in body &&
    'iv' in body &&
    typeof (body as ClickbankIpnEncrypted).notification === 'string' &&
    typeof (body as ClickbankIpnEncrypted).iv === 'string'
  );
}

export const VALID_SALE_TYPES = ['SALE', 'JV_SALE', 'BILL', 'JV_BILL', 'TEST_SALE', 'TEST_BILL'];
export const VALID_REFUND_TYPES = ['RFND', 'CGBK', 'INSF', 'TEST_RFND'];

export function isTestTransaction(transactionType: string): boolean {
  return transactionType.includes('TEST');
}

/**
 * Parse ClickBank timestamp format (YYYYMMDDTHHMMSS±HHMM) to BigQuery-compatible format
 * Example input: '20260115T141003-0800'
 * Example output: '2026-01-15 14:10:03'
 *
 * Returns null if parsing fails to avoid breaking the entire IPN
 */
export function parseClickbankTimestamp(timestamp: string | undefined): string | null {
  if (!timestamp) {
    return null;
  }

  try {
    // ClickBank format: YYYYMMDDTHHMMSS±HHMM
    // Example: 20260115T141003-0800
    const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})([+-]\d{4})$/);

    if (!match) {
      logger.warn({ timestamp }, 'Could not parse ClickBank timestamp format');
      return null;
    }

    const [, year, month, day, hour, minute, second] = match;

    // Format as YYYY-MM-DD HH:MM:SS (BigQuery TIMESTAMP format)
    const formatted = `${year}-${month}-${day} ${hour}:${minute}:${second}`;

    return formatted;
  } catch (error) {
    logger.error({ error, timestamp }, 'Error parsing ClickBank timestamp');
    return null;
  }
}

/**
 * Extract email from ClickBank IPN data
 * Handles both legacy format (top-level email field) and v8+ format (nested customer object)
 */
export function extractEmail(ipnData: ClickbankIpnDecrypted): string {
  // Try top-level email first (legacy format)
  if (ipnData.email) {
    return ipnData.email;
  }

  // Try v8+ nested customer object
  if (ipnData.customer?.shipping?.email) {
    return ipnData.customer.shipping.email;
  }

  if (ipnData.customer?.billing?.email) {
    return ipnData.customer.billing.email;
  }

  return '';
}

/**
 * Extract first name from ClickBank IPN data
 */
export function extractFirstName(ipnData: ClickbankIpnDecrypted): string | undefined {
  if (ipnData.firstName) {
    return ipnData.firstName;
  }

  if (ipnData.customer?.shipping?.firstName) {
    return ipnData.customer.shipping.firstName;
  }

  if (ipnData.customer?.billing?.firstName) {
    return ipnData.customer.billing.firstName;
  }

  return undefined;
}

/**
 * Extract last name from ClickBank IPN data
 */
export function extractLastName(ipnData: ClickbankIpnDecrypted): string | undefined {
  if (ipnData.lastName) {
    return ipnData.lastName;
  }

  if (ipnData.customer?.shipping?.lastName) {
    return ipnData.customer.shipping.lastName;
  }

  if (ipnData.customer?.billing?.lastName) {
    return ipnData.customer.billing.lastName;
  }

  return undefined;
}

/**
 * Extract product ID from ClickBank IPN data
 * Handles both legacy format (top-level itemNo) and v8+ format (lineItems array)
 */
export function extractProductId(ipnData: ClickbankIpnDecrypted): string {
  // Try top-level itemNo first (legacy format)
  if (ipnData.itemNo) {
    return ipnData.itemNo;
  }

  // Try v8+ lineItems array - get first item's itemNo
  if (ipnData.lineItems && ipnData.lineItems.length > 0 && ipnData.lineItems[0].itemNo) {
    return ipnData.lineItems[0].itemNo;
  }

  return '';
}
