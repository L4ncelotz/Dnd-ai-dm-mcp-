import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AttackIntent,
  type AttackResolutionResult,
  type Character,
  type GameEvent,
  type SafeGameState,
} from '../domain/types.js';
import { ALLOWED_FIXTURE_IDS, resolveAttack } from '../domain/rules.js';
import { type Rng, CryptoRng } from '../domain/rng.js';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class VersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionConflictError';
  }
}

interface CampaignRow {
  id: string;
  state_version: number;
  created_at: string;
}

interface CharacterRow {
  id: string;
  campaign_id: string;
  name: string;
  role: 'player' | 'npc' | 'monster';
  visibility: 'public' | 'hidden';
  hp: number;
  max_hp: number;
  armor_class: number;
}

interface GameEventRow {
  id: string;
  campaign_id: string;
  action_id: string;
  type: string;
  payload_json: string;
  state_version: number;
  created_at: string;
}

export class GameService {
  private readonly db: DatabaseSync;
  private readonly rng: Rng;

  constructor(db: DatabaseSync, rng: Rng = new CryptoRng()) {
    this.db = db;
    this.rng = rng;
  }

  get database(): DatabaseSync {
    return this.db;
  }

  /**
   * Returns safe, visible game state for the given campaign.
   */
  getGameState(campaignId: string): SafeGameState {
    if (!campaignId || typeof campaignId !== 'string') {
      throw new ValidationError('campaignId is required and must be a string');
    }

    const campaign = this.db
      .prepare('SELECT id, state_version, created_at FROM campaigns WHERE id = ?')
      .get(campaignId) as CampaignRow | undefined;

    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found`);
    }

    const characterRows = this.db
      .prepare(
        "SELECT id, campaign_id, name, role, visibility, hp, max_hp, armor_class FROM characters WHERE campaign_id = ? AND visibility = 'public' ORDER BY id ASC"
      )
      .all(campaignId) as unknown as CharacterRow[];
    return {
      campaignId: campaign.id,
      stateVersion: campaign.state_version,
      characters: characterRows.map((r) => ({
        id: r.id,
        name: r.name,
        hp: r.hp,
        maxHp: r.max_hp,
        armorClass: r.armor_class,
      })),
    };
  }

  /**
   * Resolves a test attack atomically with version checking, genuine RNG,
   * idempotency key enforcement, and durable event logging.
   */
  resolveTestAttack(intent: AttackIntent): AttackResolutionResult {
    const { campaignId, actionId, expectedVersion, attackerId, targetId } = intent;

    // Fast domain validation
    if (!campaignId) throw new ValidationError('campaignId is required');
    if (!actionId) throw new ValidationError('actionId is required');
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new ValidationError('expectedVersion must be a non-negative integer');
    }
    if (!ALLOWED_FIXTURE_IDS[attackerId]) {
      throw new ValidationError(`Attacker '${attackerId}' is not permitted for the Phase 00 fixture`);
    }
    if (!ALLOWED_FIXTURE_IDS[targetId]) {
      throw new ValidationError(`Target '${targetId}' is not permitted for the Phase 00 fixture`);
    }
    if (attackerId === targetId) {
      throw new ValidationError('Attacker and target cannot be the same character');
    }

    // Use BEGIN IMMEDIATE to serialize concurrent writes
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      // 1. Check for existing action ID (Idempotency check)
      const existingEventRow = this.db
        .prepare('SELECT * FROM game_events WHERE campaign_id = ? AND action_id = ?')
        .get(campaignId, actionId) as unknown as GameEventRow | undefined;

      if (existingEventRow) {
        this.db.exec('COMMIT;');
        const recordedResult = JSON.parse(existingEventRow.payload_json) as AttackResolutionResult;

        // Verify inputs match
        if (
          recordedResult.attackerId !== attackerId ||
          recordedResult.targetId !== targetId
        ) {
          throw new ConflictError(
            `Action '${actionId}' has already been executed with different parameters`
          );
        }

        return {
          ...recordedResult,
          isDuplicate: true,
        };
      }

      // 2. Load campaign and verify state version before rolling dice
      const campaign = this.db
        .prepare('SELECT id, state_version FROM campaigns WHERE id = ?')
        .get(campaignId) as CampaignRow | undefined;

      if (!campaign) {
        throw new NotFoundError(`Campaign '${campaignId}' not found`);
      }

      if (campaign.state_version !== expectedVersion) {
        throw new VersionConflictError(
          `Stale state version: expected ${expectedVersion}, but campaign is at version ${campaign.state_version}`
        );
      }

      // 3. Load target character
      const targetRow = this.db
        .prepare('SELECT * FROM characters WHERE campaign_id = ? AND id = ?')
        .get(campaignId, targetId) as unknown as CharacterRow | undefined;

      if (!targetRow) {
        throw new NotFoundError(`Target '${targetId}' not found in campaign '${campaignId}'`);
      }

      const targetCharacter: Character = {
        id: targetRow.id,
        campaignId: targetRow.campaign_id,
        name: targetRow.name,
        hp: targetRow.hp,
        maxHp: targetRow.max_hp,
        armorClass: targetRow.armor_class,
      };

      // 4. Resolve attack mechanics using injected RNG
      const outcome = resolveAttack(attackerId, targetCharacter, this.rng);
      const newVersion = campaign.state_version + 1;
      const now = new Date().toISOString();

      const resultPayload: AttackResolutionResult = {
        actionId,
        campaignId,
        stateVersion: newVersion,
        attackerId,
        targetId,
        roll: {
          d20: outcome.rollDetails.d20,
          bonus: outcome.rollDetails.attackBonus,
          total: outcome.rollDetails.attackTotal,
          targetAc: outcome.rollDetails.targetAc,
          isHit: outcome.rollDetails.isHit,
          isCriticalHit: outcome.rollDetails.isCriticalHit,
        },
        damage: outcome.rollDetails.totalDamage,
        targetPreviousHp: outcome.previousHp,
        targetHp: outcome.newHp,
        targetMaxHp: targetCharacter.maxHp,
        isDuplicate: false,
      };

      // 5. Update target HP
      this.db
        .prepare('UPDATE characters SET hp = ? WHERE campaign_id = ? AND id = ?')
        .run(outcome.newHp, campaignId, targetId);

      // 6. Update campaign state version
      this.db
        .prepare('UPDATE campaigns SET state_version = ? WHERE id = ?')
        .run(newVersion, campaignId);

      // 7. Insert audit event
      const eventId = `evt-${randomUUID()}`;
      this.db
        .prepare(`
          INSERT INTO game_events (id, campaign_id, action_id, type, payload_json, state_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          eventId,
          campaignId,
          actionId,
          'ATTACK_RESOLVED',
          JSON.stringify(resultPayload),
          newVersion,
          now
        );

      this.db.exec('COMMIT;');
      return resultPayload;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Rollback can fail if transaction was already committed or not started
      }
      throw err;
    }
  }

  /**
   * Returns bounded, non-secret chronological event log for the campaign.
   */
  getEventLog(campaignId: string, limit: number = 50): GameEvent[] {
    if (!campaignId) throw new ValidationError('campaignId is required');

    const boundedLimit = Math.min(Math.max(1, limit), 100);

    const rows = this.db
      .prepare(`
        SELECT id, campaign_id, action_id, type, payload_json, state_version, created_at
        FROM game_events
        WHERE campaign_id = ?
        ORDER BY state_version DESC
        LIMIT ?
      `)
      .all(campaignId, boundedLimit) as unknown as GameEventRow[];

    // Return in chronological ascending order
    rows.reverse();
    return rows.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      actionId: r.action_id,
      type: r.type,
      payload: JSON.parse(r.payload_json),
      stateVersion: r.state_version,
      createdAt: r.created_at,
    }));
  }
}
