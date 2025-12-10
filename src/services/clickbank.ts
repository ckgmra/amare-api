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
