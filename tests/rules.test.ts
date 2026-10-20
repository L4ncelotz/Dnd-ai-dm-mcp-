import { describe, it, expect } from 'vitest';
import { resolveAttack } from '../src/domain/rules.js';
import { DeterministicRng } from '../src/domain/rng.js';
import type { Character } from '../src/domain/types.js';

describe('Attack Rules (Domain)', () => {
  const hero: Character = {
    id: 'hero-1',
    campaignId: 'poc-campaign',
    name: 'Hero',
    hp: 20,
    maxHp: 20,
    armorClass: 14,
  };

  const goblin: Character = {
    id: 'goblin-1',
    campaignId: 'poc-campaign',
    name: 'Goblin',
    hp: 7,
    maxHp: 7,
    armorClass: 12,
  };

  it('resolves a hit when roll + attackBonus >= target AC', () => {
    // Goblin attacks Hero: AC 14, Goblin attackBonus +4.
    // d20 roll: 10 -> Total 14 >= 14 (Hit).
    // Damage d6 roll: 4 -> 4 + 2 = 6 damage.
    const rng = new DeterministicRng([10, 4]);
    const result = resolveAttack('goblin-1', hero, rng);

    expect(result.rollDetails.isHit).toBe(true);
    expect(result.rollDetails.isCriticalHit).toBe(false);
    expect(result.rollDetails.d20).toBe(10);
    expect(result.rollDetails.attackTotal).toBe(14);
    expect(result.rollDetails.totalDamage).toBe(6);
    expect(result.previousHp).toBe(20);
    expect(result.newHp).toBe(14);
  });

  it('resolves a miss when roll + attackBonus < target AC', () => {
    // Goblin attacks Hero: AC 14.
    // d20 roll: 9 -> Total 13 < 14 (Miss). No damage die rolled.
    const rng = new DeterministicRng([9]);
    const result = resolveAttack('goblin-1', hero, rng);

    expect(result.rollDetails.isHit).toBe(false);
    expect(result.rollDetails.d20).toBe(9);
    expect(result.rollDetails.totalDamage).toBe(0);
    expect(result.previousHp).toBe(20);
    expect(result.newHp).toBe(20);
  });

  it('resolves a critical hit on natural 20 and doubles damage dice', () => {
    // Goblin attacks Hero: AC 14.
    // d20 roll: 20 (Critical hit).
    // Double dice: 2d6 rolled -> 5 and 6 -> 11 + 2 = 13 damage.
    const rng = new DeterministicRng([20, 5, 6]);
    const result = resolveAttack('goblin-1', hero, rng);

    expect(result.rollDetails.isHit).toBe(true);
    expect(result.rollDetails.isCriticalHit).toBe(true);
    expect(result.rollDetails.damageDiceRolls).toEqual([5, 6]);
    expect(result.rollDetails.totalDamage).toBe(13);
    expect(result.newHp).toBe(7);
  });

  it('clamps HP to 0 when damage exceeds current HP', () => {
    // Hero attacks Goblin (7 HP).
    // Hero attackBonus +5, damage 1d8 + 3.
    // d20 roll: 15 -> Total 20 >= 12 (Hit).
    // Damage d8 roll: 8 -> 8 + 3 = 11 damage.
    // 7 - 11 = -4 -> Clamped to 0.
    const rng = new DeterministicRng([15, 8]);
    const result = resolveAttack('hero-1', goblin, rng);

    expect(result.rollDetails.isHit).toBe(true);
    expect(result.rollDetails.totalDamage).toBe(11);
    expect(result.previousHp).toBe(7);
    expect(result.newHp).toBe(0);
  });

  it('rejects unpermitted fixture characters', () => {
    const rng = new DeterministicRng([10]);
    expect(() =>
      resolveAttack('dragon-1', hero, rng)
    ).toThrow(/Attacker 'dragon-1' is not permitted/);

    const fakeTarget: Character = {
      id: 'fake-target',
      campaignId: 'poc-campaign',
      name: 'Fake',
      hp: 10,
      maxHp: 10,
      armorClass: 10,
    };
    expect(() =>
      resolveAttack('hero-1', fakeTarget, rng)
    ).toThrow(/Target 'fake-target' is not permitted/);
  });
});
