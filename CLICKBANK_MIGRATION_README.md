# ClickBank Product Tags Migration

## Overview

This migration updates the `clickbank_product_tags` BigQuery table to support:
- **Pipe-delimited transaction types** (e.g., `SALE|TEST_SALE`) for flexible matching
- **Multiple actions per product** (fulfillment tags + tracking tags)
- **Contact notes** for refunds/chargebacks via `apply_note` action
- **Improved schema** with human-readable tag names and categories

## What Changed

### Schema Changes

**Old Schema:**
```
product_id           (STRING)
brand                (STRING)
transaction_type     (STRING)
action               (STRING) - 'APPLY' or 'REMOVE'
tag_id               (INTEGER)
tag_name             (STRING, nullable)
active               (BOOLEAN)
created_at/updated_at (TIMESTAMP)
```

**New Schema:**
```
clickbank_product_id        (STRING) - renamed from product_id
brand                       (STRING)
transaction_type            (STRING) - now supports pipe-delimited: 'SALE|TEST_SALE'
action                      (STRING) - 'apply_tag' or 'apply_note'
fulfillment_trigger_tag     (STRING) - human-readable tag name or ADDNOTE: text
keap_tag_id                 (INTEGER) - Keap numeric tag ID (0 for notes)
keap_tag_category           (STRING) - e.g., 'CustomerHub', 'Products Purchased'
active                      (BOOLEAN)
created_at/updated_at       (TIMESTAMP)
```

### Code Changes

1. **bigquery.ts**: Updated `getTagActionsForProduct()` to query with LIKE patterns for pipe-delimited matching
2. **types/index.ts**: Updated `TagAction` interface to support new fields
3. **keap.ts**: Added `addNote()` method for adding contact notes
4. **clickbank.ts**: Updated `processQueuedTransaction()` to handle `apply_note` actions

## Migration Steps

### 1. Run the Migration Script

```bash
cd /Users/malcorn/amare/amare-api

# Make sure you have GCP credentials configured
# The script will drop and recreate the table with HRYW data

npx tsx scripts/migrate-product-tags.ts
```

Expected output:
```
Starting migration of clickbank_product_tags table...

Dropping existing table: keap_integration.clickbank_product_tags
✓ Table dropped

Creating new table with updated schema...
✓ Table created with new schema

Inserting 66 HRYW product mappings...
✓ Product mappings inserted

Migration Summary:
==================
Brand: hryw
  Total rows: 66
  Unique products: 22
  Tag actions: 44
  Note actions: 22

✓ Migration completed successfully!
```

### 2. Deploy Updated Code to Cloud Run

```bash
cd /Users/malcorn/amare/amare-api

# Build the TypeScript
npm run build

# Deploy to Cloud Run (adjust project/region as needed)
gcloud run deploy api --source . --project watchful-force-477418-b9 --region us-central1
```

### 3. Test with ClickBank Test IPN

Send a test IPN to verify the new functionality works:
- **SALE** should apply 2 tags (CustomerHub fulfillment + Products Purchased tracking)
- **RFND** should add a note to the contact

## HRYW Product Mappings

The migration includes 66 rows for 22 HRYW products:

### Product Examples:
- **modernsiren-249**: Modern Siren program
- **ebook-19**: HRYW eBook
- **lsb-309**: Love Scripts Bundle
- **reconnect-199**: Reconnect Your Relationship
- ... and 18 more products including -save-25 variants

### Action Breakdown:
- **44 apply_tag actions**: 22 CustomerHub fulfillment tags + 22 Products Purchased tracking tags
- **22 apply_note actions**: One for each product on RFND/CGBK/TEST_RFND

## How Pipe-Delimited Matching Works

When a ClickBank IPN comes in with `transaction_type: 'SALE'`, the query will match rows where:
- `transaction_type = 'SALE'` (exact match), OR
- `transaction_type LIKE 'SALE|%'` (starts with SALE|), OR
- `transaction_type LIKE '%|SALE|%'` (SALE in middle), OR
- `transaction_type LIKE '%|SALE'` (ends with |SALE)

This allows flexible configuration without duplicating rows.

## Verification Queries

After migration, verify the data:

```sql
-- Count rows per product
SELECT clickbank_product_id, COUNT(*) as action_count
FROM `watchful-force-477418-b9.keap_integration.clickbank_product_tags`
WHERE active = true AND brand = 'hryw'
GROUP BY clickbank_product_id
ORDER BY clickbank_product_id;

-- Should show 3 rows per product (2 tags + 1 note)

-- View actions for a specific product
SELECT *
FROM `watchful-force-477418-b9.keap_integration.clickbank_product_tags`
WHERE clickbank_product_id = 'modernsiren-249' AND active = true;

-- Should show:
-- 1. SALE|TEST_SALE -> apply_tag -> Modern Siren (749, CustomerHub)
-- 2. SALE|TEST_SALE -> apply_tag -> HRYW_MS (482, Products Purchased)
-- 3. RFND|CGBK|TEST_RFND -> apply_note -> ADDNOTE:Cancelled_HRYW_MS (0, n/a)
```

## Rollback Plan

If something goes wrong, you can rollback:

1. **Revert code changes**: `git revert <commit-hash>`
2. **Restore old table** (if you backed it up):
   ```sql
   CREATE TABLE `keap_integration.clickbank_product_tags` AS
   SELECT * FROM `keap_integration.clickbank_product_tags_backup`;
   ```

## Next Steps

- Monitor Cloud Run logs for the first few IPNs to ensure tags and notes are applied correctly
- Add product mappings for other brands (FLO, GKH, CHKH) using the same pattern
- Consider creating a web UI for managing product mappings instead of manual SQL inserts
