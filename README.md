# Amare API

Centralized API service for handling newsletter signups and Clickbank IPN webhooks, integrating with Keap (Infusionsoft).

## Architecture Overview

```
┌─────────────────────┐     ┌─────────────────────┐
│   Brand Websites    │     │     Clickbank       │
│   (CHKH, HRYW)      │     │                     │
└─────────┬───────────┘     └─────────┬───────────┘
          │                           │
          │ POST /subscribe           │ POST /ipn/clickbank
          │                           │
          ▼                           ▼
┌─────────────────────────────────────────────────┐
│              Amare API (Cloud Run)              │
│                                                 │
│  ┌──────────────┐    ┌────────────────────────┐│
│  │  Subscribe   │    │    Clickbank IPN       ││
│  │   Handler    │    │       Handler          ││
│  └──────┬───────┘    └───────────┬────────────┘│
│         │                        │             │
│         │    ┌───────────────────┤             │
│         │    │                   │             │
│         ▼    ▼                   ▼             │
│  ┌──────────────┐    ┌────────────────────────┐│
│  │  Keap API    │    │      BigQuery          ││
│  │   Client     │    │  (tags + IPN logging)  ││
│  └──────────────┘    └────────────────────────┘│
└─────────────────────────────────────────────────┘
```

## Features

- **Newsletter Signup** (`POST /subscribe`)
  - Honeypot spam protection
  - Multi-brand support (CHKH, HRYW, etc.)
  - Contact creation/update in Keap
  - Automatic tag application based on brand
  - Rate limiting (10 requests/minute per IP)

- **Clickbank IPN Processing** (`POST /ipn/clickbank`)
  - Support for encrypted v6.0+ format
  - Legacy format support
  - Product → Tag mapping via BigQuery
  - IPN logging to BigQuery
  - Handles SALE, BILL, RFND, and other transaction types

## Prerequisites

- Node.js 20+
- GCP Project with:
  - BigQuery API enabled
  - Cloud Run API enabled
  - Artifact Registry repository
- Keap Developer Account
- Clickbank Vendor Account

## Local Development

### 1. Clone and Install

```bash
git clone https://github.com/ckgmra/amare-api.git
cd amare-api
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials (see [Environment Variables](#environment-variables)).

### 3. Run Locally

```bash
npm run dev
```

The server will start at `http://localhost:8080`.

### 4. Test Endpoints

```bash
# Health check
curl http://localhost:8080/health

# Subscribe test
curl -X POST http://localhost:8080/subscribe \
  -H "Content-Type: application/json" \
  -d '{"fname":"Test","em":"test@example.com","brand":"chkh"}'
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `KEAP_CLIENT_ID` | Keap OAuth2 Client ID | Yes |
| `KEAP_CLIENT_SECRET` | Keap OAuth2 Client Secret | Yes |
| `KEAP_REFRESH_TOKEN` | Keap OAuth2 Refresh Token | Yes |
| `CLICKBANK_SECRET_KEY` | Clickbank IPN Secret Key | Yes |
| `GCP_PROJECT_ID` | GCP Project ID | Yes |
| `BIGQUERY_DATASET` | BigQuery dataset name | No (default: `keap_integration`) |
| `BIGQUERY_TABLE_PRODUCT_TAGS` | Product tags table | No (default: `clickbank_product_tags`) |
| `BIGQUERY_TABLE_IPN_LOG` | IPN log table | No (default: `clickbank_ipn_log`) |
| `CHKH_SIGNUP_TAG_IDS` | Comma-separated tag IDs for CHKH signups | No |
| `HRYW_SIGNUP_TAG_IDS` | Comma-separated tag IDs for HRYW signups | No |
| `CORS_ORIGINS` | Comma-separated allowed origins | No |
| `PORT` | Server port | No (default: `8080`) |
| `NODE_ENV` | Environment (`development`/`production`) | No |

## Keap OAuth Setup

### Step 1: Create Keap Developer App

1. Go to [Keap Developer Portal](https://developer.keap.com/)
2. Sign in with your Keap account
3. Click "Create New App"
4. Fill in app details:
   - Name: `Amare API`
   - Description: `Newsletter signup and Clickbank integration`
5. Note down the **Client ID** and **Client Secret**

### Step 2: Get Initial Refresh Token

1. Build the authorization URL:
   ```
   https://accounts.infusionsoft.com/app/oauth/authorize?
     client_id=YOUR_CLIENT_ID&
     redirect_uri=https://localhost&
     response_type=code&
     scope=full
   ```

2. Visit this URL in your browser and authorize the app

3. You'll be redirected to `https://localhost?code=AUTHORIZATION_CODE`

4. Exchange the code for tokens:
   ```bash
   curl -X POST https://api.infusionsoft.com/token \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "grant_type=authorization_code" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "code=AUTHORIZATION_CODE" \
     -d "redirect_uri=https://localhost"
   ```

5. Save the `refresh_token` from the response

### Step 3: Find Tag IDs

To find tag IDs in Keap:

