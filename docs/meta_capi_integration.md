# Meta Conversions API (CAPI) Integration

## Quick Summary

All four Amare brand sites (HRYW, CHKH, GKH, FLO) send **server-side events** to Meta (Facebook) via the Conversions API alongside the standard browser pixel. This gives Meta better data for ad optimization, even when ad blockers prevent the browser pixel from firing.

**Three event types are tracked:**

- **Subscribe** — Fires when someone signs up via a newsletter form. Sent from both the browser pixel AND the server (deduplicated by a shared event ID).
- **Purchase** — Fires when a payment is recorded in Keap and it is either a one-time product or the **first billing** of a subscription. Server-only.
- **RecurringPayment** — Fires when a Keap payment belongs to a subscription plan that already has prior paid invoices for that contact. Server-only. This is a custom Meta event (not a standard event).

**Key infrastructure:**

| Component | Purpose |
|-----------|---------|
| Next.js sites (x4) | Browser pixel + tracking data collection |
| Cloud Run API (`amare-api`) | Server-side CAPI sends, Keap webhook handler |
| BigQuery `tracking_context` | Stores browser tracking data per subscriber |
| BigQuery `meta_capi_queue` | Durable queue for all CAPI sends with retry |
| Keap REST Hook | Triggers Purchase events on invoice payment |
| Google Secret Manager | Stores Meta access tokens per brand |

---

## Architecture Overview

```
                         SUBSCRIBE FLOW
                         ==============

  Browser                    Vercel                    Cloud Run                  Meta
  -------                    ------                    ---------                  ----
  User fills form
  JS captures:
    - _fbp cookie
    - _fbc cookie
    - fbclid, UTMs
    - client IP (ipify)
    - pixel ID
    - event ID (UUID)
       |
       |-- fbq('track','Subscribe', {}, {eventID})  ------>  Meta Pixel (browser)
       |
       |-- POST /api/subscribe  ------->  Forwards to
                                          Cloud Run
                                              |
                                              |-- Create/update Keap contact
                                              |-- Apply tags, opt-in
                                              |-- Insert tracking_context (BigQuery)
                                              |-- Enrich with Keap data (ln, ph)
                                              |-- POST to Meta CAPI  ----------->  Meta CAPI (server)
                                              |     (via durable queue)
                                              |
                                              |   Meta deduplicates browser + server
                                              |   events using the shared event_id


                         PURCHASE / RECURRING FLOW
                         =========================

  Keap                       Cloud Run                                     Meta
  ----                       ---------                                     ----
  Payment recorded
       |
       |-- POST /webhooks/keap/invoice-payment
           (REST Hook, object_keys: [{id, ...}])
                                |
                                |-- GET /transactions/{id} from Keap
                                |-- GET /contacts/{id} from Keap
                                |-- GET /orders/{orderId} from Keap
                                |     - extract line items
                                |     - check for subscription_plan field
                                |-- If subscription_plan present:
                                |     GET /orders?contact_id={id} from Keap
                                |     count prior paid orders with same plan ID
                                |     → RecurringPayment if prior orders exist
                                |     → Purchase if this is the first billing
                                |-- Else (no subscription_plan):
                                |     → Purchase (one-time product)
                                |-- Lookup tracking_context (BigQuery)
                                |     (for fbp, fbc, IP, user agent enrichment)
                                |-- If no tracking context:
                                |     lookup brand from subscriber_queue
                                |     get pixel_id from META_PIXEL_ID_{BRAND} env
                                |-- POST to Meta CAPI  ------------------>  Meta CAPI (server)
                                      (Purchase or RecurringPayment)
                                      (via durable queue)
```

---

## Components in Detail

### 1. Client-Side Tracking (Next.js Sites)

