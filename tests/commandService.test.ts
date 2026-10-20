import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { initDatabase, POC_CAMPAIGN_ID } from '../src/persistence/database.js';
import { CommandService } from '../src/service/commandService.js';
import { DeterministicRng } from '../src/domain/rng.js';
import {
  ConflictError,
  VersionConflictError,
  ValidationError,
  NotFoundError,
} from '../src/service/gameService.js';

describe('CommandService Generalized Actions & Event Sourcing (Phase 01)', () => {
  const TEST_DB = 'data/test-command-service.db';

  beforeEach(() => {
    try {
      rmSync(TEST_DB, { force: true });
      rmSync(`${TEST_DB}-wal`, { force: true });
      rmSync(`${TEST_DB}-shm`, { force: true });
    } catch {
      // Ignored
    }
  });

  afterEach(() => {
    try {
      rmSync(TEST_DB, { force: true });
      rmSync(`${TEST_DB}-wal`, { force: true });
      rmSync(`${TEST_DB}-shm`, { force: true });
    } catch {
      // Cleanup
    }
  });

  it('loads complete character sheets for the 3 premade characters', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const service = new CommandService(db);

    const fighter = service.getCharacterSheet(POC_CAMPAIGN_ID, 'char-fighter-1');
    expect(fighter.name).toBe('Kaelen Stormborn');
    expect(fighter.className).toBe('Fighter');
    expect(fighter.hp).toBe(12);
    expect(fighter.maxHp).toBe(12);
    expect(fighter.armorClass).toBe(18);
    expect(fighter.attacks[0].name).toBe('Longsword');
    expect(fighter.inventory).toHaveLength(6);

    const cleric = service.getCharacterSheet(POC_CAMPAIGN_ID, 'char-cleric-1');
    expect(cleric.name).toBe('Lyra Dawnseeker');
    expect(cleric.className).toBe('Cleric');
    expect(cleric.hp).toBe(10);
    expect(cleric.armorClass).toBe(18);

    const rogue = service.getCharacterSheet(POC_CAMPAIGN_ID, 'char-rogue-1');
    expect(rogue.name).toBe('Vael Whisperwind');
    expect(rogue.className).toBe('Rogue');
    expect(rogue.hp).toBe(9);
    expect(rogue.armorClass).toBe(14);

    db.close();
  });

  it('executes ATTACK command with weapon attack and applies damage atomically', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    // Fighter attacks Goblin (AC 12).
    // Longsword: +5 attack bonus, 1d8+3 damage.
    // d20 roll: 12 -> 12 + 5 = 17 >= 12 (Hit).
    // Damage d8 roll: 4 -> 4 + 3 = 7 damage -> Goblin HP 7 -> 0.
    const rng = new DeterministicRng([12, 4]);
    const service = new CommandService(db, rng);

    const result = service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'cmd-attack-1', expectedVersion: 0 },
      {
        type: 'ATTACK',
        attackerId: 'char-fighter-1',
        targetId: 'goblin-1',
        weaponId: 'longsword',
      }
    );

    expect(result.actionId).toBe('cmd-attack-1');
    expect(result.stateVersion).toBe(1);
    expect(result.isDuplicate).toBe(false);

    if ('attackRoll' in result) {
      expect(result.attackRoll.isHit).toBe(true);
      expect(result.attackRoll.total).toBe(17);
      expect(result.totalDamage).toBe(7);
      expect(result.targetPreviousHp).toBe(7);
      expect(result.targetHp).toBe(0);
    }

    const updatedGoblin = service.getCharacterSheet(POC_CAMPAIGN_ID, 'goblin-1');
    expect(updatedGoblin.hp).toBe(0);

    db.close();
  });

  it('executes ATTACK with advantage and critical hit', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    // Rogue attacks with advantage: rolls 10 and 20 -> picks 20 (Critical hit!)
    // Shortsword: 1d6+3 damage -> Critical hit doubles dice: 2d6+3
    // 2d6 rolls: 5, 4 -> 5 + 4 + 3 = 12 damage
    const rng = new DeterministicRng([10, 20, 5, 4]);
    const service = new CommandService(db, rng);

    const result = service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'cmd-crit-1', expectedVersion: 0 },
      {
        type: 'ATTACK',
        attackerId: 'char-rogue-1',
        targetId: 'hero-1',
        weaponId: 'shortsword',
        advantageMode: 'advantage',
      }
    );

    if ('attackRoll' in result) {
      expect(result.attackRoll.isHit).toBe(true);
      expect(result.attackRoll.isCriticalHit).toBe(true);
      expect(result.attackRoll.d20).toBe(20);
      expect(result.attackRoll.discardedD20).toBe(10);
      expect(result.totalDamage).toBe(12);
      expect(result.targetHp).toBe(8); // Hero 20 - 12 = 8
    }

    db.close();
  });

  it('executes HEAL command and clamps to maxHp', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    // 1. Damage fighter first: 12 HP -> 4 HP
    db.prepare('UPDATE characters SET hp = 4 WHERE id = ?').run('char-fighter-1');

    // 2. Heal with Potion of Healing (2d4+2)
    // 2d4 rolls: 3, 4 -> 3 + 4 + 2 = 9 healing -> 4 + 9 = 13 -> Clamped to maxHp 12
    const rng = new DeterministicRng([3, 4]);
    const service = new CommandService(db, rng);

    const healResult = service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'cmd-heal-1', expectedVersion: 0 },
      {
        type: 'HEAL',
        targetId: 'char-fighter-1',
        amountFormula: '2d4+2',
        source: 'Potion of Healing',
      }
    );

    expect(healResult.stateVersion).toBe(1);
    if ('amountHealed' in healResult) {
      expect(healResult.amountHealed).toBe(9);
      expect(healResult.targetPreviousHp).toBe(4);
      expect(healResult.targetHp).toBe(12);
      expect(healResult.targetMaxHp).toBe(12);
    }

    const fighter = service.getCharacterSheet(POC_CAMPAIGN_ID, 'char-fighter-1');
    expect(fighter.hp).toBe(12);

    db.close();
  });

  it('executes APPLY_DAMAGE command for environmental traps', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    // Spike Trap deals 2d6 piercing damage to Rogue (9 HP)
    // 2d6 rolls: 3, 2 -> 5 damage -> Rogue HP 9 -> 4
    const rng = new DeterministicRng([3, 2]);
    const service = new CommandService(db, rng);

    const dmgResult = service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'cmd-trap-1', expectedVersion: 0 },
      {
        type: 'APPLY_DAMAGE',
        targetId: 'char-rogue-1',
        amountFormula: '2d6',
        damageType: 'piercing',
        source: 'Floor Spike Trap',
      }
    );

    expect(dmgResult.stateVersion).toBe(1);
    if ('damageType' in dmgResult) {
      expect(dmgResult.totalDamage).toBe(5);
      expect(dmgResult.targetHp).toBe(4);
      expect(dmgResult.damageType).toBe('piercing');
    }

    db.close();
  });

  it('executes MOVE command and updates grid coordinates', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const service = new CommandService(db);

    const moveResult = service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'cmd-move-1', expectedVersion: 0 },
      {
        type: 'MOVE',
        characterId: 'char-fighter-1',
        toX: 7,
        toY: 10,
      }
    );

    expect(moveResult.stateVersion).toBe(1);
    if ('newPosition' in moveResult) {
      expect(moveResult.previousPosition).toEqual({ x: 2, y: 5 });
      expect(moveResult.newPosition).toEqual({ x: 7, y: 10 });
    }

    const fighter = service.getCharacterSheet(POC_CAMPAIGN_ID, 'char-fighter-1');
    expect(fighter.position).toEqual({ x: 7, y: 10 });

    db.close();
  });

  it('executes REST command (long rest restores full HP)', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    db.prepare('UPDATE characters SET hp = 2 WHERE id = ?').run('char-fighter-1');

    const service = new CommandService(db);
    const restResult = service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'cmd-rest-1', expectedVersion: 0 },
      {
        type: 'REST',
        characterId: 'char-fighter-1',
        restType: 'long',
      }
    );

    expect(restResult.stateVersion).toBe(1);
    if ('targetHp' in restResult) {
      expect(restResult.targetPreviousHp).toBe(2);
      expect(restResult.targetHp).toBe(12);
    }

    const fighter = service.getCharacterSheet(POC_CAMPAIGN_ID, 'char-fighter-1');
    expect(fighter.hp).toBe(12);

    db.close();
  });

  it('enforces idempotency and rejects conflicting command types for same actionId', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const rng = new DeterministicRng([14, 5]);
    const service = new CommandService(db, rng);

    // Initial attack
    const first = service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'idem-1', expectedVersion: 0 },
      {
        type: 'ATTACK',
        attackerId: 'char-fighter-1',
        targetId: 'goblin-1',
      }
    );
    expect(first.isDuplicate).toBe(false);

    // Repeat identical command
    const repeat = service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'idem-1', expectedVersion: 0 },
      {
        type: 'ATTACK',
        attackerId: 'char-fighter-1',
        targetId: 'goblin-1',
      }
    );
    expect(repeat.isDuplicate).toBe(true);

    // Repeat with different command type -> ConflictError
    expect(() =>
      service.executeCommand(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'idem-1', expectedVersion: 0 },
        {
          type: 'HEAL',
          targetId: 'char-fighter-1',
          amountFormula: '5',
          source: 'Spell',
        }
      )
    ).toThrow(ConflictError);

    db.close();
  });

  it('rejects stale state versions before applying changes', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const rng = new DeterministicRng([12, 3]);
    const service = new CommandService(db, rng);

    // Command 1 brings campaign to version 1
    service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'seq-1', expectedVersion: 0 },
      {
        type: 'ATTACK',
        attackerId: 'char-fighter-1',
        targetId: 'goblin-1',
      }
    );

    // Command 2 with stale expectedVersion 0
    expect(() =>
      service.executeCommand(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'seq-2', expectedVersion: 0 },
        {
          type: 'MOVE',
          characterId: 'char-fighter-1',
          toX: 1,
          toY: 1,
        }
      )
    ).toThrow(VersionConflictError);

    db.close();
  });

  it('replays all campaign events to verify state reconstruction', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    // Sequence:
    // 1. Trap deals 4 damage to fighter (12 -> 8)
    // 2. Cleric heals fighter for 3 (8 -> 11)
    // 3. Fighter moves to (5, 5)
    // 4. Long rest restores fighter to 12
    const rng = new DeterministicRng([4, 3]);
    const service = new CommandService(db, rng);

    service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'chain-1', expectedVersion: 0 },
      { type: 'APPLY_DAMAGE', targetId: 'char-fighter-1', amountFormula: '4', damageType: 'trap', source: 'Trap' }
    );

    service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'chain-2', expectedVersion: 1 },
      { type: 'HEAL', targetId: 'char-fighter-1', amountFormula: '3', source: 'Cure Wounds' }
    );

    service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'chain-3', expectedVersion: 2 },
      { type: 'MOVE', characterId: 'char-fighter-1', toX: 5, toY: 5 }
    );

    service.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'chain-4', expectedVersion: 3 },
      { type: 'REST', characterId: 'char-fighter-1', restType: 'long' }
    );

    // Replay events
    const replay = service.replayEvents(POC_CAMPAIGN_ID);
    expect(replay.replayedVersion).toBe(4);
    expect(replay.characterHp['char-fighter-1']).toBe(12);

    db.close();
  });

  it('persists changes across process restart on disk database', () => {
    // 1. Initial process
    const db1 = initDatabase({ dbPath: TEST_DB });
    const rng1 = new DeterministicRng([15, 6]); // 15+5=20 hit, 6+3=9 damage -> goblin HP 7 -> 0
    const service1 = new CommandService(db1, rng1);

    service1.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'disk-1', expectedVersion: 0 },
      { type: 'ATTACK', attackerId: 'char-fighter-1', targetId: 'goblin-1' }
    );
    db1.close();

    // 2. Reopen DB
    const db2 = initDatabase({ dbPath: TEST_DB });
    const service2 = new CommandService(db2);

    const goblin = service2.getCharacterSheet(POC_CAMPAIGN_ID, 'goblin-1');
    expect(goblin.hp).toBe(0);

    // Continue action on reopened DB
    service2.executeCommand(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'disk-2', expectedVersion: 1 },
      { type: 'MOVE', characterId: 'char-fighter-1', toX: 8, toY: 8 }
    );

    const fighter = service2.getCharacterSheet(POC_CAMPAIGN_ID, 'char-fighter-1');
    expect(fighter.position).toEqual({ x: 8, y: 8 });

    db2.close();
  });
});
