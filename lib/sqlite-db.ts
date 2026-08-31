import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serverDataJsonPath } from "@/lib/server-data-paths";

// ---------------------------------------------------------------------------
// Issue #36: Marketplace & Signal stores, migrated from full-file JSON reads
// on every request to an indexed, normalized SQLite schema.
//
// Uses Node's built-in `node:sqlite` (stable-ish since Node 22.5, no native
// build step / node-gyp dependency required) rather than a third-party
// driver, since this runs in Next.js server routes on both local dev and
// Vercel's Node runtime.
// ---------------------------------------------------------------------------

let db: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id              TEXT PRIMARY KEY,
  token_id        INTEGER NOT NULL,
  collection_id   INTEGER NOT NULL,
  seller_wallet   TEXT NOT NULL,
  price_phaselq   REAL NOT NULL,
  accepts_offers  INTEGER NOT NULL DEFAULT 0,
  min_offer       REAL,
  image           TEXT,
  name            TEXT,
  listed_at       INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_listings_status_listed_at
  ON listings (status, listed_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_status_price
  ON listings (status, price_phaselq);
CREATE INDEX IF NOT EXISTS idx_listings_collection
  ON listings (collection_id);
CREATE INDEX IF NOT EXISTS idx_listings_seller
  ON listings (seller_wallet);

CREATE TABLE IF NOT EXISTS offers (
  id              TEXT PRIMARY KEY,
  listing_id      TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_wallet    TEXT NOT NULL,
  amount_phaselq  REAL NOT NULL,
  message         TEXT,
  created_at      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  expires_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_listing_created
  ON offers (listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offers_buyer_created
  ON offers (buyer_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offers_status_expires
  ON offers (status, expires_at);

CREATE TABLE IF NOT EXISTS signals (
  id                TEXT PRIMARY KEY,
  author_wallet     TEXT NOT NULL,
  author_display    TEXT NOT NULL,
  channel           TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  nft_token_id      INTEGER,
  nft_collection_id INTEGER,
  nft_name          TEXT,
  nft_image         TEXT,
  upvotes_json      TEXT NOT NULL DEFAULT '[]',
  upvote_count      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  signature         TEXT NOT NULL,
  type              TEXT,
  poll_json         TEXT,
  scheduled_for     INTEGER,
  status            TEXT,
  taken_down        INTEGER NOT NULL DEFAULT 0,
  takedown_reason   TEXT,
  taken_down_at     INTEGER,
  media_json        TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_channel_created
  ON signals (channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_status
  ON signals (status);
CREATE INDEX IF NOT EXISTS idx_signals_author_status
  ON signals (author_wallet, status);
CREATE INDEX IF NOT EXISTS idx_signals_taken_down
  ON signals (taken_down);

CREATE TABLE IF NOT EXISTS signal_replies (
  id              TEXT PRIMARY KEY,
  signal_id       TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  author_wallet   TEXT NOT NULL,
  author_display  TEXT NOT NULL,
  body            TEXT NOT NULL,
  upvotes_json    TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  signature       TEXT NOT NULL,
  media_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_replies_signal_created
  ON signal_replies (signal_id, created_at ASC);
`;

/**
 * Returns the process-wide SQLite connection, creating and migrating the
 * schema on first use. Safe to call from any request handler; `node:sqlite`
 * serializes access on a single connection per process.
 */
export function getDb(): DatabaseSync {
  if (db) return db;

  const dbPath = serverDataJsonPath("sqliteDb");
  mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  return db;
}

/** Test-only: drop the cached connection so a fresh one is opened next call. */
export function resetDbForTests(): void {
  db?.close();
  db = null;
}
