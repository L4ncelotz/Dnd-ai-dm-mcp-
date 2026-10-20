import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type GameContext,
  type PendingAction,
  type AbilityCheckIntent,
  type AbilityCheckResult,
  type ResolutionProposal,
  type NarrationPayload,
  type SafeCharacterState,
} from '../domain/types.js';
import { type Rng, CryptoRng } from '../domain/rng.js';
import { DiceParser } from '../domain/dice.js';
import { calculateAbilityModifier } from '../domain/character.js';
import {
  CommandService,
  type ActionCommand,
  type CommandContext,
  type CommandExecutionResult,
} from './commandService.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  VersionConflictError,
} from './gameService.js';

interface DbPendingActionRow {
  id: string;
  campaign_id: string;
  character_id: string;
  intent_text: string;
  status: 'pending' | 'resolved' | 'cancelled';
  action_type: string | null;
  created_at: string;
}

interface DbSceneRow {
  campaign_id: string;
  location: string;
  location_th: string;
  description: string;
  description_th: string;
  revealed_clues_json: string;
  secret_traps_json: string;
  secret_enemies_json: string;
}

interface DbNarrationEventRow {
  id: string;
  action_id: string;
  payload_json: string;
  state_version: number;
  created_at: string;
}

interface DbCampaignRow {
  id: string;
  state_version: number;
  created_at: string;
}

export class AiWorkflowService {
  private readonly db: DatabaseSync;
  private readonly commandService: CommandService;
  private readonly rng: Rng;

  constructor(
    db: DatabaseSync,
    commandService: CommandService = new CommandService(db),
    rng: Rng = new CryptoRng()
  ) {
    this.db = db;
    this.commandService = commandService;
    this.rng = rng;
  }

  /**
   * Submits a player's free-form or tactical intention into the pending actions queue.
   */
  submitPlayerAction(
    campaignId: string,
    characterId: string,
    intentText: string,
    actionType?: string
  ): PendingAction {
    if (!campaignId) throw new ValidationError('campaignId is required');
    if (!characterId) throw new ValidationError('characterId is required');
    if (!intentText || !intentText.trim()) throw new ValidationError('intentText cannot be empty');

    const id = `act-${randomUUID()}`;
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO pending_actions (id, campaign_id, character_id, intent_text, status, action_type, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `)
      .run(id, campaignId, characterId, intentText.trim(), actionType ?? null, now);

    return {
      id,
      campaignId,
      characterId,
      intentText: intentText.trim(),
      status: 'pending',
      actionType,
      createdAt: now,
    };
  }

  /**
   * Returns all pending player actions waiting to be resolved for a campaign.
   */
  getPendingActions(campaignId: string): PendingAction[] {
    if (!campaignId) throw new ValidationError('campaignId is required');

    const rows = this.db
      .prepare(`
        SELECT * FROM pending_actions
        WHERE campaign_id = ? AND status = 'pending'
        ORDER BY created_at ASC
      `)
      .all(campaignId) as unknown as DbPendingActionRow[];

    return rows.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      characterId: r.character_id,
      intentText: r.intent_text,
      status: r.status,
      actionType: r.action_type ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /**
   * Marks a pending action as resolved.
   */
  consumePendingAction(campaignId: string, pendingActionId: string): void {
    this.db
      .prepare(`
        UPDATE pending_actions
        SET status = 'resolved'
        WHERE campaign_id = ? AND id = ?
      `)
      .run(campaignId, pendingActionId);
  }

  /**
   * Returns sanitized game context for the AI narrator.
   * CRITICAL SECURITY INVARIANT: Concealed traps, hidden monsters, and secret plot triggers
   * are strictly filtered out and never returned across this interface.
   */
  getGameContext(campaignId: string): GameContext {
    if (!campaignId) throw new ValidationError('campaignId is required');

    const campaign = this.db
      .prepare('SELECT id, state_version FROM campaigns WHERE id = ?')
      .get(campaignId) as unknown as DbCampaignRow | undefined;

    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found`);
    }

    // 1. Load scene
    const sceneRow = this.db
      .prepare('SELECT * FROM scenes WHERE campaign_id = ?')
      .get(campaignId) as unknown as DbSceneRow | undefined;

    const scene = sceneRow
      ? {
          location: sceneRow.location,
          locationTh: sceneRow.location_th,
          description: sceneRow.description,
          descriptionTh: sceneRow.description_th,
          revealedClues: JSON.parse(sceneRow.revealed_clues_json) as string[],
        }
      : {
          location: 'Dungeon Room',
          locationTh: 'ห้องดันเจี้ยน',
          description: 'A stone room with torchlight.',
          descriptionTh: 'ห้องหินที่มีแสงคบเพลิงส่องสว่าง',
          revealedClues: [],
        };

