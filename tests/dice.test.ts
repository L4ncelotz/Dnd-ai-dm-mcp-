import { describe, it, expect } from 'vitest';
import { DiceParser } from '../src/domain/dice.js';
import { DeterministicRng, CryptoRng } from '../src/domain/rng.js';

describe('DiceParser and Evaluator', () => {
  it('parses and rolls single die with modifier (1d20+5)', () => {
    const rng = new DeterministicRng([14]);
    const result = DiceParser.roll('1d20+5', rng);

    expect(result.expression).toBe('1d20+5');
    expect(result.advantageMode).toBe('none');
    expect(result.total).toBe(19);
    expect(result.terms).toHaveLength(2);

    const diceTerm = result.terms[0];
    expect(diceTerm.type).toBe('dice');
    if (diceTerm.type === 'dice') {
      expect(diceTerm.count).toBe(1);
      expect(diceTerm.sides).toBe(20);
      expect(diceTerm.rolls).toEqual([14]);
      expect(diceTerm.total).toBe(14);
    }

    const constTerm = result.terms[1];
    expect(constTerm.type).toBe('constant');
    if (constTerm.type === 'constant') {
      expect(constTerm.value).toBe(5);
    }
  });

  it('supports bare die format (d20, d6)', () => {
    const rng = new DeterministicRng([18]);
    const result = DiceParser.roll('d20', rng);

    expect(result.total).toBe(18);
    expect(result.terms[0].type).toBe('dice');
  });

  it('handles negative modifiers (1d20-3)', () => {
    const rng = new DeterministicRng([10]);
    const result = DiceParser.roll('1d20-3', rng);

    expect(result.total).toBe(7);
  });

  it('handles multiple dice and compound terms (2d6 + 1d4 + 3)', () => {
    // 2d6 -> [4, 5], 1d4 -> [3], +3
    const rng = new DeterministicRng([4, 5, 3]);
    const result = DiceParser.roll('2d6 + 1d4 + 3', rng);

    expect(result.total).toBe(15);
    expect(result.terms).toHaveLength(3);
  });

  it('applies advantage mode by keeping highest of 2 rolls and recording discarded roll', () => {
    // Rolls 8 and 17 -> Advantage keeps 17, discards 8. + 4 = 21
    const rng = new DeterministicRng([8, 17]);
    const result = DiceParser.roll('1d20+4', rng, 'advantage');

    expect(result.advantageMode).toBe('advantage');
    expect(result.total).toBe(21);

    const diceTerm = result.terms[0];
    if (diceTerm.type === 'dice') {
      expect(diceTerm.rolls).toEqual([17]);
      expect(diceTerm.discardedRolls).toEqual([8]);
    }
  });

  it('applies disadvantage mode by keeping lowest of 2 rolls and recording discarded roll', () => {
    // Rolls 18 and 6 -> Disadvantage keeps 6, discards 18. + 4 = 10
    const rng = new DeterministicRng([18, 6]);
    const result = DiceParser.roll('1d20+4', rng, 'disadvantage');

    expect(result.advantageMode).toBe('disadvantage');
    expect(result.total).toBe(10);

    const diceTerm = result.terms[0];
    if (diceTerm.type === 'dice') {
      expect(diceTerm.rolls).toEqual([6]);
      expect(diceTerm.discardedRolls).toEqual([18]);
    }
  });

  it('rejects invalid or malformed expressions', () => {
    const rng = new DeterministicRng([10]);

    expect(() => DiceParser.roll('', rng)).toThrow(/cannot be empty/);
    expect(() => DiceParser.roll('   ', rng)).toThrow(/cannot be empty/);
    expect(() => DiceParser.roll('invalid', rng)).toThrow(/Invalid syntax/);
    expect(() => DiceParser.roll('1d20 + bad', rng)).toThrow(/Invalid syntax/);
    expect(() => DiceParser.roll('101d6', rng)).toThrow(/Dice count must be between 1 and 100/);
    expect(() => DiceParser.roll('1d1', rng)).toThrow(/Dice sides must be between 2 and 1000/);
  });

  it('works reliably with CryptoRng for multiple rolls', () => {
    const cryptoRng = new CryptoRng();
    for (let i = 0; i < 50; i++) {
      const res = DiceParser.roll('1d20+5', cryptoRng);
      expect(res.total).toBeGreaterThanOrEqual(6);
      expect(res.total).toBeLessThanOrEqual(25);
    }
  });
});
