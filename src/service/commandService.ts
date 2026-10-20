import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type Rng, CryptoRng } from '../domain/rng.js';
import { DiceParser, type AdvantageMode, type DiceRollResult } from '../domain/dice.js';
import type { CharacterSheet, WeaponAttack, Position2D } from '../domain/character.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  VersionConflictError,
} from './gameService.js';

export interface CommandContext {
  campaignId: string;
  actionId: string;
  expectedVersion: number;
}

export type ActionCommand =
  | {
      type: 'ATTACK';
      attackerId: string;
      targetId: string;
      weaponId?: string;
      advantageMode?: AdvantageMode;
    }
  | {
      type: 'HEAL';
      targetId: string;
      amountFormula: string;
      source: string;
    }
  | {
      type: 'APPLY_DAMAGE';
      targetId: string;
      amountFormula: string;
      damageType: string;
      source: string;
    }
  | {
      type: 'MOVE';
      characterId: string;
      toX: number;
      toY: number;
    }
  | {
      type: 'REST';
      characterId: string;
      restType: 'short' | 'long';
    };

export interface AttackCommandResult {
  actionId: string;
  campaignId: string;
  stateVersion: number;
  attackerId: string;
  targetId: string;
  weapon: {
    id: string;
    name: string;
    nameTh: string;
    attackBonus: number;
    damageFormula: string;
  };
  attackRoll: {
    d20: number;
    discardedD20?: number;
    attackBonus: number;
    total: number;
    targetAc: number;
    isHit: boolean;
    isCriticalHit: boolean;
    isCriticalMiss: boolean;
  };
  damageRoll?: DiceRollResult;
  totalDamage: number;
  targetPreviousHp: number;
  targetHp: number;
  targetMaxHp: number;
  isDuplicate: boolean;
}

export interface HealCommandResult {
  actionId: string;
  campaignId: string;
  stateVersion: number;
  targetId: string;
  healRoll: DiceRollResult;
  amountHealed: number;
  targetPreviousHp: number;
  targetHp: number;
  targetMaxHp: number;
  source: string;
  isDuplicate: boolean;
}

export interface DamageCommandResult {
  actionId: string;
  campaignId: string;
  stateVersion: number;
  targetId: string;
  damageRoll: DiceRollResult;
  totalDamage: number;
  damageType: string;
  source: string;
  targetPreviousHp: number;
  targetHp: number;
  targetMaxHp: number;
  isDuplicate: boolean;
}

export interface MoveCommandResult {
  actionId: string;
  campaignId: string;
  stateVersion: number;
  characterId: string;
  previousPosition: Position2D;
  newPosition: Position2D;
  isDuplicate: boolean;
}

export interface RestCommandResult {
  actionId: string;
  campaignId: string;
  stateVersion: number;
  characterId: string;
  restType: 'short' | 'long';
  targetPreviousHp: number;
  targetHp: number;
  targetMaxHp: number;
  isDuplicate: boolean;
}

export type CommandExecutionResult =
  | AttackCommandResult
  | HealCommandResult
  | DamageCommandResult
  | MoveCommandResult
  | RestCommandResult;

interface DbCharacterRow {
  id: string;
  campaign_id: string;
  name: string;
  name_th: string | null;
  class_name: string | null;
  class_name_th: string | null;
  role: string | null;
  visibility: string | null;
  level: number;
  hp: number;
  max_hp: number;
  armor_class: number;
  speed: number;
  proficiency_bonus: number | null;
  abilities_json: string | null;
  proficiencies_json: string | null;
  attacks_json: string | null;
  inventory_json: string | null;
  pos_x: number;
  pos_y: number;
}
interface DbCampaignRow {
  id: string;
  state_version: number;
  created_at: string;
}

interface DbGameEventRow {
  id: string;
  campaign_id: string;
  action_id: string;
  type: string;
  payload_json: string;
  state_version: number;
  created_at: string;
}

export class CommandService {
  private readonly db: DatabaseSync;
  private readonly rng: Rng;

  constructor(db: DatabaseSync, rng: Rng = new CryptoRng()) {
    this.db = db;
    this.rng = rng;
  }