    // 2. Load party and visible enemies
    // Party characters are heroes/players
    const characters = this.db
      .prepare('SELECT id, name, hp, max_hp, armor_class FROM characters WHERE campaign_id = ?')
      .all(campaignId) as unknown as Array<{ id: string; name: string; hp: number; max_hp: number; armor_class: number }>;

    const party: SafeCharacterState[] = [];
    const visibleEnemies: SafeCharacterState[] = [];

    for (const c of characters) {
      const safe: SafeCharacterState = {
        id: c.id,
        name: c.name,
        hp: c.hp,
        maxHp: c.max_hp,
        armorClass: c.armor_class,
      };

      if (c.id.startsWith('goblin') || c.id.startsWith('monster')) {
        visibleEnemies.push(safe);
      } else {
        party.push(safe);
      }
    }

    // 3. Load recent narrations (last 5)
    const narrationEvents = this.db
      .prepare(`
        SELECT id, action_id, payload_json, state_version, created_at
        FROM game_events
        WHERE campaign_id = ? AND type = 'NARRATION_PUBLISHED'
        ORDER BY state_version DESC
        LIMIT 5
      `)
      .all(campaignId) as unknown as DbNarrationEventRow[];

    const recentNarrations = narrationEvents.reverse().map((r) => {
      const payload = JSON.parse(r.payload_json) as NarrationPayload;
      return {
        id: r.id,
        speakerName: payload.speakerName,
        text: payload.textTh || payload.text,
        createdAt: r.created_at,
      };
    });

    // 4. Count pending actions
    const pendingCountRow = this.db
      .prepare("SELECT COUNT(*) as cnt FROM pending_actions WHERE campaign_id = ? AND status = 'pending'")
      .get(campaignId) as unknown as { cnt: number };

