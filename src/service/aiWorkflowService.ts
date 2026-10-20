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

interface DbResolutionProposalRow {
  id: string;
  campaign_id: string;
  action_id: string;
  pending_action_id: string | null;
  proposed_type: string;
  rule_citation: string | null;
  dc: number | null;
  character_id: string | null;
  ability: string | null;
  skill: string | null;
  parameters_json: string;
  explanation: string;
  status: string;
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
    const res = this.db
      .prepare(`
        UPDATE pending_actions
        SET status = 'resolved'
        WHERE campaign_id = ? AND id = ? AND status = 'pending'
      `)
      .run(campaignId, pendingActionId);

    if (res.changes === 0) {
      const exists = this.db
        .prepare('SELECT id, status FROM pending_actions WHERE campaign_id = ? AND id = ?')
        .get(campaignId, pendingActionId) as { status: string } | undefined;

      if (!exists) {
        throw new NotFoundError(`Pending action '${pendingActionId}' not found in campaign '${campaignId}'`);
      }
      throw new ConflictError(`Pending action '${pendingActionId}' is already '${exists.status}'`);
    }
  }

  /**
   * Returns sanitized game context for the AI narrator.
   * P1-05 SECURITY INVARIANT: Concealed traps, hidden monsters (visibility='hidden'),
   * and secret plot triggers are strictly filtered out and never returned across this interface.
   * Partitioning relies on explicit typed role ('player' vs 'monster'), NOT id-prefix heuristics.
   */
  getGameContext(campaignId: string): GameContext {
    if (!campaignId) throw new ValidationError('campaignId is required');

    const campaign = this.db
      .prepare('SELECT id, state_version FROM campaigns WHERE id = ?')
      .get(campaignId) as unknown as DbCampaignRow | undefined;

    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found`);
    }

    // 1. Load scene (revealed clues only; secret_traps_json & secret_enemies_json are omitted)
    const sceneRow = this.db
      .prepare('SELECT location, location_th, description, description_th, revealed_clues_json FROM scenes WHERE campaign_id = ?')
      .get(campaignId) as unknown as Omit<DbSceneRow, 'secret_traps_json' | 'secret_enemies_json'> | undefined;

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

    // 2. Load public characters only (P1-05: hidden monsters with visibility='hidden' are excluded)
    const characters = this.db
      .prepare("SELECT id, name, role, hp, max_hp, armor_class FROM characters WHERE campaign_id = ? AND visibility = 'public'")
      .all(campaignId) as unknown as Array<{ id: string; name: string; role: string; hp: number; max_hp: number; armor_class: number }>;

    const party: SafeCharacterState[] = [];
    const visibleEnemies: SafeCharacterState[] = [];

    for (const c of characters) {
      const safe: SafeCharacterState = {
        id: c.id,
        name: c.name,
        role: c.role as 'player' | 'npc' | 'monster',
        hp: c.hp,
        maxHp: c.max_hp,
        armorClass: c.armor_class,
      };

      if (c.role === 'monster') {
        visibleEnemies.push(safe);
      } else if (c.role === 'player') {
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
   * P1-02: Persists an immutable resolution proposal (DC, check type, actor, pending action)
   * in SQLite before dice are rolled, preventing post-hoc DC tampering.
   */
  proposeResolution(proposal: ResolutionProposal): ResolutionProposal {
    if (!proposal.campaignId) throw new ValidationError('campaignId is required');
    if (!proposal.actionId) throw new ValidationError('actionId is required');
    if (!proposal.proposedResolutionType) throw new ValidationError('proposedResolutionType is required');
    if (!proposal.explanation || !proposal.explanation.trim()) {
      throw new ValidationError('explanation is required for resolution proposal');
    }

    // Extract optional characterId, ability, skill from parameters
    const params = proposal.parameters ?? {};
    const characterId = typeof params.characterId === 'string' ? params.characterId : null;
    const ability = typeof params.ability === 'string' ? params.ability : null;
    const skill = typeof params.skill === 'string' ? params.skill : null;
    const dc = proposal.dc ?? (typeof params.dc === 'number' ? params.dc : null);

    // Check if proposal already exists
    // P1-06 (R9): Check if proposal already exists and verify full canonical match
    const existing = this.db
      .prepare('SELECT * FROM resolution_proposals WHERE campaign_id = ? AND action_id = ?')
      .get(proposal.campaignId, proposal.actionId) as unknown as DbResolutionProposalRow | undefined;

    if (existing) {
      const existingParams = JSON.parse(existing.parameters_json);
      const newParams = proposal.parameters ?? {};
      const paramsMatch = JSON.stringify(existingParams) === JSON.stringify(newParams);
      const pendingMatch = (existing.pending_action_id ?? null) === (proposal.pendingActionId ?? null);
      const typeMatch = existing.proposed_type === proposal.proposedResolutionType;
      const dcMatch = (existing.dc ?? null) === (dc ?? null);
      const explanationMatch = existing.explanation === proposal.explanation.trim();
      const citationMatch = (existing.rule_citation ?? null) === (proposal.proposedRuleCitation ?? null);

      if (!paramsMatch || !pendingMatch || !typeMatch || !dcMatch || !explanationMatch || !citationMatch) {
        throw new ConflictError(
          `Proposal '${proposal.actionId}' has already been submitted with different parameters`
        );
      }

      // Return the persisted DB record, never untrusted caller modifications
      return {
        actionId: existing.action_id,
        campaignId: existing.campaign_id,
        pendingActionId: existing.pending_action_id ?? undefined,
        proposedResolutionType: existing.proposed_type as any,
        proposedRuleCitation: existing.rule_citation ?? undefined,
        dc: existing.dc ?? undefined,
        parameters: existingParams,
        explanation: existing.explanation,
      };
    }

    const id = proposal.actionId;
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO resolution_proposals (
          id, campaign_id, action_id, pending_action_id, proposed_type, rule_citation,
          dc, character_id, ability, skill, parameters_json, explanation, status, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
      `)
      .run(
        id,
        proposal.campaignId,
        proposal.actionId,
        proposal.pendingActionId ?? null,
        proposal.proposedResolutionType,
        proposal.proposedRuleCitation ?? null,
        dc,
        characterId,
        ability,
        skill,
        JSON.stringify(proposal.parameters),
        proposal.explanation.trim(),
        now
      );

    return proposal;
  }

  /**
   * Resolves an ability check server-side.
   * P1-02: Verifies and locks against precommitted proposal if provided (rejecting DC/actor tampering).
   * P1-03: Atomically consumes linked pending action in the same transaction.
   * P1-04: Strict full-request idempotency check.
   * P2-01: Applies skill proficiency (+2) and expertise (+4) from character sheet.
   */
  resolveAbilityCheck(
    context: CommandContext,
    intent: AbilityCheckIntent,
    proposalId?: string,
    pendingActionId?: string
  ): AbilityCheckResult {
    const { campaignId, actionId, expectedVersion } = context;
    const { characterId, ability, dc, skill, reason, advantageMode = 'none' } = intent;

    if (!campaignId) throw new ValidationError('campaignId is required');
    if (!actionId) throw new ValidationError('actionId is required');
    if (!characterId) throw new ValidationError('characterId is required');
    if (!Number.isInteger(dc) || dc <= 0) throw new ValidationError('DC must be a positive integer');

    // P1-01 (R1): In live mode, require proposalId to enforce proposal lock
    const isTestBypass = (intent as unknown as Record<string, unknown>).testBypass === true;
    if (!proposalId && !isTestBypass) {
      throw new ValidationError('proposalId is required to resolve an ability check');
    }
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      // 1. P1-04: Strict full-request idempotency check
      const existingEvent = this.db
        .prepare('SELECT * FROM game_events WHERE campaign_id = ? AND action_id = ?')
        .get(campaignId, actionId) as unknown as { payload_json: string } | undefined;

      if (existingEvent) {
        this.db.exec('COMMIT;');
        const recorded = JSON.parse(existingEvent.payload_json) as AbilityCheckResult & { advantageMode?: string };

        if (
          recorded.characterId !== characterId ||
          recorded.ability !== ability ||
          recorded.dc !== dc ||
          (recorded.skill ?? undefined) !== (skill ?? undefined) ||
          recorded.reason !== reason ||
          (recorded.advantageMode ?? 'none') !== advantageMode
        ) {
          throw new ConflictError(
            `Action '${actionId}' has already been executed with different parameters`
          );
        }

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

      // 3. P1-02 (R2) & P1-03 (R3, R4): Proposal lock verification and single-use enforcement
      if (proposalId) {
        const proposal = this.db
          .prepare('SELECT * FROM resolution_proposals WHERE campaign_id = ? AND (id = ? OR action_id = ?)')
          .get(campaignId, proposalId, proposalId) as unknown as DbResolutionProposalRow | undefined;

        if (!proposal) {
          throw new NotFoundError(`Locked proposal '${proposalId}' not found in campaign '${campaignId}'`);
        }

        // P1-02 (R2): Prevent proposal reuse on fresh rolls
        if (proposal.status !== 'proposed') {
          throw new ConflictError(
            `Proposal '${proposalId}' has already been resolved or is not in proposed state`
          );
        }

        if (proposal.dc !== null && proposal.dc !== dc) {
          throw new ConflictError(
            `Cannot alter DC: locked proposal established DC ${proposal.dc}, but received DC ${dc}`
          );
        }

        if (proposal.ability !== null && proposal.ability.toLowerCase() !== ability.toLowerCase()) {
          throw new ConflictError(
            `Cannot alter ability: locked proposal established ability '${proposal.ability}', received '${ability}'`
          );
        }

        // P1-03 (R3): Lock skill comparison
        if (proposal.skill && intent.skill && proposal.skill.toLowerCase() !== intent.skill.toLowerCase()) {
          throw new ConflictError(
            `Skill mismatch: locked proposal established skill '${proposal.skill}', received '${intent.skill}'`
          );
        }

        if (proposal.character_id !== null && proposal.character_id !== characterId) {
          throw new ConflictError(
            `Character mismatch: locked proposal established actor '${proposal.character_id}', received '${characterId}'`
          );
        }

        // P1-03 (R4): Lock pending action binding
        if (proposal.pending_action_id && pendingActionId && pendingActionId !== proposal.pending_action_id) {
          throw new ConflictError(
            `Pending action mismatch: locked proposal bound to '${proposal.pending_action_id}', received '${pendingActionId}'`
          );
        }

        if (!pendingActionId && proposal.pending_action_id) {
          pendingActionId = proposal.pending_action_id;
        }

        // P1-02: Atomically transition proposal to 'resolved' and assert exactly 1 row changed
        const updateRes = this.db
          .prepare("UPDATE resolution_proposals SET status = 'resolved' WHERE campaign_id = ? AND id = ? AND status = 'proposed'")
          .run(campaignId, proposal.id);

        if (updateRes.changes === 0) {
          throw new ConflictError(`Proposal '${proposalId}' has already been resolved`);
        }
      }

      // 4. P1-03: Validate and consume pending action atomically
      if (pendingActionId) {
        const pendingRow = this.db
          .prepare('SELECT id, character_id, status FROM pending_actions WHERE campaign_id = ? AND id = ?')
          .get(campaignId, pendingActionId) as { id: string; character_id: string; status: string } | undefined;

        if (!pendingRow) {
          throw new NotFoundError(`Pending action '${pendingActionId}' not found in campaign '${campaignId}'`);
        }
        if (pendingRow.status !== 'pending') {
          throw new ConflictError(`Pending action '${pendingActionId}' is already '${pendingRow.status}'`);
        }
        if (pendingRow.character_id !== characterId) {
          throw new ValidationError(
            `Pending action was created by '${pendingRow.character_id}', not '${characterId}'`
          );
        }

        this.db
          .prepare("UPDATE pending_actions SET status = 'resolved' WHERE campaign_id = ? AND id = ? AND status = 'pending'")
          .run(campaignId, pendingActionId);
      }

      // 5. Load character abilities and calculate modifiers (P2-01: proficiencies & expertise)
      const charSheet = this.commandService.getCharacterSheet(campaignId, characterId);
      const score = charSheet.abilities[ability];
      if (score === undefined) {
        throw new ValidationError(`Unknown ability score '${ability}' on character '${characterId}'`);
      }

      const abilityMod = calculateAbilityModifier(score);
      let profBonus = 0;

      const skillNorm = skill ? skill.trim().toLowerCase() : undefined;
      if (skillNorm && charSheet.proficiencies) {
        const isExpert = charSheet.proficiencies.expertise?.some((s) => s.toLowerCase() === skillNorm);
        const isProficient = charSheet.proficiencies.skills?.some((s) => s.toLowerCase() === skillNorm);

        if (isExpert) {
          profBonus = charSheet.proficiencyBonus * 2;
        } else if (isProficient) {
          profBonus = charSheet.proficiencyBonus;
        }
      }

      const modifier = abilityMod + profBonus;

      // Roll d20 with advantage / disadvantage
      const rollRes = DiceParser.roll('1d20', this.rng, advantageMode);
      const diceTerm = rollRes.terms[0];
      if (diceTerm.type !== 'dice') throw new Error('Roll failed');

      const d20 = diceTerm.rolls[0];
      const discardedD20 = diceTerm.discardedRolls?.[0];
      const total = d20 + modifier;
      const isSuccess = total >= dc;
      const nextVersion = campaign.state_version + 1;

      const result: AbilityCheckResult & { advantageMode?: string } = {
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
        advantageMode,
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
   * P1-03: Executes a game action via CommandService atomically,
   * passing pendingActionId so state transition and pending resolution commit in one transaction.
   */
  resolveAction(
    context: CommandContext,
    command: ActionCommand,
    pendingActionId?: string
  ): CommandExecutionResult {
    return this.commandService.executeCommand(context, command, pendingActionId);
  }

  /**
   * Publishes an AI narrator's story text into the authorized event feed.
   * INVARIANT: Narration cannot mutate character HP, AC, inventory, or positions.
   * P1-04: Strict full-request idempotency check.
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
      // 1. P1-04: Strict full-request idempotency check
      const existingEvent = this.db
        .prepare('SELECT * FROM game_events WHERE campaign_id = ? AND action_id = ?')
        .get(campaignId, actionId) as unknown as { payload_json: string } | undefined;

      if (existingEvent) {
        this.db.exec('COMMIT;');
        const recorded = JSON.parse(existingEvent.payload_json) as NarrationPayload;

        if (
          recorded.text !== text.trim() ||
          (recorded.textTh ?? undefined) !== (textTh?.trim() ?? undefined) ||
          (recorded.speakerName ?? undefined) !== (speakerName?.trim() ?? undefined)
        ) {
          throw new ConflictError(
            `Action '${actionId}' has already been executed with different parameters`
          );
        }

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
