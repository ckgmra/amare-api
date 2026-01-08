#!/usr/bin/env node
/**
 * Migration script to rebuild clickbank_product_tags table with new schema
 *
 * This script will:
 * 1. Drop the existing clickbank_product_tags table
 * 2. Create a new table with the updated schema
 * 3. Populate it with HRYW product mappings
 *
 * Usage: npx tsx scripts/migrate-product-tags.ts
 */

import { BigQuery } from '@google-cloud/bigquery';

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'watchful-force-477418-b9';
const DATASET = process.env.BIGQUERY_DATASET || 'keap_integration';
const TABLE = 'clickbank_product_tags';

const bigquery = new BigQuery({ projectId: PROJECT_ID });

interface ProductTagRow {
  clickbank_product_id: string;
  brand: string;
  transaction_type: string;
  action: string;
  fulfillment_trigger_tag: string | null;
  keap_tag_id: number;
  keap_tag_category: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// HRYW Product Mappings
const HRYW_PRODUCTS: ProductTagRow[] = [
  // CustomerHub Fulfillment Tags - SALE/TEST_SALE
  { clickbank_product_id: 'modernsiren-249', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Modern Siren', keap_tag_id: 749, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-19', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Have The Relationship You Want eBook', keap_tag_id: 779, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-bundle-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Have The Relationship You Want Audio + eBook', keap_tag_id: 759, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-halfoff', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Have The Relationship You Want eBook', keap_tag_id: 779, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-halfoff-bundle', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Have The Relationship You Want Audio + eBook', keap_tag_id: 759, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsb-309', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Love Scripts Bundle', keap_tag_id: 805, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsd-199', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Love Scripts for Dating', keap_tag_id: 785, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsr-199', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Love Scripts for Relationships', keap_tag_id: 787, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'reconnect-199', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Reconnect Your Relationship', keap_tag_id: 755, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'cb-359', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Commitment Blueprint', keap_tag_id: 791, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'collection-495', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'My Complete Collection', keap_tag_id: 803, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'mrright-249', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Targeting Mr. Right', keap_tag_id: 793, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'modernsiren-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Modern Siren', keap_tag_id: 749, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'reconnect-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Reconnect Your Relationship', keap_tag_id: 755, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'toxicmen-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Toxic Men', keap_tag_id: 789, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'commitmentblueprint-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Commitment Blueprint', keap_tag_id: 791, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'mrright-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Targeting Mr. Right', keap_tag_id: 793, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsb-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Love Scripts Bundle', keap_tag_id: 805, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsd-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Love Scripts for Dating', keap_tag_id: 785, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsr-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Love Scripts for Relationships', keap_tag_id: 787, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'toolkit-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Heart Connection Toolkit', keap_tag_id: 783, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'sirenmom-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'Dating Secrets for the Siren Mom', keap_tag_id: 795, keap_tag_category: 'CustomerHub', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },

  // Products Purchased Tracking Tags - SALE/TEST_SALE
  { clickbank_product_id: 'modernsiren-249', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_MS', keap_tag_id: 482, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-19', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_EBOOK', keap_tag_id: 484, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-bundle-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_EBOOK', keap_tag_id: 484, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-halfoff', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_EBOOK', keap_tag_id: 484, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-halfoff-bundle', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_EBOOK', keap_tag_id: 484, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsb-309', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_LSB', keap_tag_id: 488, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsd-199', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_LSD', keap_tag_id: 490, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsr-199', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_LSR', keap_tag_id: 492, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'reconnect-199', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_RYR', keap_tag_id: 486, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'cb-359', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_CB', keap_tag_id: 494, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'collection-495', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_MCC', keap_tag_id: 476, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'mrright-249', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_TMR', keap_tag_id: 500, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'modernsiren-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_MS', keap_tag_id: 482, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'reconnect-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_RYR', keap_tag_id: 486, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'toxicmen-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_TM', keap_tag_id: 498, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'commitmentblueprint-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_CB', keap_tag_id: 494, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'mrright-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_TMR', keap_tag_id: 500, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsb-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_LSB', keap_tag_id: 488, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsd-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_LSD', keap_tag_id: 490, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsr-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_LSR', keap_tag_id: 492, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'toolkit-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_HCT', keap_tag_id: 496, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'sirenmom-save-25', brand: 'hryw', transaction_type: 'SALE|TEST_SALE', action: 'apply_tag', fulfillment_trigger_tag: 'HRYW_DSSM', keap_tag_id: 502, keap_tag_category: 'Products Purchased', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },

  // Refund/Chargeback Notes - RFND/CGBK/TEST_RFND
  { clickbank_product_id: 'modernsiren-249', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_MS', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-19', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_eBook', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-bundle-25', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_eBook', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-halfoff', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_eBook', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'ebook-halfoff-bundle', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_Bundle', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsb-309', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_LSB', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsd-199', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_LSD', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsr-199', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_LSR', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'reconnect-199', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_RYR', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'cb-359', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_CB', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'collection-495', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_MCC', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'mrright-249', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_TMR', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'modernsiren-save-25', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_MS', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'reconnect-save-25', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_RYR', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'toxicmen-save-25', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_TM', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'commitmentblueprint-save-25', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_CB', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'mrright-save-25', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_TMR', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsb-save-25', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_LSB', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsd-save-25', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_LSD', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'lsr-save-25', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_LSR', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'toolkit-save-25', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_HCT', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { clickbank_product_id: 'sirenmom-save-25', brand: 'hryw', transaction_type: 'RFND|CGBK|TEST_RFND', action: 'apply_note', fulfillment_trigger_tag: 'ADDNOTE:Cancelled_HRYW_DSSM', keap_tag_id: 0, keap_tag_category: 'n/a', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
];

async function main() {
  console.log('Starting migration of clickbank_product_tags table...\n');

  const dataset = bigquery.dataset(DATASET);
  const table = dataset.table(TABLE);

  try {
    // Step 1: Check if table exists and drop it
    const [exists] = await table.exists();
    if (exists) {
      console.log(`Dropping existing table: ${DATASET}.${TABLE}`);
      await table.delete();
      console.log('✓ Table dropped\n');
    } else {
      console.log('Table does not exist, will create new one\n');
    }

    // Step 2: Create new table with updated schema
    console.log('Creating new table with updated schema...');
    const schema = [
      { name: 'clickbank_product_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'brand', type: 'STRING', mode: 'REQUIRED' },
      { name: 'transaction_type', type: 'STRING', mode: 'REQUIRED' },
      { name: 'action', type: 'STRING', mode: 'REQUIRED' },
      { name: 'fulfillment_trigger_tag', type: 'STRING', mode: 'NULLABLE' },
      { name: 'keap_tag_id', type: 'INTEGER', mode: 'REQUIRED' },
      { name: 'keap_tag_category', type: 'STRING', mode: 'NULLABLE' },
      { name: 'active', type: 'BOOLEAN', mode: 'NULLABLE' },
      { name: 'created_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
      { name: 'updated_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
    ];

    await table.create({ schema });
    console.log('✓ Table created with new schema\n');

    // Step 3: Insert HRYW product data
    console.log(`Inserting ${HRYW_PRODUCTS.length} HRYW product mappings...`);
    await table.insert(HRYW_PRODUCTS);
    console.log('✓ Product mappings inserted\n');

    // Step 4: Verify data
    const [rows] = await bigquery.query(`
      SELECT
        brand,
        COUNT(*) as total_rows,
        COUNT(DISTINCT clickbank_product_id) as unique_products,
        COUNT(CASE WHEN action = 'apply_tag' THEN 1 END) as tag_actions,
        COUNT(CASE WHEN action = 'apply_note' THEN 1 END) as note_actions
      FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\`
      WHERE active = true
      GROUP BY brand
    `);

    console.log('Migration Summary:');
    console.log('==================');
    for (const row of rows) {
      console.log(`Brand: ${row.brand}`);
      console.log(`  Total rows: ${row.total_rows}`);
      console.log(`  Unique products: ${row.unique_products}`);
      console.log(`  Tag actions: ${row.tag_actions}`);
      console.log(`  Note actions: ${row.note_actions}`);
    }

    console.log('\n✓ Migration completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

main();