**Files (identical across all 4 sites):**
- `src/lib/meta-tracking.ts` — Tracking utility
- `src/components/MetaTrackingProvider.tsx` — Initializes tracking on page load
- `src/components/NewsletterSignupForm.tsx` — Collects + sends tracking data
- `src/app/api/subscribe/route.ts` — Forwards to Cloud Run with tracking fields
- `src/app/layout.tsx` — Loads pixel, exposes pixel ID to client JS

**What happens on page load:**
1. Meta pixel JS loads and sets `_fbp` cookie (first-party, browser ID)
2. `MetaTrackingProvider` runs `initTracking()`:
   - Reads `_fbp` and `_fbc` cookies
   - Checks URL for `fbclid` parameter (Meta ad click ID)
   - If `fbclid` present but no `_fbc` cookie, constructs and sets one
   - Captures UTM parameters from URL
   - Persists everything to `localStorage` (survives page navigations)

**What happens on form submit:**
1. Generates a unique `eventId` (UUID) for deduplication
2. Reads tracking data from localStorage + fresh `_fbp` from cookie
3. Reads `window.__META_PIXEL_ID__` (set by layout.tsx from Sanity)
4. Fetches client IP via `api.ipify.org`
5. Sends everything to `/api/subscribe` (Next.js API route)
6. On success, fires browser pixel: `fbq('track', 'Subscribe', {...}, { eventID: eventId })`
7. Next.js API route forwards all fields to Cloud Run

### 2. Cloud Run API — Subscribe Route

**File:** `amare-api/src/routes/subscribe.ts`

After processing the Keap contact (create/update, apply tags, opt-in), the subscribe route:

1. **Inserts tracking context** into BigQuery `tracking_context` table — stores all browser tracking data linked to the email + keap_contact_id for later Purchase attribution
2. **Sends Subscribe CAPI event** with:
   - Hashed email, first name, last name (from Keap), phone (from Keap), external_id (keap contact_id)
   - `_fbp` and `_fbc` cookie values (from browser, passed through)
   - Client IP address — sourced from `customFields['DP_IP_ADDRESS']` (the real browser IP fetched client-side via `api.ipify.org`), falling back to `X-Forwarded-For`. The ipify value is preferred because `X-Forwarded-For` on the Cloud Run request reflects the Next.js server IP, not the user's browser IP.
   - Browser user agent — captured by the Next.js API route from the incoming `User-Agent` header and forwarded in the request body
   - Source URL, event ID (for deduplication with browser pixel)
3. Falls back to `META_PIXEL_ID_{BRAND}` env var if the frontend didn't provide a pixel ID (e.g., ad blocker scenario)

### 3. Cloud Run API — Purchase Webhook

**File:** `amare-api/src/routes/keap-webhook.ts`

**Endpoint:** `POST /webhooks/keap/invoice-payment`

Receives Keap REST Hook events when payments are recorded. Handles two types of requests:

**Verification requests:** Keap sends `X-Hook-Secret` header. The endpoint echoes it back to prove ownership. This happens once when the hook is created/verified.

**Event payloads:** `{ event_key: "invoice.payment.add", object_keys: [{ id, apiUrl, timestamp }] }`

For each payment:
1. Fetches transaction details from Keap API (`GET /transactions/{id}`)
2. Fetches contact details from Keap API (`GET /contacts/{contactId}`)
3. Fetches order details from Keap API (`GET /orders/{orderId}`) — extracts line items and checks for `subscription_plan` field
4. **Classifies the event:**
   - If `order.subscription_plan` is absent → **Purchase** (one-time product)
   - If `order.subscription_plan` is present → fetches all paid orders for the contact (`GET /orders?contact_id={id}`), counts prior orders with the same plan ID
     - Prior orders exist → **RecurringPayment**
     - No prior orders → **Purchase** (first subscription billing)
   - Classification failure defaults to **Purchase**
5. Looks up `tracking_context` in BigQuery for enrichment (fbp, fbc, IP, user agent)
6. If no tracking context: determines brand from `subscriber_queue` table, gets pixel ID from env var
7. Sends Purchase or RecurringPayment CAPI event with hashed PII + any available tracking data
8. Always returns `200 { received: true }` to prevent Keap from marking the hook inactive

