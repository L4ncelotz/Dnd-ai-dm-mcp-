import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { initDatabase, POC_CAMPAIGN_ID } from '../src/persistence/database.js';
import {
  GameService,
  ConflictError,
  VersionConflictError,
  ValidationError,
  NotFoundError,
} from '../src/service/gameService.js';
import { DeterministicRng } from '../src/domain/rng.js';

describe('GameService Persistence & Transactions', () => {
  const TEST_FILE_DB = 'data/test-persistence.db';

  beforeEach(() => {
    try {
      rmSync(TEST_FILE_DB, { force: true });
      rmSync(`${TEST_FILE_DB}-wal`, { force: true });
      rmSync(`${TEST_FILE_DB}-shm`, { force: true });
    } catch {
      // Ignored if files do not exist
    }
  });

  afterEach(() => {
    try {
      rmSync(TEST_FILE_DB, { force: true });
      rmSync(`${TEST_FILE_DB}-wal`, { force: true });
      rmSync(`${TEST_FILE_DB}-shm`, { force: true });
    } catch {
      // Cleanup
    }
  });

  it('Scenario 1: get_game_state returns seeded hero HP 20 and version 0 on a fresh DB', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const service = new GameService(db);

    const state = service.getGameState(POC_CAMPAIGN_ID);

    expect(state.campaignId).toBe(POC_CAMPAIGN_ID);
    expect(state.stateVersion).toBe(0);
    expect(state.characters).toHaveLength(5);

    const hero = state.characters.find((c) => c.id === 'hero-1');
    expect(hero).toBeDefined();
    expect(hero?.hp).toBe(20);
    expect(hero?.maxHp).toBe(20);
    expect(hero?.armorClass).toBe(14);

    const goblin = state.characters.find((c) => c.id === 'goblin-1');
    expect(goblin).toBeDefined();
    expect(goblin?.hp).toBe(7);
    expect(goblin?.maxHp).toBe(7);
    expect(goblin?.armorClass).toBe(12);

    db.close();
  });

  it('Scenario 2: controlled hit from injected deterministic RNG applies exactly expected damage and logs roll details', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    // Goblin attacks Hero: d20 = 12 (12+4=16 >= 14, Hit), damage d6 = 5 (5+2 = 7 damage)
    const rng = new DeterministicRng([12, 5]);
    const service = new GameService(db, rng);

    const result = service.resolveTestAttack({
      campaignId: POC_CAMPAIGN_ID,
      actionId: 'action-hit-1',
      expectedVersion: 0,
      attackerId: 'goblin-1',
      targetId: 'hero-1',
    });

    expect(result.actionId).toBe('action-hit-1');
    expect(result.stateVersion).toBe(1);
    expect(result.roll.d20).toBe(12);
    expect(result.roll.bonus).toBe(4);
    expect(result.roll.total).toBe(16);
    expect(result.roll.targetAc).toBe(14);
    expect(result.roll.isHit).toBe(true);
    expect(result.damage).toBe(7);
    expect(result.targetPreviousHp).toBe(20);
    expect(result.targetHp).toBe(13);
    expect(result.targetMaxHp).toBe(20);
    expect(result.isDuplicate).toBe(false);

    // Verify DB state updated
    const state = service.getGameState(POC_CAMPAIGN_ID);
    expect(state.stateVersion).toBe(1);
    const hero = state.characters.find((c) => c.id === 'hero-1');
    expect(hero?.hp).toBe(13);

    // Verify event log
    const events = service.getEventLog(POC_CAMPAIGN_ID);
    expect(events).toHaveLength(1);
    expect(events[0].actionId).toBe('action-hit-1');
    expect(events[0].stateVersion).toBe(1);
    expect(events[0].type).toBe('ATTACK_RESOLVED');

    db.close();
  });

  it('Scenario 3: repeating the same actionId returns byte-for-byte equivalent logical result, no second event or HP change', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const rng = new DeterministicRng([12, 5]); // If it rolls again, it will crash because only 2 rolls provided
    const service = new GameService(db, rng);

    const firstResult = service.resolveTestAttack({
      campaignId: POC_CAMPAIGN_ID,
      actionId: 'action-repeat-1',
      expectedVersion: 0,
      attackerId: 'goblin-1',
      targetId: 'hero-1',
    });

    expect(firstResult.isDuplicate).toBe(false);
    expect(firstResult.targetHp).toBe(13);

    // Second call with same actionId and matching parameters
    const secondResult = service.resolveTestAttack({
      campaignId: POC_CAMPAIGN_ID,
      actionId: 'action-repeat-1',
      expectedVersion: 0,
      attackerId: 'goblin-1',
      targetId: 'hero-1',
    });

    expect(secondResult.isDuplicate).toBe(true);
    expect(secondResult.actionId).toBe(firstResult.actionId);
    expect(secondResult.stateVersion).toBe(firstResult.stateVersion);
    expect(secondResult.damage).toBe(firstResult.damage);
    expect(secondResult.targetHp).toBe(firstResult.targetHp);
    expect(secondResult.roll).toEqual(firstResult.roll);

    // Ensure HP and version did not change again
    const state = service.getGameState(POC_CAMPAIGN_ID);
    expect(state.stateVersion).toBe(1);
    expect(state.characters.find((c) => c.id === 'hero-1')?.hp).toBe(13);

    // Ensure exactly 1 event exists
    const events = service.getEventLog(POC_CAMPAIGN_ID);
    expect(events).toHaveLength(1);

    db.close();
  });

  it('Scenario 4: repeating same actionId with altered inputs fails with ConflictError', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const rng = new DeterministicRng([10, 3]);
    const service = new GameService(db, rng);

    service.resolveTestAttack({
      campaignId: POC_CAMPAIGN_ID,
      actionId: 'action-conflict-1',
      expectedVersion: 0,
      attackerId: 'goblin-1',
      targetId: 'hero-1',
    });

    // Reusing action-conflict-1 with attacker/target inverted
    expect(() =>
      service.resolveTestAttack({
        campaignId: POC_CAMPAIGN_ID,
        actionId: 'action-conflict-1',
        expectedVersion: 0,
        attackerId: 'hero-1',
        targetId: 'goblin-1',
      })
    ).toThrow(ConflictError);

    db.close();
  });

  it('Scenario 5: a new action with stale version rejects without rolling or mutating state', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    // DeterministicRng has zero valid rolls: if resolveAttack rolls, it will throw Exhausted
    const rng = new DeterministicRng([15, 4]);
    const service = new GameService(db, rng);

    // Execute first valid action -> increments version to 1
    service.resolveTestAttack({
      campaignId: POC_CAMPAIGN_ID,
      actionId: 'action-1',
      expectedVersion: 0,
      attackerId: 'goblin-1',
      targetId: 'hero-1',
    });

    // Attempt next action with stale expectedVersion: 0 (current is 1)
    expect(() =>
      service.resolveTestAttack({
        campaignId: POC_CAMPAIGN_ID,
        actionId: 'action-stale-2',
        expectedVersion: 0,
        attackerId: 'goblin-1',
        targetId: 'hero-1',
      })
    ).toThrow(VersionConflictError);

    // Verify state remained at version 1 and no second event was appended
    const state = service.getGameState(POC_CAMPAIGN_ID);
    expect(state.stateVersion).toBe(1);

    const events = service.getEventLog(POC_CAMPAIGN_ID);
    expect(events).toHaveLength(1);

    db.close();
  });

  it('Scenario 6: invalid actor or target IDs are rejected', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const service = new GameService(db);

    expect(() =>
      service.resolveTestAttack({
        campaignId: POC_CAMPAIGN_ID,
        actionId: 'invalid-actor',
        expectedVersion: 0,
        attackerId: 'unknown-monster',
        targetId: 'hero-1',
      })
    ).toThrow(ValidationError);

    expect(() =>
      service.resolveTestAttack({
        campaignId: POC_CAMPAIGN_ID,
        actionId: 'invalid-target',
        expectedVersion: 0,
        attackerId: 'goblin-1',
        targetId: 'unknown-hero',
      })
    ).toThrow(ValidationError);

    expect(() =>
      service.resolveTestAttack({
        campaignId: POC_CAMPAIGN_ID,
        actionId: 'self-attack',
        expectedVersion: 0,
        attackerId: 'hero-1',
        targetId: 'hero-1',
      })
    ).toThrow(ValidationError);

    db.close();
  });

  it('Scenario 7: restart process/open same DB and observe identical committed HP/version/event log', () => {
    // 1. Initial process: create file DB, execute attack, close DB
    const db1 = initDatabase({ dbPath: TEST_FILE_DB });
    const rng1 = new DeterministicRng([14, 4]); // 14+4=18 hit, 4+2=6 damage -> hero HP 20 -> 14
    const service1 = new GameService(db1, rng1);

    const actionResult = service1.resolveTestAttack({
      campaignId: POC_CAMPAIGN_ID,
      actionId: 'persist-action-1',
      expectedVersion: 0,
      attackerId: 'goblin-1',
      targetId: 'hero-1',
    });

    expect(actionResult.targetHp).toBe(14);
    expect(actionResult.stateVersion).toBe(1);
    db1.close();

    // 2. Restart simulation: reopen same DB file with fresh connection
    const db2 = initDatabase({ dbPath: TEST_FILE_DB });
    const service2 = new GameService(db2);

    const stateAfterRestart = service2.getGameState(POC_CAMPAIGN_ID);
    expect(stateAfterRestart.stateVersion).toBe(1);

    const heroAfterRestart = stateAfterRestart.characters.find((c) => c.id === 'hero-1');
    expect(heroAfterRestart?.hp).toBe(14);
    expect(heroAfterRestart?.maxHp).toBe(20);

    const eventsAfterRestart = service2.getEventLog(POC_CAMPAIGN_ID);
    expect(eventsAfterRestart).toHaveLength(1);
    expect(eventsAfterRestart[0].actionId).toBe('persist-action-1');
    expect(eventsAfterRestart[0].stateVersion).toBe(1);

    // 3. Verify next action continues from persisted state version 1
    const rng2 = new DeterministicRng([16, 3]); // hero attacks goblin: 16+5=21 hit, 3+3=6 damage -> goblin HP 7 -> 1
    const service2WithRng = new GameService(db2, rng2);
    const secondAction = service2WithRng.resolveTestAttack({
      campaignId: POC_CAMPAIGN_ID,
      actionId: 'persist-action-2',
      expectedVersion: 1,
      attackerId: 'hero-1',
      targetId: 'goblin-1',
    });

    expect(secondAction.stateVersion).toBe(2);
    expect(secondAction.targetHp).toBe(1);

    const finalEvents = service2.getEventLog(POC_CAMPAIGN_ID);
    expect(finalEvents).toHaveLength(2);

    db2.close();
  });

  it('Scenario 8: simultaneous requests with the same actionId result in exactly one commit', async () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const rng = new DeterministicRng([15, 4]);
    const service = new GameService(db, rng);

    // Launch simultaneous requests with the same actionId
    const promises = Array.from({ length: 5 }, () =>
      Promise.resolve().then(() =>
        service.resolveTestAttack({
          campaignId: POC_CAMPAIGN_ID,
          actionId: 'concurrent-action-1',
          expectedVersion: 0,
          attackerId: 'goblin-1',
          targetId: 'hero-1',
        })
      )
    );

    const results = await Promise.all(promises);

    // All results must have the same actionId and targetHp
    for (const res of results) {
      expect(res.actionId).toBe('concurrent-action-1');
      expect(res.stateVersion).toBe(1);
      expect(res.targetHp).toBe(14);
    }

    // Exactly one is initial (isDuplicate: false), the rest are duplicates (isDuplicate: true)
    const freshCount = results.filter((r) => !r.isDuplicate).length;
    const duplicateCount = results.filter((r) => r.isDuplicate).length;

    expect(freshCount).toBe(1);
    expect(duplicateCount).toBe(4);

    // In DB, only 1 event exists and version is 1
    const state = service.getGameState(POC_CAMPAIGN_ID);
    expect(state.stateVersion).toBe(1);

    const events = service.getEventLog(POC_CAMPAIGN_ID);
    expect(events).toHaveLength(1);

    db.close();
  });
});
