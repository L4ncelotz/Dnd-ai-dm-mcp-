import type { AttackRollDetails, AttackStats, Character } from './types.js';
import type { Rng } from './rng.js';

export const FIXTURE_ATTACK_STATS: Record<string, AttackStats> = {
  'hero-1': {
    attackBonus: 5,
    damageDiceCount: 1,
    damageDiceSides: 8,
    damageBonus: 3,
  },
  'goblin-1': {
    attackBonus: 4,
    damageDiceCount: 1,
    damageDiceSides: 6,
    damageBonus: 2,
  },
};

export const ALLOWED_FIXTURE_IDS: Record<string, true> = {
  'hero-1': true,
  'goblin-1': true,
};

export interface PureAttackResult {
  rollDetails: AttackRollDetails;
  previousHp: number;
  newHp: number;
}

/**
 * Pure deterministic attack resolution against a target character.
 * Contains no I/O, persistence, or network dependencies.
 */
export function resolveAttack(
  attackerId: string,
  target: Character,
  rng: Rng
): PureAttackResult {
  const stats = FIXTURE_ATTACK_STATS[attackerId];
  if (!stats) {
    throw new Error(`Attacker '${attackerId}' is not permitted for the Phase 00 fixture`);
  }
  if (!ALLOWED_FIXTURE_IDS[target.id]) {
    throw new Error(`Target '${target.id}' is not permitted for the Phase 00 fixture`);
  }

  const d20 = rng.rollDie(20);
  const isCriticalHit = d20 === 20;
  const isCriticalMiss = d20 === 1;
  const attackTotal = d20 + stats.attackBonus;
  const isHit = !isCriticalMiss && (isCriticalHit || attackTotal >= target.armorClass);

  let damageDiceRolls: number[] = [];
  let totalDamage = 0;

  if (isHit) {
    const diceCount = isCriticalHit ? stats.damageDiceCount * 2 : stats.damageDiceCount;
    for (let i = 0; i < diceCount; i++) {
      damageDiceRolls.push(rng.rollDie(stats.damageDiceSides));
    }
    const diceSum = damageDiceRolls.reduce((sum, r) => sum + r, 0);
    totalDamage = Math.max(1, diceSum + stats.damageBonus);
  }

  const previousHp = target.hp;
  const newHp = Math.max(0, target.hp - totalDamage);

  return {
    rollDetails: {
      d20,
      attackBonus: stats.attackBonus,
      attackTotal,
      targetAc: target.armorClass,
      isHit,
      isCriticalHit,
      damageDiceRolls,
      damageBonus: stats.damageBonus,
      totalDamage,
    },
    previousHp,
    newHp,
  };
}