### 4. Meta CAPI Client

**File:** `amare-api/src/services/meta.ts`

- `sha256(value)` — Normalizes (lowercase, trim) and SHA-256 hashes per Meta spec
- `hashUserData({ em, ph, fn, ln, external_id })` — Hashes PII fields (only non-null ones)
- `getAccessToken(brand)` — Reads `META_ACCESS_TOKEN_{BRAND}` from env
- `getPixelId(brand)` — Reads `META_PIXEL_ID_{BRAND}` from env
- `sendEvent({ pixelId, accessToken, events })` — POSTs to `graph.facebook.com/v21.0/{pixelId}/events`. Never throws — returns `{ success, httpStatus, responseJson, latencyMs, error }`

### 5. Durable Queue + Retry

**File:** `amare-api/src/services/metaQueue.ts`

All CAPI sends go through a durable queue backed by BigQuery. This ensures no events are lost if Meta's API is temporarily down.

**Flow:**
1. `sendMetaWithQueue(metadata, event)` is called
2. INSERT `PENDING` row to `meta_capi_queue`
3. Attempt immediate send via `metaCAPIClient.sendEvent()`
4. INSERT result row: `SENT` (with response) or `FAILED` (with error + next retry time)

**Retry worker:** Runs every 30 seconds (production only). Picks up `PENDING` or `FAILED` events where `next_attempt_at <= NOW()`, retries them.

**Backoff schedule:**
| Attempt | Delay |
|---------|-------|
| 1 | ~2 min |
| 2 | ~4 min |
| 3 | ~8 min |
| 4 | ~16 min |
| 5 | ~32 min |
| 6 | ~60 min |
| 7+ | Status set to `DEAD` (no more retries) |

Each delay includes random 0-30s jitter to prevent thundering herd.

**Append-only pattern:** Rows are never updated. Each status change is a new INSERT with the same `queue_id` and a newer `updated_at`. The latest row per `queue_id` is the authoritative state.

---

## BigQuery Tables

**Dataset:** `watchful-force-477418-b9.keap_integration`

### tracking_context

Stores browser-side tracking data from subscribe events. Used to enrich Purchase CAPI events with attribution data.

| Field | Type | Description |
|-------|------|-------------|
| created_at | TIMESTAMP | When the record was created |
| brand | STRING | Brand code (HRYW, CHKH, GKH, FLO) |
| email | STRING | Subscriber email |
| keap_contact_id | STRING | Keap contact ID (may be backfilled later) |
| pixel_id | STRING | Meta pixel ID used |
| fbp | STRING | `_fbp` cookie value (Meta browser ID) |
| fbc | STRING | `_fbc` cookie value (Meta click ID) |
| fbclid | STRING | Facebook click ID from URL |
| event_id | STRING | Event ID used for deduplication |
| utm_source | STRING | UTM source parameter |
| utm_medium | STRING | UTM medium parameter |
| utm_campaign | STRING | UTM campaign parameter |
| utm_content | STRING | UTM content parameter |
| utm_term | STRING | UTM term parameter |
| source_url | STRING | Page URL where form was submitted |
| user_agent | STRING | Browser user agent string |
| ip_address | STRING | Client IP address |

**Append-only.** Multiple rows may exist per email. Queries use `ORDER BY created_at DESC LIMIT 1`.

### meta_capi_queue

Durable queue for all CAPI sends. Append-only status tracking with retry support.

