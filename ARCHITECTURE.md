# Amare API - Architecture & Operations Guide

## Overview

The Amare API is a centralized service that handles two main functions:
1. **Newsletter signups** from brand websites (CHKH, HRYW, GKH, FLO)
2. **Clickbank IPN webhooks** for purchase notifications

Both functions integrate with **Keap (Infusionsoft)** to manage contacts and apply tags.

---

## Why This Service Exists

### Problem 1: Newsletter Form Submissions
- Direct form POSTs to Keap require client-side JavaScript
- Server-side POSTs get stuck in Keap's redirect loops
- We wanted to obfuscate form field names (prevent password managers from autofilling)
- Each brand site needed duplicate integration code

### Problem 2: Clickbank Purchase Tracking
- Clickbank IPNs need a dedicated webhook receiver
- IPNs arrive encrypted (v6.0+ format) and need decryption
- Purchase tags need to be applied to Keap contacts
- Refunds need to remove access tags
- All brands share one Keap account but need brand-specific handling

### Solution
A single Cloud Run API service that:
- Receives form submissions and IPN webhooks
- Handles all Keap OAuth and API calls centrally
- Maps products to tags via BigQuery configuration
- Logs all transactions for reporting and debugging

---

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐
│   Brand Websites    │     │     Clickbank       │
│ (CHKH, HRYW, GKH,   │     │                     │
│       FLO)          │     │                     │
└─────────┬───────────┘     └─────────┬───────────┘
          │                           │
          │ POST /subscribe           │ POST /ipn/clickbank
          │                           │
          ▼                           ▼
