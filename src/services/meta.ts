import crypto from 'crypto';
import axios from 'axios';
import { logger } from '../utils/logger.js';
import type { MetaSendResult } from '../types/index.js';

/**
 * Normalize and SHA-256 hash a value per Meta spec.
 * Lowercase, trim, then hex-encode the SHA-256 digest.
 */
export function sha256(value: string): string {
  const normalized = value.toLowerCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Hash user data fields per Meta CAPI spec.
 * Only hashes non-null/undefined fields.
 */
export function hashUserData(fields: {
  em?: string | null;
  ph?: string | null;
  fn?: string | null;
  ln?: string | null;
  external_id?: string | null;
  ct?: string | null;
  st?: string | null;
  zp?: string | null;
}): Record<string, string> {
  const hashed: Record<string, string> = {};
  if (fields.em) hashed.em = sha256(fields.em);
  if (fields.ph) hashed.ph = sha256(fields.ph);
  if (fields.fn) hashed.fn = sha256(fields.fn);
  if (fields.ln) hashed.ln = sha256(fields.ln);
  if (fields.external_id) hashed.external_id = sha256(fields.external_id);
  if (fields.ct) hashed.ct = sha256(fields.ct);
  if (fields.st) hashed.st = sha256(fields.st);
  if (fields.zp) hashed.zp = sha256(fields.zp);
  return hashed;
}

/**
 * Get the shared Meta CAPI access token.
 * All brands use a single token (META_ACCESS_TOKEN).
 */
export function getAccessToken(_brand?: string): string | null {
  return process.env.META_ACCESS_TOKEN || null;
}

/**
 * Send events to Meta Conversions API.
 * Never throws — returns a structured result.
 */
export async function sendEvent(params: {
  pixelId: string;
  accessToken: string;
  events: Record<string, unknown>[];
  testEventCode?: string;
  brand?: string;
}): Promise<MetaSendResult> {
  const { pixelId, accessToken, events, testEventCode, brand } = params;
  const effectiveTestCode = testEventCode || process.env.META_TEST_EVENT_CODE || undefined;

  const url = `https://graph.facebook.com/v21.0/${pixelId}/events`;
  const body: Record<string, unknown> = { data: events };
  if (effectiveTestCode) {
    body.test_event_code = effectiveTestCode;
  }

  const startMs = Date.now();

  try {
    const response = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
      },
      params: {
        access_token: accessToken,
      },
      timeout: 10000,
    });

    const latencyMs = Date.now() - startMs;

    logger.info(
      { brand, pixelId, eventCount: events.length, status: response.status, latencyMs },
      'Meta CAPI send success'
    );

    return {
      success: true,
      httpStatus: response.status,
      responseJson: JSON.stringify(response.data),
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - startMs;
    const axiosError = error as { response?: { status: number; data: unknown }; message?: string };

    const httpStatus = axiosError.response?.status || null;
    const responseJson = axiosError.response?.data
      ? JSON.stringify(axiosError.response.data)
      : null;
    const errorMessage = axiosError.message || 'Unknown error';

    logger.error(
      { brand, pixelId, httpStatus, error: errorMessage, latencyMs },
      'Meta CAPI send failed'
    );

    return {
      success: false,
      httpStatus: httpStatus || undefined,
      responseJson: responseJson || undefined,
      latencyMs,
      error: errorMessage,
    };
  }
}

/**
 * Get Meta pixel ID for a brand from env vars.
 * Format: META_PIXEL_ID_{BRAND} (e.g., META_PIXEL_ID_FLO)
 */
export function getPixelId(brand: string): string | null {
  const key = `META_PIXEL_ID_${brand.toUpperCase()}`;
  return process.env[key] || null;
}

export const metaCAPIClient = {
  sha256,
  hashUserData,
  getAccessToken,
  getPixelId,
  sendEvent,
};
