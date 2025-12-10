import axios, { AxiosInstance } from 'axios';
import type { KeapContact, KeapTokenResponse } from '../types/index.js';
import { logger } from '../utils/logger.js';

const KEAP_API_BASE = 'https://api.infusionsoft.com/crm/rest/v1';
const KEAP_TOKEN_URL = 'https://api.infusionsoft.com/token';

/**
 * Clickbank customer custom field IDs
 * These need to be configured via environment variables after looking up
 * the actual field IDs in your Keap account
 */
function getClickbankFieldIds() {
  return {
    cbCustomer: parseFieldId('KEAP_FIELD_CB_CUSTOMER'),
    cbLastPurchaseDate: parseFieldId('KEAP_FIELD_CB_LAST_PURCHASE_DATE'),
    cbLastOrderId: parseFieldId('KEAP_FIELD_CB_LAST_ORDER_ID'),
  };
}

function parseFieldId(envVar: string): number | undefined {
  const value = process.env[envVar];
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? undefined : parsed;
}

class KeapClient {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private axiosInstance: AxiosInstance;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: KEAP_API_BASE,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.axiosInstance.interceptors.request.use(async (config) => {
      const token = await this.getAccessToken();
      config.headers.Authorization = `Bearer ${token}`;
      return config;
    });
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();

    if (this.accessToken && this.tokenExpiry > now + 60000) {
      return this.accessToken;
    }

    const clientId = process.env.KEAP_CLIENT_ID;
    const clientSecret = process.env.KEAP_CLIENT_SECRET;
    const refreshToken = process.env.KEAP_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Missing Keap OAuth credentials');
    }

    try {
      const response = await axios.post<KeapTokenResponse>(
        KEAP_TOKEN_URL,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          },
        }
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiry = now + response.data.expires_in * 1000;

      logger.info('Keap access token refreshed');
      return this.accessToken;
    } catch (error) {
      logger.error({ error }, 'Failed to refresh Keap access token');
      throw new Error('Failed to refresh Keap access token');
    }
  }

  async findContactByEmail(email: string): Promise<KeapContact | null> {
    try {
      const response = await this.axiosInstance.get('/contacts', {
        params: {
          email: email,
          optional_properties: 'custom_fields',
        },
      });

      const contacts = response.data.contacts;
      if (contacts && contacts.length > 0) {
        return contacts[0];
      }
      return null;
    } catch (error) {
      logger.error({ error, email }, 'Failed to find contact by email');
      throw error;
    }
  }

  async createOrUpdateContact(
    email: string,
    firstName: string,
    customFields?: Array<{ id: number; content: string }>
  ): Promise<KeapContact> {
    try {
      const existingContact = await this.findContactByEmail(email);

      const contactData: Record<string, unknown> = {
        email_addresses: [{ email: email, field: 'EMAIL1' }],
        given_name: firstName,
        duplicate_option: 'Email',
      };

      if (customFields && customFields.length > 0) {
        contactData.custom_fields = customFields;
      }

      if (existingContact) {
        const response = await this.axiosInstance.patch(
          `/contacts/${existingContact.id}`,
          contactData
        );
        logger.info({ contactId: existingContact.id, email }, 'Contact updated');
        return response.data;
      } else {
        const response = await this.axiosInstance.post('/contacts', contactData);
        logger.info({ contactId: response.data.id, email }, 'Contact created');
        return response.data;
      }
    } catch (error) {
      logger.error({ error, email }, 'Failed to create/update contact');
      throw error;
    }
  }

  /**
   * Find or create a contact for a Clickbank purchase
   *
   * Sets Clickbank-specific custom fields:
   * - CB_Customer: "Yes"
   * - CB_Last_Purchase_Date: Transaction timestamp
   * - CB_Last_Order_ID: Receipt number
   */
  async findOrCreateClickbankContact(
    email: string,
    firstName: string,
    lastName: string,
    receipt: string,
    transactionTime: string | null
  ): Promise<KeapContact> {
    try {
      const cbFields = getClickbankFieldIds();
      const customFields: Array<{ id: number; content: string }> = [];

      // CB_Customer = "Yes"
      if (cbFields.cbCustomer) {
        customFields.push({ id: cbFields.cbCustomer, content: 'Yes' });
      }

      // CB_Last_Purchase_Date
      if (cbFields.cbLastPurchaseDate && transactionTime) {
        customFields.push({ id: cbFields.cbLastPurchaseDate, content: transactionTime });
      }

      // CB_Last_Order_ID
      if (cbFields.cbLastOrderId) {
        customFields.push({ id: cbFields.cbLastOrderId, content: receipt });
      }

      const existingContact = await this.findContactByEmail(email);

      const contactData: Record<string, unknown> = {
        email_addresses: [{ email: email, field: 'EMAIL1' }],
        given_name: firstName,
        family_name: lastName,
        duplicate_option: 'Email',
      };

      if (customFields.length > 0) {
        contactData.custom_fields = customFields;
      }

      if (existingContact) {
        const response = await this.axiosInstance.patch(
          `/contacts/${existingContact.id}`,
          contactData
        );
        logger.info(
          { contactId: existingContact.id, email, receipt },
          'Clickbank contact updated'
        );
        return response.data;
      } else {
        const response = await this.axiosInstance.post('/contacts', contactData);
        logger.info({ contactId: response.data.id, email, receipt }, 'Clickbank contact created');
        return response.data;
      }
    } catch (error) {
      logger.error({ error, email, receipt }, 'Failed to find/create Clickbank contact');
      throw error;
    }
  }

  async applyTags(contactId: number, tagIds: number[]): Promise<void> {
    if (tagIds.length === 0) {
      logger.debug({ contactId }, 'No tags to apply');
      return;
    }

    try {
      await this.axiosInstance.post(`/contacts/${contactId}/tags`, {
        tagIds: tagIds,
      });
      logger.info({ contactId, tagIds }, 'Tags applied successfully');
    } catch (error) {
      logger.error({ error, contactId, tagIds }, 'Failed to apply tags');
      throw error;
    }
  }

  /**
   * Remove tags from a contact
   *
   * Keap API only allows removing one tag at a time, so we loop through
   * and remove each tag individually. Errors for individual tags are logged
   * but don't stop the process (tag may already be removed).
   */
  async removeTags(contactId: number, tagIds: number[]): Promise<void> {
    if (tagIds.length === 0) {
      logger.debug({ contactId }, 'No tags to remove');
      return;
    }

    const removedTags: number[] = [];
    const failedTags: number[] = [];

    for (const tagId of tagIds) {
      try {
        await this.axiosInstance.delete(`/contacts/${contactId}/tags/${tagId}`);
        removedTags.push(tagId);
      } catch (error) {
        // Tag might not exist on contact - log but continue
        logger.warn({ error, contactId, tagId }, 'Failed to remove tag (may not exist)');
        failedTags.push(tagId);
      }
    }

    if (removedTags.length > 0) {
      logger.info({ contactId, removedTags }, 'Tags removed successfully');
    }
    if (failedTags.length > 0) {
      logger.warn({ contactId, failedTags }, 'Some tags could not be removed');
    }
  }
}

export const keapClient = new KeapClient();
export default keapClient;
