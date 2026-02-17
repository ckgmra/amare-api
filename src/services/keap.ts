import axios, { AxiosInstance } from 'axios';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
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
  private currentRefreshToken: string | null = null;
  private axiosInstance: AxiosInstance;
  private secretManagerClient: SecretManagerServiceClient;
  private projectId: string;

  constructor() {
    this.projectId = process.env.GCP_PROJECT_ID || 'watchful-force-477418-b9';
    this.secretManagerClient = new SecretManagerServiceClient();

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

  /**
   * Save new refresh token to Secret Manager
   * Keap refresh tokens are single-use - each refresh returns a new one
   */
  private async saveRefreshToken(newToken: string): Promise<void> {
    try {
      const secretName = `projects/${this.projectId}/secrets/KEAP_REFRESH_TOKEN`;

      // Add a new version with the new refresh token
      await this.secretManagerClient.addSecretVersion({
        parent: secretName,
        payload: {
          data: Buffer.from(newToken, 'utf8'),
        },
      });

      // Update our in-memory copy
      this.currentRefreshToken = newToken;

      logger.info('Saved new Keap refresh token to Secret Manager');
    } catch (error) {
      // Log but don't throw - the current request can still succeed
      // Next request will fail though if we don't have the new token
      logger.error({ error }, 'Failed to save new refresh token to Secret Manager');
    }
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();

    if (this.accessToken && this.tokenExpiry > now + 60000) {
      return this.accessToken;
    }

    const clientId = process.env.KEAP_CLIENT_ID;
    const clientSecret = process.env.KEAP_CLIENT_SECRET;
    // Use in-memory token if we have one (from previous refresh), else use env var
    const refreshToken = this.currentRefreshToken || process.env.KEAP_REFRESH_TOKEN;

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

      // IMPORTANT: Save the new refresh token - Keap tokens are single-use!
      if (response.data.refresh_token && response.data.refresh_token !== refreshToken) {
        await this.saveRefreshToken(response.data.refresh_token);
      }

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
        // duplicate_option must be a query parameter, not in the body
        const response = await this.axiosInstance.post('/contacts', contactData, {
          params: { duplicate_option: 'Email' }
        });
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
        // duplicate_option must be a query parameter, not in the body
        const response = await this.axiosInstance.post('/contacts', contactData, {
          params: { duplicate_option: 'Email' }
        });
        logger.info({ contactId: response.data.id, email, receipt }, 'Clickbank contact created');
        return response.data;
      }
    } catch (error) {
      logger.error({ error, email, receipt }, 'Failed to find/create Clickbank contact');
      throw error;
    }
  }

  /**
   * Get tags applied to a contact.
   * Returns array of { id, name } objects.
   */
  async getContactTags(contactId: number): Promise<Array<{ id: number; name: string }>> {
    try {
      const response = await this.axiosInstance.get(`/contacts/${contactId}/tags`);
      const tags = response.data.tags || [];
      return tags.map((t: { tag: { id: number; name: string } }) => ({
        id: t.tag.id,
        name: t.tag.name,
      }));
    } catch (error) {
      logger.error({ error, contactId }, 'Failed to get contact tags');
      return [];
    }
  }

  /**
   * Determine brand from a contact's tags.
   * Scans tag names for brand prefixes (HRYW-, FLO-, CHKH-, GKH-).
   */
  async detectBrandFromTags(contactId: number): Promise<string | null> {
    const tags = await this.getContactTags(contactId);
    const brandPrefixes = ['HRYW', 'FLO', 'CHKH', 'GKH'];
    for (const tag of tags) {
      for (const prefix of brandPrefixes) {
        if (tag.name.toUpperCase().startsWith(prefix + '-') || tag.name.toUpperCase() === prefix) {
          return prefix.toLowerCase();
        }
      }
    }
    return null;
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
   * Create or update a contact with pass-through custom fields
   *
   * Custom fields are passed as field_name → value pairs.
   * We need to look up field IDs from Keap first.
   */
  async createOrUpdateContactWithFields(
    email: string,
    firstName: string,
    customFields: Record<string, string>
  ): Promise<KeapContact> {
    try {
      const existingContact = await this.findContactByEmail(email);

      // Convert field names to field IDs
      const customFieldsArray = await this.convertFieldNamesToIds(customFields);

      logger.info({
        inputFields: Object.keys(customFields),
        mappedFields: customFieldsArray,
        existingContactId: existingContact?.id
      }, 'Preparing contact data');

      const contactData: Record<string, unknown> = {
        email_addresses: [{ email: email, field: 'EMAIL1' }],
        given_name: firstName,
      };

      if (customFieldsArray.length > 0) {
        contactData.custom_fields = customFieldsArray;
      }

      logger.info({ contactData }, 'Sending to Keap');

      if (existingContact) {
        const response = await this.axiosInstance.patch(
          `/contacts/${existingContact.id}`,
          contactData
        );
        logger.info({ contactId: existingContact.id, email }, 'Contact updated with custom fields');
        return response.data;
      } else {
        // duplicate_option must be a query parameter, not in the body
        const response = await this.axiosInstance.post('/contacts', contactData, {
          params: { duplicate_option: 'Email' }
        });
        logger.info({ contactId: response.data.id, email }, 'Contact created with custom fields');
        return response.data;
      }
    } catch (error) {
      // Try to extract response body for better error info
      const axiosError = error as { response?: { data?: unknown; status?: number } };
      logger.error({
        error,
        email,
        responseData: axiosError.response?.data,
        responseStatus: axiosError.response?.status
      }, 'Failed to create/update contact with custom fields');
      throw error;
    }
  }

  /**
   * Convert field names to Keap field IDs
   * Caches the field mapping to avoid repeated API calls
   */
  private fieldNameToIdCache: Map<string, number> | null = null;

  private async getFieldNameToIdMap(): Promise<Map<string, number>> {
    if (this.fieldNameToIdCache) {
      return this.fieldNameToIdCache;
    }

    try {
      const response = await this.axiosInstance.get('/contactCustomFields');
      // Keap API returns array directly, or may have custom_fields property
      const fields = Array.isArray(response.data) ? response.data : (response.data.custom_fields || []);

      logger.info({ rawFieldCount: fields.length, sampleField: fields[0] }, 'Fetched Keap custom fields');

      this.fieldNameToIdCache = new Map();
      for (const field of fields) {
        // Store by label (display name)
        if (field.label) {
          this.fieldNameToIdCache.set(field.label, field.id);
        }
        // Also store by database name if different
        if (field.field_name && field.field_name !== field.label) {
          this.fieldNameToIdCache.set(field.field_name, field.id);
        }
      }

      logger.info({ fieldCount: this.fieldNameToIdCache.size }, 'Cached Keap custom field mappings');
      return this.fieldNameToIdCache;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch Keap custom fields');
      throw error;
    }
  }

  private async convertFieldNamesToIds(
    fields: Record<string, string>
  ): Promise<Array<{ id: number; content: string }>> {
    const fieldMap = await this.getFieldNameToIdMap();
    const result: Array<{ id: number; content: string }> = [];

    for (const [name, value] of Object.entries(fields)) {
      // Skip empty values - Keap may reject them
      if (!value || value.trim() === '') {
        logger.debug({ fieldName: name }, 'Skipping empty field value');
        continue;
      }

      const fieldId = fieldMap.get(name);
      if (fieldId) {
        result.push({ id: fieldId, content: value });
      } else {
        logger.warn({ fieldName: name }, 'Unknown Keap custom field name, skipping');
      }
    }

    return result;
  }

  /**
   * Apply a tag by name (looks up tag ID first)
   * Caches the tag mapping to avoid repeated API calls
   */
  private tagNameToIdCache: Map<string, number> | null = null;

  private async getTagNameToIdMap(): Promise<Map<string, number>> {
    if (this.tagNameToIdCache) {
      return this.tagNameToIdCache;
    }

    try {
      // Fetch all tags (paginated)
      this.tagNameToIdCache = new Map();
      let offset = 0;
      const limit = 1000;
      let hasMore = true;

      while (hasMore) {
        const response = await this.axiosInstance.get('/tags', {
          params: { offset, limit },
        });

        const tags = response.data.tags || [];
        for (const tag of tags) {
          if (tag.name) {
            this.tagNameToIdCache.set(tag.name, tag.id);
          }
        }

        hasMore = tags.length === limit;
        offset += limit;
      }

      logger.info({ tagCount: this.tagNameToIdCache.size }, 'Cached Keap tag mappings');
      return this.tagNameToIdCache;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch Keap tags');
      throw error;
    }
  }

  async applyTagByName(contactId: number, tagName: string): Promise<void> {
    try {
      const tagMap = await this.getTagNameToIdMap();
      const tagId = tagMap.get(tagName);

      if (!tagId) {
        throw new Error(`Unknown tag: ${tagName}`);
      }

      await this.axiosInstance.post(`/contacts/${contactId}/tags`, {
        tagIds: [tagId],
      });
      logger.info({ contactId, tagName, tagId }, 'Tag applied by name');
    } catch (error) {
      logger.error({ error, contactId, tagName }, 'Failed to apply tag by name');
      throw error;
    }
  }

  /**
   * Opt-in a contact for email marketing
   *
   * This is REQUIRED for contacts to receive marketing emails.
   * Without calling this, Keap will show "no evidence that this person
   * has consented to receive marketing" and won't send emails.
   *
   * @param email - The email address to opt-in
   * @param reason - The reason for opt-in (e.g., "Website signup form")
   */
  async optInEmail(email: string, reason: string = 'Website signup form'): Promise<void> {
    try {
      await this.axiosInstance.post('/emails/unsub', {
        email_address: email,
        opt_in: true,
        opt_in_reason: reason,
      });
      logger.info({ email, reason }, 'Contact opted in for email marketing');
    } catch (error) {
      // Try alternative method - update contact directly with opt_in_reason
      try {
        const contact = await this.findContactByEmail(email);
        if (contact) {
          await this.axiosInstance.patch(`/contacts/${contact.id}`, {
            opt_in_reason: reason,
          });
          logger.info({ email, contactId: contact.id, reason }, 'Contact opted in via contact update');
        }
      } catch (fallbackError) {
        logger.error({ error: fallbackError, email }, 'Failed to opt-in contact (fallback)');
        throw fallbackError;
      }
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

  /**
   * Add a note to a contact
   *
   * Used for ClickBank refund/chargeback tracking
   * @param contactId - The Keap contact ID
   * @param noteText - The note text (e.g., 'Cancelled_HRYW_MS')
   */
  async addNote(contactId: number, noteText: string): Promise<void> {
    try {
      await this.axiosInstance.post(`/contacts/${contactId}/notes`, {
        title: 'ClickBank Transaction',
        body: noteText,
        type: 'Other',
      });
      logger.info({ contactId, noteText }, 'Note added to contact');
    } catch (error) {
      logger.error({ error, contactId, noteText }, 'Failed to add note to contact');
      throw error;
    }
  }
  /**
   * List recent transactions for a contact, ordered newest first.
   * Used to find transactions that had id=0 at webhook time.
   */
  async getRecentTransactionsForContact(contactId: number, limit: number = 10): Promise<Array<Record<string, unknown>>> {
    try {
      const response = await this.axiosInstance.get('/transactions', {
        params: {
          contact_id: contactId,
          limit,
          order: 'date',
          order_direction: 'descending',
        },
      });
      return response.data.transactions || [];
    } catch (error) {
      logger.error({ error, contactId }, 'Failed to get recent transactions for contact');
      return [];
    }
  }

  /**
   * Create a REST hook subscription
   */
  async createHook(eventKey: string, hookUrl: string): Promise<unknown> {
    const response = await this.axiosInstance.post('/hooks', {
      eventKey,
      hookUrl,
    });
    return response.data;
  }

  /**
   * Verify a REST hook by key
   */
  async verifyHook(hookKey: number): Promise<unknown> {
    const response = await this.axiosInstance.post(`/hooks/${hookKey}/verify`);
    return response.data;
  }

  /**
   * Get a contact by ID
   */
  async getContactById(contactId: number): Promise<KeapContact | null> {
    try {
      const response = await this.axiosInstance.get(`/contacts/${contactId}`, {
        params: {
          optional_properties: 'custom_fields,phone_numbers,addresses',
        },
      });
      return response.data;
    } catch (error) {
      const axiosErr = error as { response?: { status?: number } };
      if (axiosErr.response?.status === 404) return null;
      logger.error({ error, contactId }, 'Failed to get contact by ID');
      throw error;
    }
  }

  /**
   * Get a payment by ID (from Keap REST API)
   * Returns payment details including invoice_id, contact_id, amount, etc.
   */
  async getPayment(paymentId: number): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.axiosInstance.get(`/orders/${paymentId}/payments`);
      // The payments endpoint returns an array — but we can also try the transaction endpoint
      return response.data;
    } catch (error) {
      const axiosErr = error as { response?: { status?: number } };
      if (axiosErr.response?.status === 404) return null;
      logger.error({ error, paymentId }, 'Failed to get payment by ID');
      throw error;
    }
  }

  /**
   * Get an order (invoice) by ID
   * Returns order details including contact, line items, amounts
   */
  async getOrder(orderId: number): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.axiosInstance.get(`/orders/${orderId}`);
      return response.data;
    } catch (error) {
      const axiosErr = error as { response?: { status?: number } };
      if (axiosErr.response?.status === 404) return null;
      logger.error({ error, orderId }, 'Failed to get order by ID');
      throw error;
    }
  }

  /**
   * Get a transaction (payment) by ID
   * Returns payment details including contact_id, order_ids, amount
   */
  async getTransaction(transactionId: number): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.axiosInstance.get(`/transactions/${transactionId}`);
      return response.data;
    } catch (error) {
      const axiosErr = error as { response?: { status?: number } };
      if (axiosErr.response?.status === 404) return null;
      logger.error({ error, transactionId }, 'Failed to get transaction by ID');
      throw error;
    }
  }
}

export const keapClient = new KeapClient();
export default keapClient;
