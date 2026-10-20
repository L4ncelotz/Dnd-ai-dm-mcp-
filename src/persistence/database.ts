import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const POC_CAMPAIGN_ID = 'poc-campaign';

export interface DatabaseConfig {
  dbPath?: string;
}

/**
 * Initializes SQLite database connection, applies WAL pragmas, schema migrations,
 * and performs idempotent fixture seeding without overwriting existing campaign progress.
 */
export function initDatabase(config: DatabaseConfig = {}): DatabaseSync {
  const dbPath = config.dbPath ?? 'data/poc.db';

  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // Performance and integrity PRAGMAs
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');

  // Schema creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      state_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      name TEXT NOT NULL,
      hp INTEGER NOT NULL,
      max_hp INTEGER NOT NULL,
      armor_class INTEGER NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS game_events (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      CONSTRAINT uq_campaign_action UNIQUE (campaign_id, action_id)
    );

    CREATE INDEX IF NOT EXISTS idx_game_events_campaign_seq
      ON game_events(campaign_id, state_version);
  `);

  // Idempotent fixture seeding
  seedPocFixture(db);

  return db;
}

function seedPocFixture(db: DatabaseSync): void {
  const now = new Date().toISOString();

  // Use INSERT OR IGNORE so restart preserves existing version and modified HP
  const insertCampaign = db.prepare(`
    INSERT OR IGNORE INTO campaigns (id, state_version, created_at)
    VALUES (?, 0, ?)
  `);
  insertCampaign.run(POC_CAMPAIGN_ID, now);

  const insertCharacter = db.prepare(`
    INSERT OR IGNORE INTO characters (id, campaign_id, name, hp, max_hp, armor_class)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Hero fixture: 20/20 HP, AC 14
  insertCharacter.run('hero-1', POC_CAMPAIGN_ID, 'Hero', 20, 20, 14);

  // Goblin fixture: 7/7 HP, AC 12
  insertCharacter.run('goblin-1', POC_CAMPAIGN_ID, 'Goblin', 7, 7, 12);
}
