import { rmSync } from 'node:fs';
import { initDatabase, POC_CAMPAIGN_ID } from '../src/persistence/database.js';

function resetDatabase(): void {
  const dbPath = 'data/poc.db';
  console.log(`[reset-db] Removing existing database at ${dbPath}...`);
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  } catch {
    // Already removed
  }

  console.log(`[reset-db] Initializing fresh database with fixture '${POC_CAMPAIGN_ID}'...`);
  const db = initDatabase({ dbPath });
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(POC_CAMPAIGN_ID);
  const characters = db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(POC_CAMPAIGN_ID);

  console.log('[reset-db] Fresh fixture seeded:');
  console.log('Campaign:', campaign);
  console.log('Characters:', characters);

  db.close();
  console.log('[reset-db] Database successfully reset.');
}

resetDatabase();
