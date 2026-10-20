import { randomInt } from 'node:crypto';

export interface Rng {
  /**
   * Roll a die with the specified number of sides.
   * Returns an integer between 1 and sides inclusive.
   */
  rollDie(sides: number): number;
}

/**
 * Production-grade cryptographically secure RNG using Node.js crypto.randomInt.
 */
export class CryptoRng implements Rng {
  rollDie(sides: number): number {
    if (sides <= 0 || !Number.isInteger(sides)) {
      throw new Error(`Invalid sides for die: ${sides}`);
    }
    return randomInt(1, sides + 1);
  }
}

/**
 * Deterministic RNG for reproducible automated tests.
 */
export class DeterministicRng implements Rng {
  private readonly rolls: number[];
  private currentIndex: number = 0;

  constructor(rolls: number[]) {
    if (rolls.length === 0) {
      throw new Error('DeterministicRng requires at least one roll value');
    }
    this.rolls = [...rolls];
  }

  rollDie(sides: number): number {
    if (this.currentIndex >= this.rolls.length) {
      throw new Error(
        `DeterministicRng exhausted: requested roll ${this.currentIndex + 1} but only ${this.rolls.length} rolls provided`
      );
    }
    const val = this.rolls[this.currentIndex++];
    if (val < 1 || val > sides || !Number.isInteger(val)) {
      throw new Error(
        `Deterministic roll ${val} is out of bounds for d${sides} at index ${this.currentIndex - 1}`
      );
    }
    return val;
  }

  get remainingRolls(): number {
    return this.rolls.length - this.currentIndex;
  }
}
