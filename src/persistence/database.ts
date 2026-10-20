import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PREMADE_CHARACTERS } from '../domain/character.js';

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
      name_th TEXT,
      class_name TEXT,
      class_name_th TEXT,
      level INTEGER NOT NULL DEFAULT 1,
      hp INTEGER NOT NULL,
      max_hp INTEGER NOT NULL,
      armor_class INTEGER NOT NULL,
      speed INTEGER NOT NULL DEFAULT 30,
      abilities_json TEXT,
      attacks_json TEXT,
      inventory_json TEXT,
      pos_x INTEGER NOT NULL DEFAULT 0,
      pos_y INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS pending_actions (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      intent_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      action_type TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scenes (
      campaign_id TEXT PRIMARY KEY,
      location TEXT NOT NULL,
      location_th TEXT NOT NULL,
      description TEXT NOT NULL,
      description_th TEXT NOT NULL,
      revealed_clues_json TEXT NOT NULL DEFAULT '[]',
      secret_traps_json TEXT NOT NULL DEFAULT '[]',
      secret_enemies_json TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );
  `);

  // Run column migrations if characters table existed previously without rich columns
  migrateCharactersTable(db);

  // Idempotent fixture seeding
  seedPocFixture(db);

  return db;
}

interface TableColumnInfo {
  name: string;
}

function migrateCharactersTable(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(characters)').all() as unknown as TableColumnInfo[];
  const existingCols: Record<string, true> = {};
  for (const c of columns) {
    existingCols[c.name] = true;
  }

  const migrations: Array<{ col: string; ddl: string }> = [
    { col: 'name_th', ddl: 'ALTER TABLE characters ADD COLUMN name_th TEXT;' },
    { col: 'class_name', ddl: 'ALTER TABLE characters ADD COLUMN class_name TEXT;' },
    { col: 'class_name_th', ddl: 'ALTER TABLE characters ADD COLUMN class_name_th TEXT;' },
    { col: 'level', ddl: 'ALTER TABLE characters ADD COLUMN level INTEGER NOT NULL DEFAULT 1;' },
    { col: 'speed', ddl: 'ALTER TABLE characters ADD COLUMN speed INTEGER NOT NULL DEFAULT 30;' },
    { col: 'abilities_json', ddl: 'ALTER TABLE characters ADD COLUMN abilities_json TEXT;' },
    { col: 'attacks_json', ddl: 'ALTER TABLE characters ADD COLUMN attacks_json TEXT;' },
    { col: 'inventory_json', ddl: 'ALTER TABLE characters ADD COLUMN inventory_json TEXT;' },
    { col: 'pos_x', ddl: 'ALTER TABLE characters ADD COLUMN pos_x INTEGER NOT NULL DEFAULT 0;' },
    { col: 'pos_y', ddl: 'ALTER TABLE characters ADD COLUMN pos_y INTEGER NOT NULL DEFAULT 0;' },
  ];

  for (const mig of migrations) {
    if (!existingCols[mig.col]) {
      db.exec(mig.ddl);
    }
  }
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
    INSERT OR IGNORE INTO characters (
      id, campaign_id, name, name_th, class_name, class_name_th,
      level, hp, max_hp, armor_class, speed,
      abilities_json, attacks_json, inventory_json, pos_x, pos_y
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Phase 00 fixture characters (kept for backward compatibility with PoC tools)
  insertCharacter.run(
    'hero-1',
    POC_CAMPAIGN_ID,
    'Hero',
    'ผู้กล้า',
    'Fighter',
    'นักรบ',
    1,
    20,
    20,
    14,
    30,
    JSON.stringify({ str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 10 }),
    JSON.stringify([{ id: 'longsword', name: 'Longsword', nameTh: 'ดาบยาว', attackBonus: 5, damageFormula: '1d8+3', damageType: 'slashing' }]),
    JSON.stringify([{ id: 'item-potion', name: 'Potion of Healing', nameTh: 'น้ำยาฟื้นพลังชีวิต', quantity: 1 }]),
    0,
    0
  );

  insertCharacter.run(
    'goblin-1',
    POC_CAMPAIGN_ID,
    'Goblin',
    'ก็อบลิน',
    'Monster',
    'มอนสเตอร์',
    1,
    7,
    7,
    12,
    30,
    JSON.stringify({ str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 }),
    JSON.stringify([{ id: 'scimitar', name: 'Scimitar', nameTh: 'ดาบโค้ง', attackBonus: 4, damageFormula: '1d6+2', damageType: 'slashing' }]),
    JSON.stringify([]),
    5,
    5
  );

  // Phase 01: Three canonical premade level-1 player characters
  for (const premade of PREMADE_CHARACTERS) {
    insertCharacter.run(
      premade.id,
      POC_CAMPAIGN_ID,
      premade.name,
      premade.nameTh,
      premade.className,
      premade.classNameTh,
      premade.level,
      premade.hp,
      premade.maxHp,
      premade.armorClass,
      premade.speed,
      JSON.stringify(premade.abilities),
      JSON.stringify(premade.attacks),
      JSON.stringify(premade.inventory),
      premade.position.x,
      premade.position.y
    );
  }

  // Phase 02: Default scene fixture with revealed vs server-held secret data
  const insertScene = db.prepare(`
    INSERT OR IGNORE INTO scenes (
      campaign_id, location, location_th, description, description_th,
      revealed_clues_json, secret_traps_json, secret_enemies_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertScene.run(
    POC_CAMPAIGN_ID,
    'Cragmaw Hideout - Entrance Cave',
    'ถ้ำปากทางเข้าที่กบดานแคร็กมอว์',
    'The mouth of a shallow damp cave opens before you. Brambles cover the entrance. Murmurs and the smell of campfire drift from inside.',
    'ปากถ้ำชื้นแฉะเปิดออกตรงหน้า พุ่มหนามปกคลุมปากทาง ได้ยินเสียงพึมพำและได้กลิ่นควันไฟจากด้านใน',
    JSON.stringify(['Footprints of goblins leading into the cave']),
    JSON.stringify([
      { id: 'trap-snare-1', name: 'Snare Trap', trigger: 'Brambles step', dc: 12, damage: '1d6', revealed: false },
    ]),
    JSON.stringify([
      { id: 'goblin-sniper-hidden', name: 'Hidden Goblin Archer', stealthRoll: 16, revealed: false },
    ])
  );
}