| Field | Type | Description |
|-------|------|-------------|
| created_at | TIMESTAMP | Original event time |
| updated_at | TIMESTAMP | This row's insert time |
| queue_id | STRING | UUID grouping all status rows for one event |
| source | STRING | `subscribe` or `purchase` |
| brand | STRING | Brand code |
| event_name | STRING | `Subscribe`, `Purchase`, or `RecurringPayment` |
| email_hash | STRING | SHA-256 hashed email |
| keap_contact_id | STRING | Keap contact ID |
| order_id | STRING | Order ID (purchases only) |
| event_id | STRING | Dedup event ID (subscribes only) |
| pixel_id | STRING | Meta pixel ID sent to |
| event_time | INTEGER | Unix timestamp of event |
| action_source | STRING | Always `website` |
| event_source_url | STRING | Source URL |
| capi_payload_json | STRING | Full CAPI payload (pre-hashed, no raw PII) |
| status | STRING | `PENDING`, `SENT`, `FAILED`, or `DEAD` |
| attempt_count | INTEGER | Number of send attempts |
| next_attempt_at | TIMESTAMP | When to retry (for FAILED) |
| last_http_status | INTEGER | Meta API response status code |
| last_error_message | STRING | Error message if failed |
| last_response_json | STRING | Meta API response body |
| last_latency_ms | INTEGER | Send latency in milliseconds |

---

## Environment Variables

### Cloud Run (amare-api)

Set via `cloudbuild.yaml`. Secrets are in Google Cloud Secret Manager.

| Variable | Source | Description |
|----------|--------|-------------|
| `META_ACCESS_TOKEN_FLO` | Secret Manager | Meta CAPI access token for FLO |
| `META_ACCESS_TOKEN_HRYW` | Secret Manager | Meta CAPI access token for HRYW |
| `META_ACCESS_TOKEN_CHKH` | Secret Manager | Meta CAPI access token for CHKH |
| `META_ACCESS_TOKEN_GKH` | Secret Manager | Meta CAPI access token for GKH |
| `META_PIXEL_ID_FLO` | Env var | `326147914863851` |
| `META_PIXEL_ID_HRYW` | Env var | `499856107195284` |
| `META_PIXEL_ID_CHKH` | Env var | `563418634096156` |
| `META_PIXEL_ID_GKH` | Env var | `1160652127415436` |
| `META_TEST_EVENT_CODE` | Env var (optional) | Set to test event code to send events to Meta Events Manager test view |
| `KEAP_WEBHOOK_SECRET` | Secret Manager | Not currently used (Keap uses X-Hook-Secret echo) |

### Next.js Sites

Pixel IDs are stored in Sanity (`siteSettings.metaPixelId`) and rendered server-side in `layout.tsx`.

---

## Keap REST Hook

| Property | Value |
|----------|-------|
| Hook Key | 169 |
| Event | `invoice.payment.add` |
| URL | `https://amare-api-488123902545.us-central1.run.app/webhooks/keap/invoice-payment` |
| Status | Verified |

**Verification model:** Keap sends POST with `X-Hook-Secret` header. Endpoint echoes it back in response header. Hook becomes "Inactive" after 4 consecutive failed deliveries.

**Admin endpoints** (temporary, authenticated via `X-API-Key`):
- `POST /admin/create-hook` — Create new Keap REST hook
- `POST /admin/verify-hook` — Trigger re-verification of existing hook

---

## Event Deduplication

Subscribe events fire from both the browser pixel and the server CAPI. Meta deduplicates them using `event_id`:

1. Client generates a UUID (`crypto.randomUUID()`)
2. Browser pixel fires: `fbq('track', 'Subscribe', {...}, { eventID: eventId })`
3. Server CAPI sends the same `event_id` in the event payload
4. Meta sees both, matches on `event_id` + `pixel_id`, counts as one event

Purchase events are server-only (no `event_id` needed — no browser event to deduplicate against).

---

## Data Flow for PII

**No raw PII is stored in BigQuery queues.** The `capi_payload_json` in `meta_capi_queue` only contains pre-hashed values:

- `em` — SHA-256 of lowercase trimmed email
- `fn` — SHA-256 of lowercase trimmed first name
- `ln` — SHA-256 of lowercase trimmed last name
- `ph` — SHA-256 of phone number
- `external_id` — SHA-256 of keap contact ID