```bash
# Using the Keap API (after getting access token)
curl https://api.infusionsoft.com/crm/rest/v1/tags \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

Or find them in the Keap admin UI under Settings → Tags.

## Adding New Brands

Edit `src/config/brands.ts`:

```typescript
const brandsConfig: Record<string, BrandConfig> = {
  // Existing brands...

  newbrand: {
    brandCode: 'newbrand',
    signupTagIds: parseTagIds(process.env.NEWBRAND_SIGNUP_TAG_IDS || ''),
    customFieldPrefix: 'NEWBRAND',
    defaultRedirect: '/welcome',
  },
};
```

Then add `NEWBRAND_SIGNUP_TAG_IDS` to your environment variables.

## BigQuery Setup

### Product → Tag Mapping Table

The `clickbank_product_tags` table maps Clickbank product IDs to Keap tag IDs:

```sql
CREATE TABLE keap_integration.clickbank_product_tags (
  product_id STRING NOT NULL,
  tag_id INT64 NOT NULL,
  tag_name STRING,
  active BOOL NOT NULL,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Example: Add a product-tag mapping
INSERT INTO keap_integration.clickbank_product_tags
  (product_id, tag_id, tag_name, active, created_at)
VALUES
  ('myebook', 123, 'Purchased: My Ebook', true, CURRENT_TIMESTAMP());
```

### IPN Log Table

The `clickbank_ipn_log` table stores all incoming IPNs for debugging and auditing:

```sql
CREATE TABLE keap_integration.clickbank_ipn_log (
  receipt STRING,
  transaction_type STRING,
  vendor STRING,
  email STRING,
  product_id STRING,
  raw_payload STRING,
  is_test BOOL NOT NULL,
  is_encrypted BOOL NOT NULL,
  source_ip STRING,
  user_agent STRING,
  processing_status STRING NOT NULL,
  processing_error STRING,
  tags_applied STRING,
  created_at TIMESTAMP NOT NULL
);
```

## Deployment

### Using Cloud Build (Recommended)

1. **Create Artifact Registry Repository**
   ```bash
   gcloud artifacts repositories create amare-api \
     --repository-format=docker \
     --location=us-central1
   ```

2. **Set up Cloud Build Trigger**
   - Go to Cloud Build → Triggers
   - Connect your GitHub repository
   - Create trigger for pushes to `main` branch
   - Use `cloudbuild.yaml` as the build configuration

3. **Configure Secrets**
   ```bash
   # Store secrets in Secret Manager
   echo -n "your-keap-client-id" | gcloud secrets create KEAP_CLIENT_ID --data-file=-
   echo -n "your-keap-client-secret" | gcloud secrets create KEAP_CLIENT_SECRET --data-file=-
   echo -n "your-keap-refresh-token" | gcloud secrets create KEAP_REFRESH_TOKEN --data-file=-
   echo -n "your-clickbank-secret" | gcloud secrets create CLICKBANK_SECRET_KEY --data-file=-
   ```

4. **Update Cloud Run Service**
   ```bash
   gcloud run services update amare-api \
     --region=us-central1 \
     --set-secrets="KEAP_CLIENT_ID=KEAP_CLIENT_ID:latest,KEAP_CLIENT_SECRET=KEAP_CLIENT_SECRET:latest,KEAP_REFRESH_TOKEN=KEAP_REFRESH_TOKEN:latest,CLICKBANK_SECRET_KEY=CLICKBANK_SECRET_KEY:latest" \
     --set-env-vars="GCP_PROJECT_ID=watchful-force-477418-b9,CORS_ORIGINS=https://www.havetherelationshipyouwant.com,https://www.catchhimandkeephim.com,https://www.heartsintrueharmony.com,https://www.flourishtogether.com"
   ```

### Manual Deployment

```bash
# Build and push
docker build -t us-central1-docker.pkg.dev/watchful-force-477418-b9/amare-api/amare-api:latest .
docker push us-central1-docker.pkg.dev/watchful-force-477418-b9/amare-api/amare-api:latest

# Deploy
gcloud run deploy amare-api \
  --image=us-central1-docker.pkg.dev/watchful-force-477418-b9/amare-api/amare-api:latest \
  --region=us-central1 \
  --platform=managed \
  --allow-unauthenticated
```

## API Reference

### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### `POST /subscribe`

Process newsletter signup.

**Request Body:**
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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fname` | string | Yes | First name |
| `em` | string | Yes | Email address |
| `brand` | string | Yes | Brand code (chkh, hryw, etc.) |
| `sourceId` | string | No | Tracking source identifier |
| `redirectSlug` | string | No | Custom redirect path |
| `website` | string | No | Honeypot field (must be empty) |

**Response (Success):**
```json
{
  "success": true,
  "redirectUrl": "/thank-you"
}
```

**Response (Error):**
```json
{
  "success": false,
  "error": "Missing required fields: fname, em, brand"
}
```

### `POST /ipn/clickbank`

Process Clickbank IPN webhook.

**Request Body (Encrypted v6.0+):**
```json
{
  "notification": "base64-encoded-encrypted-data",
  "iv": "base64-encoded-iv"
}
```

**Response:** Always returns `200 OK` with body `OK` to prevent Clickbank retries.

### `GET /ipn/clickbank`

Clickbank URL validation endpoint.

**Response:** `200 OK` with body `OK`

## Troubleshooting

### Keap Token Errors

If you see "Failed to refresh Keap access token":
1. Verify your refresh token is valid
2. Check that Client ID and Secret are correct
3. Refresh tokens can expire - you may need to re-authorize

### BigQuery Errors

If you see BigQuery errors:
1. Verify the service account has BigQuery access
2. Check that the dataset and tables exist
3. Verify `GCP_PROJECT_ID` is correct

### Clickbank Decryption Errors

If IPNs aren't decrypting:
1. Verify `CLICKBANK_SECRET_KEY` matches your Clickbank account
2. Check that Clickbank is sending v6.0+ encrypted format
3. Review IPN logs in BigQuery for details

## Scripts

```bash
npm run dev        # Start development server with hot reload
npm run build      # Compile TypeScript
npm run start      # Start production server
npm run lint       # Run ESLint
npm run lint:fix   # Fix ESLint issues
npm run format     # Format with Prettier
npm run typecheck  # TypeScript type checking
```

## License

ISC
