import type { GameEvent, SafeCharacterState, SafeGameState } from './types.js';

export interface PublicAudienceOptions {
  audience?: 'player' | 'dm';
}

/**
 * Projects a raw database game event for public/player consumption.
 * Enforces spoiler-safe boundaries: hidden entities (visibility='hidden') have their
 * identity, IDs, and stats redacted so secret ambushes and traps do not leak.
 */
export function projectEventForPublic(
  event: GameEvent,
  hiddenCharacterIds: Set<string>
): GameEvent {
  if (!event.payload || typeof event.payload !== 'object') {
    return event;
  }

  const payload = { ...(event.payload as Record<string, unknown>) };
  let modified = false;

  // Redact hidden attacker
  if (typeof payload.attackerId === 'string' && hiddenCharacterIds.has(payload.attackerId)) {
    payload.attackerId = 'unseen-attacker';
    if (payload.weapon && typeof payload.weapon === 'object') {
      const origWeapon = payload.weapon as Record<string, unknown>;
      payload.weapon = {
        name: 'Unseen Strike',
        nameTh: 'การโจมตีจากเงามืด',
        damageType: origWeapon.damageType ?? 'unknown',
      };
    }
    modified = true;
  }

  // Redact hidden target
  if (typeof payload.targetId === 'string' && hiddenCharacterIds.has(payload.targetId)) {
    payload.targetId = 'unseen-target';
    if (typeof payload.targetHp === 'number') {
      delete payload.targetHp;
      delete payload.targetPreviousHp;
      delete payload.targetMaxHp;
    }
    modified = true;
  }

  // Redact hidden character actor
  if (typeof payload.characterId === 'string' && hiddenCharacterIds.has(payload.characterId)) {
    payload.characterId = 'unseen-entity';
    modified = true;
  }

  return {
    ...event,
    payload: modified ? payload : event.payload,
  };
}

/**
 * Projects character list for safe public/player viewing.
 * Strictly excludes any character with visibility='hidden'.
 */
export function projectCharactersForPublic(
  characters: Array<{
    id: string;
    name: string;
    role?: 'player' | 'npc' | 'monster';
    visibility?: 'public' | 'hidden';
    hp: number;
    maxHp: number;
    armorClass: number;
  }>
): SafeCharacterState[] {
  return characters
    .filter((c) => c.visibility !== 'hidden')
    .map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      hp: c.hp,
      maxHp: c.maxHp,
      armorClass: c.armorClass,
    }));
}