Non-PII values stored as-is: `fbp`, `fbc` (Meta cookie IDs), IP address, user agent.

The `tracking_context` table does store raw email (needed for Purchase lookup by email). This is the same data already in `subscriber_queue`.

---

## Meta Access Tokens

Access tokens are generated in [Meta Business Manager](https://business.facebook.com/) under Events Manager > Settings > Conversions API. They are long-lived system user tokens.

Stored in Google Cloud Secret Manager as `META_ACCESS_TOKEN_{BRAND}` and injected into Cloud Run via `--set-secrets` in `cloudbuild.yaml`.

If a token expires or is revoked, the durable queue will keep retrying events (up to 6 attempts over ~2 hours), then mark them as `DEAD`. After replacing the token and restarting Cloud Run, new events will succeed immediately. Dead events would need manual replay.

---

## Testing

### Test Subscribe CAPI

1. Set `META_TEST_EVENT_CODE` env var on Cloud Run (get code from Meta Events Manager > Test Events)
2. Submit a form on any brand site
3. Check Meta Events Manager > Test Events for a Subscribe event
4. Should show both "Browser" and "Server" sources with matching event ID

### Test Purchase CAPI

1. Create a test invoice + payment in Keap for a known contact (one-time product, no subscription plan)
2. Check Cloud Run logs for `'CAPI event queued'` with `eventName: 'Purchase'`
3. Check `meta_capi_queue` in BigQuery for a SENT row with `event_name = 'Purchase'`
4. Check Meta Events Manager for a Purchase event

### Test RecurringPayment CAPI

1. Use a Keap contact that has an existing paid subscription invoice
2. Record a second payment for the same subscription plan
3. Check Cloud Run logs for `'Subscription payment classification'` — confirm `priorCount > 0` and `eventName: 'RecurringPayment'`
4. Check `meta_capi_queue` in BigQuery for a SENT row with `event_name = 'RecurringPayment'`
5. Check Meta Events Manager — RecurringPayment will appear under **Custom Events** (not Standard Events)

### Observability Queries

```sql
-- Recent CAPI queue activity
SELECT queue_id, source, brand, event_name, status, attempt_count,
       last_error_message, updated_at
FROM `watchful-force-477418-b9.keap_integration.meta_capi_queue`
ORDER BY updated_at DESC
LIMIT 20;

-- Failed/dead events
SELECT queue_id, brand, event_name, status, attempt_count,
       last_error_message, last_http_status
FROM `watchful-force-477418-b9.keap_integration.meta_capi_queue`
WHERE status IN ('FAILED', 'DEAD')
ORDER BY updated_at DESC
LIMIT 20;

-- Tracking context for a contact
SELECT *
FROM `watchful-force-477418-b9.keap_integration.tracking_context`
WHERE email = 'user@example.com'
ORDER BY created_at DESC;
```

---

## File Reference

### Cloud Run API (`amare-api/src/`)

| File | Purpose |
|------|---------|
| `services/meta.ts` | Meta CAPI client (hash, send, token/pixel lookup) |
| `services/metaQueue.ts` | Durable queue + replay worker |
| `services/bigquery.ts` | BigQuery methods for tracking_context + queue |
| `routes/subscribe.ts` | Subscribe endpoint — Keap processing + CAPI |
| `routes/keap-webhook.ts` | Purchase webhook — Keap REST hook handler |
| `types/index.ts` | TypeScript interfaces for all data types |
| `index.ts` | Server setup, starts replay worker |

### Next.js Sites (`{brand}/src/`)

| File | Purpose |
|------|---------|
| `lib/meta-tracking.ts` | Client-side tracking (cookies, UTMs, localStorage) |
| `components/MetaTrackingProvider.tsx` | Initializes tracking on mount |
| `components/NewsletterSignupForm.tsx` | Form with tracking data collection |
| `app/api/subscribe/route.ts` | API route forwarding to Cloud Run |
| `app/layout.tsx` | Pixel script + exposes pixel ID to client |