    return {
      campaignId,
      stateVersion: campaign.state_version,
      scene,
      party,
      visibleEnemies,
      recentNarrations,
      pendingActionCount: pendingCountRow.cnt,
    };
  }

  /**
   * Resolves an open-ended ability check (e.g. Perception, Athletics, Stealth) server-side.
   * Calculates genuine d20 roll + ability modifier vs DC and records event.
   */
  resolveAbilityCheck(context: CommandContext, intent: AbilityCheckIntent): AbilityCheckResult {
    const { campaignId, actionId, expectedVersion } = context;
    const { characterId, ability, dc, skill, reason, advantageMode = 'none' } = intent;

    if (!campaignId) throw new ValidationError('campaignId is required');
    if (!actionId) throw new ValidationError('actionId is required');
    if (!characterId) throw new ValidationError('characterId is required');
    if (!Number.isInteger(dc) || dc <= 0) throw new ValidationError('DC must be a positive integer');

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      // 1. Idempotency check
      const existingEvent = this.db
        .prepare('SELECT * FROM game_events WHERE campaign_id = ? AND action_id = ?')
        .get(campaignId, actionId) as unknown as { payload_json: string } | undefined;

      if (existingEvent) {
        this.db.exec('COMMIT;');
        const recorded = JSON.parse(existingEvent.payload_json) as AbilityCheckResult;
        return { ...recorded, isDuplicate: true };
      }

      // 2. Version guard
      const campaign = this.db
        .prepare('SELECT state_version FROM campaigns WHERE id = ?')
        .get(campaignId) as unknown as DbCampaignRow | undefined;

      if (!campaign) throw new NotFoundError(`Campaign '${campaignId}' not found`);
      if (campaign.state_version !== expectedVersion) {
        throw new VersionConflictError(
          `Stale state version: expected ${expectedVersion}, but campaign is at version ${campaign.state_version}`
        );
      }

      // 3. Load character abilities
      const charSheet = this.commandService.getCharacterSheet(campaignId, characterId);
      const score = charSheet.abilities[ability];
      if (score === undefined) {
        throw new ValidationError(`Unknown ability score '${ability}' on character '${characterId}'`);
      }

      const modifier = calculateAbilityModifier(score);

      // Roll d20 with advantage / disadvantage
      const rollRes = DiceParser.roll('1d20', this.rng, advantageMode);
      const diceTerm = rollRes.terms[0];
      if (diceTerm.type !== 'dice') throw new Error('Roll failed');

      const d20 = diceTerm.rolls[0];
      const discardedD20 = diceTerm.discardedRolls?.[0];
      const total = d20 + modifier;
      const isSuccess = total >= dc;
      const nextVersion = campaign.state_version + 1;

      const result: AbilityCheckResult = {
        actionId,
        campaignId,
        stateVersion: nextVersion,
        characterId,
        ability,
        skill,
        dc,
        d20,
        discardedD20,
        modifier,
        total,
        isSuccess,
        reason,
        isDuplicate: false,
      };

      // Update state version
      this.db.prepare('UPDATE campaigns SET state_version = ? WHERE id = ?').run(nextVersion, campaignId);

      // Insert event
      const eventId = `evt-${randomUUID()}`;
      this.db
        .prepare(`
          INSERT INTO game_events (id, campaign_id, action_id, type, payload_json, state_version, created_at)
          VALUES (?, ?, ?, 'ABILITY_CHECK_RESOLVED', ?, ?, ?)
        `)
        .run(eventId, campaignId, actionId, JSON.stringify(result), nextVersion, new Date().toISOString());

      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      throw err;
    }
  }

  /**
   * Proposes a mechanical resolution for an ambiguous player intention before execution.
   */
  proposeResolution(proposal: ResolutionProposal): ResolutionProposal {
    if (!proposal.campaignId) throw new ValidationError('campaignId is required');
    if (!proposal.actionId) throw new ValidationError('actionId is required');
    if (!proposal.proposedResolutionType) throw new ValidationError('proposedResolutionType is required');
    if (!proposal.explanation || !proposal.explanation.trim()) {
      throw new ValidationError('explanation is required for resolution proposal');
    }

    return proposal;
  }

  /**
   * Executes a game action via CommandService, consuming any linked pending action.
   */
  resolveAction(
    context: CommandContext,
    command: ActionCommand,
    pendingActionId?: string
  ): CommandExecutionResult {
    const result = this.commandService.executeCommand(context, command);

    if (pendingActionId) {
      this.consumePendingAction(context.campaignId, pendingActionId);
    }

    return result;
  }

  /**
   * Publishes an AI narrator's story text into the authorized event feed.
   * INVARIANT: Narration cannot mutate character HP, AC, inventory, or positions.
   */
  publishNarration(
    context: CommandContext,
    params: { text: string; textTh?: string; speakerName?: string }
  ): NarrationPayload {
    const { campaignId, actionId, expectedVersion } = context;
    const { text, textTh, speakerName } = params;

    if (!campaignId) throw new ValidationError('campaignId is required');
    if (!actionId) throw new ValidationError('actionId is required');
    if (!text || !text.trim()) throw new ValidationError('Narration text cannot be empty');

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      // 1. Idempotency check
      const existingEvent = this.db
        .prepare('SELECT * FROM game_events WHERE campaign_id = ? AND action_id = ?')
        .get(campaignId, actionId) as unknown as { payload_json: string } | undefined;

      if (existingEvent) {
        this.db.exec('COMMIT;');
        const recorded = JSON.parse(existingEvent.payload_json) as NarrationPayload;
        return { ...recorded, isDuplicate: true };
      }

      // 2. Version guard
      const campaign = this.db
        .prepare('SELECT state_version FROM campaigns WHERE id = ?')
        .get(campaignId) as unknown as DbCampaignRow | undefined;

      if (!campaign) throw new NotFoundError(`Campaign '${campaignId}' not found`);
      if (campaign.state_version !== expectedVersion) {
        throw new VersionConflictError(
          `Stale state version: expected ${expectedVersion}, but campaign is at version ${campaign.state_version}`
        );
      }

      const nextVersion = campaign.state_version + 1;
      const payload: NarrationPayload = {
        actionId,
        campaignId,
        stateVersion: nextVersion,
        text: text.trim(),
        textTh: textTh?.trim(),
        speakerName: speakerName?.trim(),
        isDuplicate: false,
      };

      // 3. Increment campaign version
      this.db.prepare('UPDATE campaigns SET state_version = ? WHERE id = ?').run(nextVersion, campaignId);

      // 4. Insert NARRATION_PUBLISHED event
      const eventId = `evt-${randomUUID()}`;
      this.db
        .prepare(`
          INSERT INTO game_events (id, campaign_id, action_id, type, payload_json, state_version, created_at)
          VALUES (?, ?, ?, 'NARRATION_PUBLISHED', ?, ?, ?)
        `)
        .run(eventId, campaignId, actionId, JSON.stringify(payload), nextVersion, new Date().toISOString());

      this.db.exec('COMMIT;');
      return payload;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      throw err;
    }
  }
}