  /**
   * Reads a complete character sheet from the database.
   */
  getCharacterSheet(campaignId: string, characterId: string): CharacterSheet {
    const row = this.db
      .prepare('SELECT * FROM characters WHERE campaign_id = ? AND id = ?')
      .get(campaignId, characterId) as unknown as DbCharacterRow | undefined;

    if (!row) {
      throw new NotFoundError(`Character '${characterId}' not found in campaign '${campaignId}'`);
    }

    return this.mapCharacterRow(row);
  }

  /**
   * Executes a validated game command transactionally with state version checking,
   * idempotency key enforcement, and durable event append.
   */
  executeCommand(context: CommandContext, command: ActionCommand, pendingActionId?: string): CommandExecutionResult {
    const { campaignId, actionId, expectedVersion } = context;

    if (!campaignId) throw new ValidationError('campaignId is required');
    if (!actionId) throw new ValidationError('actionId is required');
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new ValidationError('expectedVersion must be a non-negative integer');
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      // 1. Idempotency check: see if actionId has already been committed
      const existingEvent = this.db
        .prepare('SELECT * FROM game_events WHERE campaign_id = ? AND action_id = ?')
        .get(campaignId, actionId) as unknown as DbGameEventRow | undefined;

      if (existingEvent) {
        this.db.exec('COMMIT;');
        const recordedResult = JSON.parse(existingEvent.payload_json) as CommandExecutionResult;

        // P1-04: Strict full-request idempotency validation
        if (existingEvent.type !== command.type || !this.isMatchingCommand(command, recordedResult)) {
          throw new ConflictError(
            `Action '${actionId}' has already been executed with different parameters`
          );
        }
        return {
          ...recordedResult,
          isDuplicate: true,
        };
      }

      // 2. Verify campaign exists and state version matches
      const campaign = this.db
        .prepare('SELECT * FROM campaigns WHERE id = ?')
        .get(campaignId) as unknown as DbCampaignRow | undefined;

      if (!campaign) {
        throw new NotFoundError(`Campaign '${campaignId}' not found`);
      }

      if (campaign.state_version !== expectedVersion) {
        throw new VersionConflictError(
          `Stale state version: expected ${expectedVersion}, but campaign is at version ${campaign.state_version}`
        );
      }
      // P1-03: Validate and consume pending action atomically in the same transaction
      if (pendingActionId) {
        const actorId = 'attackerId' in command ? command.attackerId : 'characterId' in command ? command.characterId : undefined;
        this.validateAndConsumePendingAction(campaignId, pendingActionId, actorId);
      }

      // 3. Dispatch and execute specific command logic
      let result: CommandExecutionResult;
      const nextVersion = campaign.state_version + 1;

      switch (command.type) {
        case 'ATTACK':
          result = this.handleAttack(context, command, nextVersion);
          break;
        case 'HEAL':
          result = this.handleHeal(context, command, nextVersion);
          break;
        case 'APPLY_DAMAGE':
          result = this.handleDamage(context, command, nextVersion);
          break;
        case 'MOVE':
          result = this.handleMove(context, command, nextVersion);
          break;
        case 'REST':
          result = this.handleRest(context, command, nextVersion);
          break;
        default:
          throw new ValidationError(`Unsupported command type: ${(command as { type: string }).type}`);
      }

      // 4. Update campaign state version
      this.db
        .prepare('UPDATE campaigns SET state_version = ? WHERE id = ?')
        .run(nextVersion, campaignId);

      // 5. Insert immutable audit event
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
          command.type,
          JSON.stringify(result),
          nextVersion,
          new Date().toISOString()
        );

      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Rollback error ignored
      }
      throw err;
    }
  }

  private handleAttack(
    ctx: CommandContext,
    cmd: Extract<ActionCommand, { type: 'ATTACK' }>,
    nextVersion: number
  ): AttackCommandResult {
    const { campaignId, actionId } = ctx;
    const { attackerId, targetId, weaponId, advantageMode = 'none' } = cmd;

    if (attackerId === targetId) {
      throw new ValidationError('Attacker and target cannot be the same character');
    }

    const attacker = this.getCharacterSheet(campaignId, attackerId);
    const target = this.getCharacterSheet(campaignId, targetId);

    // Find selected weapon or fallback to first available attack
    let weapon: WeaponAttack | undefined;
    if (weaponId) {
      weapon = attacker.attacks.find((a) => a.id === weaponId);
      if (!weapon) {
        throw new ValidationError(`Weapon '${weaponId}' not found on character '${attackerId}'`);
      }
    } else {
      weapon = attacker.attacks[0];
      if (!weapon) {
        // Unarmed strike default: attackBonus = STR mod + prof (+2), damage 1 + STR mod
        const strMod = Math.floor((attacker.abilities.str - 10) / 2);
        weapon = {
          id: 'unarmed-strike',
          name: 'Unarmed Strike',
          nameTh: 'การโจมตีมือเปล่า',
          attackBonus: strMod + 2,
          damageFormula: `1+${Math.max(0, strMod)}`,
          damageType: 'bludgeoning',
        };
      }
    }

    // Roll d20 with advantage / disadvantage
    const attackRollResult = DiceParser.roll('1d20', this.rng, advantageMode);
    const diceTerm = attackRollResult.terms[0];
    if (diceTerm.type !== 'dice' || diceTerm.rolls.length === 0) {
      throw new Error('Failed to roll d20 for attack');
    }

    const d20 = diceTerm.rolls[0];
    const discardedD20 = diceTerm.discardedRolls?.[0];
    const isCriticalHit = d20 === 20;
    const isCriticalMiss = d20 === 1;
    const totalAttack = d20 + weapon.attackBonus;
    const isHit = !isCriticalMiss && (isCriticalHit || totalAttack >= target.armorClass);

    let damageRoll: DiceRollResult | undefined;
    let totalDamage = 0;

    if (isHit) {
      let formulaToRoll = weapon.damageFormula;
      if (isCriticalHit) {
        // Critical hit doubles dice count (e.g. 1d8+3 -> 2d8+3, 2d6+2 -> 4d6+2)
        // P2-02: Critical hit doubles all dice terms (global regex /g)
        formulaToRoll = formulaToRoll.replace(/(\d*)d(\d+)/gi, (_, countStr, sides) => {
          const count = countStr ? parseInt(countStr, 10) : 1;
          return `${count * 2}d${sides}`;
        });
      }

      damageRoll = DiceParser.roll(formulaToRoll, this.rng);
      // P2-03: Minimum attack damage uses non-negative floor of 0
      totalDamage = Math.max(0, damageRoll.total);
    }

    const previousHp = target.hp;
    const newHp = Math.max(0, target.hp - totalDamage);

    // Persist new HP
    this.db
      .prepare('UPDATE characters SET hp = ? WHERE campaign_id = ? AND id = ?')
      .run(newHp, campaignId, targetId);

    return {
      actionId,
      campaignId,
      stateVersion: nextVersion,
      attackerId,
      targetId,
      weapon: {
        id: weapon.id,
        name: weapon.name,
        nameTh: weapon.nameTh,
        attackBonus: weapon.attackBonus,
        damageFormula: weapon.damageFormula,
      },
      attackRoll: {
        d20,
        discardedD20,
        attackBonus: weapon.attackBonus,
        total: totalAttack,
        targetAc: target.armorClass,
        isHit,
        isCriticalHit,
        isCriticalMiss,
      },
      damageRoll,
      totalDamage,
      targetPreviousHp: previousHp,
      targetHp: newHp,
      targetMaxHp: target.maxHp,
      isDuplicate: false,
    };
  }

  private handleHeal(
    ctx: CommandContext,
    cmd: Extract<ActionCommand, { type: 'HEAL' }>,
    nextVersion: number
  ): HealCommandResult {
    const { campaignId, actionId } = ctx;
    const { targetId, amountFormula, source } = cmd;

    const target = this.getCharacterSheet(campaignId, targetId);
    const healRoll = DiceParser.roll(amountFormula, this.rng);
    const amountHealed = Math.max(1, healRoll.total);

    const previousHp = target.hp;
    const newHp = Math.min(target.maxHp, target.hp + amountHealed);

    this.db
      .prepare('UPDATE characters SET hp = ? WHERE campaign_id = ? AND id = ?')
      .run(newHp, campaignId, targetId);

    return {
      actionId,
      campaignId,
      stateVersion: nextVersion,
      targetId,
      healRoll,
      amountHealed,
      targetPreviousHp: previousHp,
      targetHp: newHp,
      targetMaxHp: target.maxHp,
      source,
      isDuplicate: false,
    };
  }

  private handleDamage(
    ctx: CommandContext,
    cmd: Extract<ActionCommand, { type: 'APPLY_DAMAGE' }>,
    nextVersion: number
  ): DamageCommandResult {
    const { campaignId, actionId } = ctx;
    const { targetId, amountFormula, damageType, source } = cmd;

    const target = this.getCharacterSheet(campaignId, targetId);
    const damageRoll = DiceParser.roll(amountFormula, this.rng);
    const totalDamage = Math.max(1, damageRoll.total);

    const previousHp = target.hp;
    const newHp = Math.max(0, target.hp - totalDamage);

    this.db
      .prepare('UPDATE characters SET hp = ? WHERE campaign_id = ? AND id = ?')
      .run(newHp, campaignId, targetId);

    return {
      actionId,
      campaignId,
      stateVersion: nextVersion,
      targetId,
      damageRoll,
      totalDamage,
      damageType,
      source,
      targetPreviousHp: previousHp,
      targetHp: newHp,
      targetMaxHp: target.maxHp,
      isDuplicate: false,
    };
  }

  private handleMove(
    ctx: CommandContext,
    cmd: Extract<ActionCommand, { type: 'MOVE' }>,
    nextVersion: number
  ): MoveCommandResult {
    const { campaignId, actionId } = ctx;
    const { characterId, toX, toY } = cmd;

    if (!Number.isInteger(toX) || !Number.isInteger(toY)) {
      throw new ValidationError('Grid coordinates must be integers');
    }
    const char = this.getCharacterSheet(campaignId, characterId);
    const previousPosition = { ...char.position };
    const newPosition = { x: toX, y: toY };

    // P1-06: Constrain movement speed
    const distance = Math.hypot(toX - char.position.x, toY - char.position.y) * 5;
    if (distance > char.speed) {
      throw new ValidationError(`Movement distance of ${Math.round(distance)}ft exceeds speed of ${char.speed}ft`);
    }

    this.db
      .prepare('UPDATE characters SET pos_x = ?, pos_y = ? WHERE campaign_id = ? AND id = ?')
      .run(toX, toY, campaignId, characterId);

    return {
      actionId,
      campaignId,
      stateVersion: nextVersion,
      characterId,
      previousPosition,
      newPosition,
      isDuplicate: false,
    };
  }

  private handleRest(
    ctx: CommandContext,
    cmd: Extract<ActionCommand, { type: 'REST' }>,
    nextVersion: number
  ): RestCommandResult {
    const { campaignId, actionId } = ctx;
    const { characterId, restType } = cmd;

    const char = this.getCharacterSheet(campaignId, characterId);
    const previousHp = char.hp;
    let newHp = char.hp;

    if (restType === 'long') {
      newHp = char.maxHp;
    }

    this.db
      .prepare('UPDATE characters SET hp = ? WHERE campaign_id = ? AND id = ?')
      .run(newHp, campaignId, characterId);

    return {
      actionId,
      campaignId,
      stateVersion: nextVersion,
      characterId,
      restType,
      targetPreviousHp: previousHp,
      targetHp: newHp,
      targetMaxHp: char.maxHp,
      isDuplicate: false,
    };
  }
  /**
   * Replays all recorded events for a campaign to verify state consistency.
   * Returns the final replayed state version and character summary.
   */
  replayEvents(campaignId: string): { replayedVersion: number; characterHp: Record<string, number> } {
    const events = this.db
      .prepare('SELECT * FROM game_events WHERE campaign_id = ? ORDER BY state_version ASC')
      .all(campaignId) as unknown as DbGameEventRow[];

    const characterHp: Record<string, number> = {};
    let lastVersion = 0;

    for (const evt of events) {
      lastVersion = evt.state_version;
      const payload = JSON.parse(evt.payload_json);
      if (evt.type === 'ATTACK' || evt.type === 'HEAL' || evt.type === 'APPLY_DAMAGE' || evt.type === 'REST') {
        const targetId = payload.targetId ?? payload.characterId;
        if (targetId && typeof payload.targetHp === 'number') {
          characterHp[targetId] = payload.targetHp;
        }
      }
    }

    return {
      replayedVersion: lastVersion,
      characterHp,
    };
  }

  private mapCharacterRow(row: DbCharacterRow): CharacterSheet {
    const abilities = row.abilities_json
      ? JSON.parse(row.abilities_json)
      : { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

    const proficiencies = row.proficiencies_json
      ? JSON.parse(row.proficiencies_json)
      : { skills: [], expertise: [], savingThrows: [] };

    const attacks = row.attacks_json ? JSON.parse(row.attacks_json) : [];
    const inventory = row.inventory_json ? JSON.parse(row.inventory_json) : [];

    return {
      id: row.id,
      campaignId: row.campaign_id,
      name: row.name,
      nameTh: row.name_th ?? row.name,
      className: row.class_name ?? 'Fighter',
      classNameTh: row.class_name_th ?? 'นักรบ',
      role: (row.role as 'player' | 'npc' | 'monster') ?? 'player',
      visibility: (row.visibility as 'public' | 'hidden') ?? 'public',
      level: row.level,
      hp: row.hp,
      maxHp: row.max_hp,
      armorClass: row.armor_class,
      speed: row.speed,
      proficiencyBonus: row.proficiency_bonus ?? 2,
      abilities,
      proficiencies,
      attacks,
      inventory,
      position: { x: row.pos_x, y: row.pos_y },
    };
  }

  private validateAndConsumePendingAction(campaignId: string, pendingActionId: string, actorId?: string): void {
    const pendingRow = this.db
      .prepare('SELECT id, character_id, status FROM pending_actions WHERE campaign_id = ? AND id = ?')
      .get(campaignId, pendingActionId) as { id: string; character_id: string; status: string } | undefined;

    if (!pendingRow) {
      throw new NotFoundError(`Pending action '${pendingActionId}' not found in campaign '${campaignId}'`);
    }
    if (pendingRow.status !== 'pending') {
      throw new ConflictError(`Pending action '${pendingActionId}' is already '${pendingRow.status}'`);
    }
    if (actorId && pendingRow.character_id !== actorId) {
      throw new ValidationError(`Pending action was created by '${pendingRow.character_id}', not '${actorId}'`);
    }

    this.db
      .prepare("UPDATE pending_actions SET status = 'resolved' WHERE campaign_id = ? AND id = ? AND status = 'pending'")
      .run(campaignId, pendingActionId);
  }

  private isMatchingCommand(cmd: ActionCommand, result: unknown): boolean {
    if (!result || typeof result !== 'object') return false;
    const res = result as Record<string, unknown>;

    switch (cmd.type) {
      case 'ATTACK': {
        const weapon = res.weapon as { id: string } | undefined;
        const weaponMatches = !cmd.weaponId || weapon?.id === cmd.weaponId;
        return res.attackerId === cmd.attackerId && res.targetId === cmd.targetId && weaponMatches;
      }
      case 'HEAL': {
        const healRoll = res.healRoll as { expression: string } | undefined;
        return res.targetId === cmd.targetId && healRoll?.expression === cmd.amountFormula && res.source === cmd.source;
      }
      case 'APPLY_DAMAGE': {
        const dmgRoll = res.damageRoll as { expression: string } | undefined;
        return res.targetId === cmd.targetId && dmgRoll?.expression === cmd.amountFormula && res.damageType === cmd.damageType && res.source === cmd.source;
      }
      case 'MOVE': {
        const newPos = res.newPosition as Position2D | undefined;
        return res.characterId === cmd.characterId && newPos?.x === cmd.toX && newPos?.y === cmd.toY;
      }
      case 'REST':
        return res.characterId === cmd.characterId && res.restType === cmd.restType;
      default:
        return false;
    }
  }
}