┌─────────────────────────────────────────────────────┐
│           Amare API (Cloud Run)                     │
│           https://amare-api-xxx-uc.a.run.app        │
│                                                     │
│  ┌─────────────────┐    ┌─────────────────────────┐│
│  │   /subscribe    │    │    /ipn/clickbank       ││
│  │   - Honeypot    │    │    - Decrypt IPN        ││
│  │   - Rate limit  │    │    - Query tag actions  ││
│  │   - Brand tags  │    │    - Apply/remove tags  ││
│  └────────┬────────┘    └────────────┬────────────┘│
│           │                          │             │
│           └──────────┬───────────────┘             │
│                      ▼                             │
│           ┌─────────────────┐                      │
│           │   Keap Client   │                      │
│           │   (OAuth2)      │                      │
│           └────────┬────────┘                      │
└────────────────────┼───────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌───────────────┐        ┌───────────────────┐
│     Keap      │        │     BigQuery      │
│ (Infusionsoft)│        │                   │
│               │        │ - Product→Tag map │
│ - Contacts    │        │ - Transaction log │
│ - Tags        │        │ - IPN log         │
└───────────────┘        └───────────────────┘
```

---

## Endpoints

### `GET /health`
Health check endpoint for monitoring.

**Response:** `{ "status": "ok", "timestamp": "..." }`

### `POST /subscribe`
Newsletter signup from brand websites.

**Request:**
```json
{
  "fname": "John",
  "em": "john@example.com",
  "brand": "chkh",
  "sourceId": "homepage-popup",
  "redirectSlug": "/thank-you",
  "website": ""
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `fname` | Yes | First name |
| `em` | Yes | Email address |
| `brand` | Yes | Brand code: `chkh`, `hryw`, `gkh`, `flo` |
| `sourceId` | No | Tracking source (e.g., "homepage-popup") |
| `redirectSlug` | No | Custom redirect path after signup |
| `website` | No | **Honeypot field - must be empty** |

**Response:**
```json
{
  "success": true,
  "redirectUrl": "/thank-you"
}
```

**What happens:**
1. Honeypot check (rejects if `website` has value)
2. Rate limit check (10 requests/minute per IP)
3. Creates/updates contact in Keap
4. Sets custom fields (Brand, DP_SOURCE_ID, DP_IP_ADDRESS, etc.)
5. Applies brand-specific signup tags

### `POST /ipn/clickbank`
Clickbank Instant Payment Notification webhook.

**Request:** Encrypted JSON from Clickbank
```json
{
  "notification": "base64-encrypted-data",
  "iv": "base64-iv"
}
```

**Response:** Always `200 OK` (Clickbank requirement)

**What happens:**
1. Decrypts the IPN payload (AES-256-CBC)
2. Extracts transaction details (email, product, amount, affiliate, etc.)
3. Queries BigQuery for tag actions based on product + transaction type
4. Finds or creates contact in Keap
5. Applies tags (for SALE) or removes tags (for RFND/CGBK)
6. Logs transaction to BigQuery (including affiliate for reporting)

**Transaction Types Handled:**
| Type | Action |
|------|--------|
| `SALE`, `REBILL` | Apply purchase/access tags |
| `RFND`, `CGBK` | Apply refund tag, remove access tags |
| `CANCEL-REBILL` | Log only (no tag changes) |
| `TEST`, `TEST_SALE` | Process normally (for testing) |

### `GET /ipn/clickbank`
Clickbank URL validation (returns `OK`).

---

## Infrastructure

### Where It Lives

| Component | Location | URL/ID |
|-----------|----------|--------|
| **Source Code** | GitHub | https://github.com/ckgmra/amare-api |
| **Container Images** | Artifact Registry | `us-central1-docker.pkg.dev/watchful-force-477418-b9/amare-api` |
| **Running Service** | Cloud Run | `us-central1` region |
| **CI/CD** | Cloud Build | Triggered on push to `main` |
| **Secrets** | Secret Manager | Keap OAuth, Clickbank key |
| **Data** | BigQuery | `watchful-force-477418-b9.keap_integration` |

### GCP Project
- **Name:** Amare
- **ID:** `watchful-force-477418-b9`
- **Number:** `488123902545`
- **Account:** `matt@strookoo.com`

### GitHub
- **Account:** `ckgmra`
- **Repository:** `amare-api`

---

## Configuration

### Environment Variables (set in Cloud Run)

| Variable | Source | Description |
|----------|--------|-------------|
| `KEAP_CLIENT_ID` | Secret Manager | Keap OAuth client ID |
| `KEAP_CLIENT_SECRET` | Secret Manager | Keap OAuth client secret |
| `KEAP_REFRESH_TOKEN` | Secret Manager | Keap OAuth refresh token |
| `CLICKBANK_SECRET_KEY` | Secret Manager | Clickbank IPN decryption key |
| `GCP_PROJECT_ID` | Env var | `watchful-force-477418-b9` |
| `CORS_ORIGINS` | Env var | Allowed origins for /subscribe |
| `NODE_ENV` | Env var | `production` |

### BigQuery Tables

**Dataset:** `keap_integration`

#### `clickbank_product_tags`
Maps Clickbank products to Keap tags by transaction type.

```sql
product_id      STRING    -- Clickbank product ID (e.g., "myebook")
brand           STRING    -- Brand code (chkh, hryw, etc.)
transaction_type STRING   -- SALE, RFND, CGBK
action          STRING    -- APPLY or REMOVE
tag_id          INT64     -- Keap tag ID
tag_name        STRING    -- Human-readable tag name
active          BOOL      -- Whether this mapping is active
```

**Example rows:**
| product_id | brand | transaction_type | action | tag_id | tag_name |
|------------|-------|------------------|--------|--------|----------|
| myebook | chkh | SALE | APPLY | 123 | Purchased: My Ebook |
| myebook | chkh | SALE | APPLY | 456 | Access: Members Area |
| myebook | chkh | RFND | REMOVE | 456 | Access: Members Area |
| myebook | chkh | RFND | APPLY | 789 | Refunded |

#### `clickbank_transactions`
Logs all Clickbank transactions for reporting.

```sql
receipt             STRING      -- Clickbank receipt number
email               STRING      -- Customer email
first_name          STRING
last_name           STRING
product_id          STRING
transaction_type    STRING      -- SALE, RFND, etc.
amount              NUMERIC     -- Transaction amount
currency            STRING      -- USD
affiliate           STRING      -- Affiliate ID (for commission tracking)
clickbank_timestamp TIMESTAMP
keap_contact_id     INT64       -- Keap contact ID
tags_applied        ARRAY<INT64>
tags_removed        ARRAY<INT64>
processed_at        TIMESTAMP
processing_status   STRING      -- SUCCESS, FAILED, SKIPPED, NO_TAGS
error_message       STRING
brand               STRING
```

#### `clickbank_ipn_log`
Raw IPN logging for debugging.

---

## Deployment

### Automatic (CI/CD)

Push to `main` branch triggers Cloud Build:

```bash
git add .
git commit -m "Your changes"
git push origin main
```

Cloud Build will:
1. Build Docker image
2. Push to Artifact Registry
3. Deploy to Cloud Run with secrets

**Monitor builds:** https://console.cloud.google.com/cloud-build/builds?project=watchful-force-477418-b9

### Manual

```bash
# Build locally
docker build -t amare-api .

# Push to Artifact Registry
docker tag amare-api us-central1-docker.pkg.dev/watchful-force-477418-b9/amare-api/amare-api:latest
docker push us-central1-docker.pkg.dev/watchful-force-477418-b9/amare-api/amare-api:latest

# Deploy to Cloud Run
gcloud run deploy amare-api \
  --image=us-central1-docker.pkg.dev/watchful-force-477418-b9/amare-api/amare-api:latest \
  --region=us-central1 \
  --project=watchful-force-477418-b9
```

---

## Local Development

```bash
cd /Users/malcorn/amare/amare-api

# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your credentials

# Run development server
npm run dev

# Test endpoints
curl http://localhost:8080/health
curl -X POST http://localhost:8080/subscribe \
  -H "Content-Type: application/json" \
  -d '{"fname":"Test","em":"test@example.com","brand":"chkh"}'
```

---

## Adding a New Brand

1. **Update brand config** in `src/config/brands.ts`:
```typescript
newbrand: {
  brandCode: 'newbrand',
  signupTagIds: parseTagIds(process.env.NEWBRAND_SIGNUP_TAG_IDS || ''),
  customFieldPrefix: 'NEWBRAND',
  defaultRedirect: '/catalog/ebook',
},
```

2. **Update SUPPORTED_BRANDS** in `src/config/keapFields.ts`

3. **Add tag IDs** to Cloud Run environment variables

4. **Update CORS_ORIGINS** if the brand has a new domain

5. **Add product→tag mappings** in BigQuery for Clickbank products

---

## Adding a New Clickbank Product

Insert rows into `clickbank_product_tags`:

```sql
-- For SALE transactions (apply access tags)
INSERT INTO `watchful-force-477418-b9.keap_integration.clickbank_product_tags`
  (product_id, brand, transaction_type, action, tag_id, tag_name, active)
VALUES
  ('newproduct', 'chkh', 'SALE', 'APPLY', 123, 'Purchased: New Product', true),
  ('newproduct', 'chkh', 'SALE', 'APPLY', 456, 'Access: New Product Area', true);

-- For RFND transactions (remove access, apply refund tag)
INSERT INTO `watchful-force-477418-b9.keap_integration.clickbank_product_tags`
  (product_id, brand, transaction_type, action, tag_id, tag_name, active)
VALUES
  ('newproduct', 'chkh', 'RFND', 'REMOVE', 456, 'Access: New Product Area', true),
  ('newproduct', 'chkh', 'RFND', 'APPLY', 789, 'Refunded', true);
```

---

## Keap OAuth

### Credentials Location
- **Developer Portal:** https://developer.keap.com/
- **App Name:** Amare API
- **Keap Account:** qcc712.infusionsoft.com

### Token Refresh
The API automatically refreshes the access token using the refresh token stored in Secret Manager. Tokens expire after 24 hours but are refreshed automatically.

### If Refresh Token Expires
Refresh tokens can expire if unused for extended periods. To get a new one:

1. Generate auth URL:
```
https://accounts.infusionsoft.com/app/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=https://localhost&response_type=code&scope=full
```

2. Visit URL, authorize, copy the `code` from redirect

3. Exchange for tokens:
```bash
curl -X POST https://api.infusionsoft.com/token \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=AUTH_CODE" \
  -d "redirect_uri=https://localhost"
```

4. Update Secret Manager:
```bash
echo -n "NEW_REFRESH_TOKEN" | gcloud secrets versions add KEAP_REFRESH_TOKEN --data-file=-
```

---

## Monitoring & Debugging

### Logs
```bash
# View Cloud Run logs
gcloud run services logs read amare-api --region=us-central1 --project=watchful-force-477418-b9

# Or in console
# https://console.cloud.google.com/run/detail/us-central1/amare-api/logs?project=watchful-force-477418-b9
```

### BigQuery Queries

```sql
-- Recent transactions
SELECT * FROM `watchful-force-477418-b9.keap_integration.clickbank_transactions`
ORDER BY processed_at DESC
LIMIT 100;

-- Failed transactions
SELECT * FROM `watchful-force-477418-b9.keap_integration.clickbank_transactions`
WHERE processing_status = 'FAILED'
ORDER BY processed_at DESC;

-- Transactions by affiliate
SELECT affiliate, COUNT(*) as count, SUM(amount) as total
FROM `watchful-force-477418-b9.keap_integration.clickbank_transactions`
WHERE transaction_type = 'SALE'
GROUP BY affiliate
ORDER BY total DESC;

-- Raw IPN log (for debugging decryption issues)
SELECT * FROM `watchful-force-477418-b9.keap_integration.clickbank_ipn_log`
WHERE processing_status = 'decryption_failed'
ORDER BY created_at DESC;
```

---

## Troubleshooting

### "Failed to refresh Keap access token"
- Refresh token may have expired (see [Keap OAuth](#if-refresh-token-expires))
- Check Secret Manager has correct values

### Clickbank IPNs not being processed
- Check IPN URL is configured in Clickbank: `https://YOUR-CLOUD-RUN-URL/ipn/clickbank`
- Verify CLICKBANK_SECRET_KEY matches your Clickbank account
- Check `clickbank_ipn_log` table for decryption errors

### Tags not being applied
- Check `clickbank_product_tags` table has mappings for the product + transaction type
- Verify tag IDs exist in Keap
- Check `clickbank_transactions` table for error messages

### CORS errors on /subscribe
- Add the domain to CORS_ORIGINS environment variable
- Redeploy the service

---

## File Structure

```
amare-api/
├── src/
│   ├── config/
│   │   ├── brands.ts         # Brand configurations
│   │   └── keapFields.ts     # Keap custom field definitions
│   ├── routes/
│   │   ├── subscribe.ts      # POST /subscribe handler
│   │   └── clickbank.ts      # POST /ipn/clickbank handler
│   ├── services/
│   │   ├── keap.ts           # Keap API client (OAuth2)
│   │   ├── clickbank.ts      # IPN decryption
│   │   └── bigquery.ts       # BigQuery client
│   ├── types/
│   │   └── index.ts          # TypeScript interfaces
│   ├── utils/
│   │   └── logger.ts         # Pino structured logging
│   └── index.ts              # Fastify server entry point
├── Dockerfile                # Multi-stage Docker build
├── cloudbuild.yaml           # Cloud Build CI/CD config
├── package.json
├── tsconfig.json
├── .env.example              # Environment variable template
└── README.md                 # Quick start guide
```

---

## Security Notes

- All secrets stored in GCP Secret Manager (not in code or env files)
- Honeypot field prevents basic bot submissions
- Rate limiting on /subscribe (10 req/min per IP)
- Cloud Run service is public (required for Clickbank webhooks)
- CORS configured to allow only known brand domains
- Clickbank IPNs validated via decryption (only valid if secret key matches)
