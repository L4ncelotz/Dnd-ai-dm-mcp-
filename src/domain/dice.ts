import type { Rng } from './rng.js';

export type AdvantageMode = 'none' | 'advantage' | 'disadvantage';

export interface DiceTermResult {
  type: 'dice';
  count: number;
  sides: number;
  rolls: number[];
  discardedRolls?: number[];
  total: number;
}

export interface ConstantTermResult {
  type: 'constant';
  value: number;
}

export type RollTermResult = DiceTermResult | ConstantTermResult;

export interface DiceRollResult {
  expression: string;
  advantageMode: AdvantageMode;
  terms: RollTermResult[];
  total: number;
}

interface ParsedDiceTerm {
  type: 'dice';
  sign: 1 | -1;
  count: number;
  sides: number;
}

interface ParsedConstantTerm {
  type: 'constant';
  sign: 1 | -1;
  value: number;
}

type ParsedTerm = ParsedDiceTerm | ParsedConstantTerm;

/**
 * Parses and evaluates standard D&D dice expressions (e.g., '1d20+5', '2d6+3', '1d8-1').
 * Supports advantage and disadvantage on d20 rolls.
 */
export class DiceParser {
  private static readonly TERM_REGEX = /([+-]?)\s*(?:(\d*)d(\d+)|(\d+))/gi;

  /**
   * Parses a dice notation string into structured terms.
   * Throws Error on invalid expressions.
   */
  static parse(expression: string): ParsedTerm[] {
    const cleaned = expression.trim();
    if (!cleaned) {
      throw new Error('Dice expression cannot be empty');
    }

    const terms: ParsedTerm[] = [];
    const regex = new RegExp(this.TERM_REGEX);
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    while ((match = regex.exec(cleaned)) !== null) {
      // Ensure no unexpected tokens exist between matches
      const matchedString = match[0];
      const matchStart = match.index;
      const skipped = cleaned.slice(lastIndex, matchStart).trim();
      if (skipped.length > 0) {
        throw new Error(`Invalid syntax in dice expression near '${skipped}'`);
      }
      lastIndex = regex.lastIndex;

      const signStr = match[1];
      const sign: 1 | -1 = signStr === '-' ? -1 : 1;
      const countStr = match[2];
      const sidesStr = match[3];
      const constantStr = match[4];

      if (sidesStr !== undefined) {
        // Dice term: [count]d[sides]
        const count = countStr ? parseInt(countStr, 10) : 1;
        const sides = parseInt(sidesStr, 10);

        if (count <= 0 || count > 100) {
          throw new Error(`Dice count must be between 1 and 100, got ${count}`);
        }
        if (sides <= 1 || sides > 1000) {
          throw new Error(`Dice sides must be between 2 and 1000, got ${sides}`);
        }

        terms.push({ type: 'dice', sign, count, sides });
      } else if (constantStr !== undefined) {
        // Constant modifier
        const value = parseInt(constantStr, 10);
        terms.push({ type: 'constant', sign, value });
      }
    }

    if (lastIndex < cleaned.length) {
      const leftover = cleaned.slice(lastIndex).trim();
      if (leftover.length > 0) {
        throw new Error(`Invalid syntax in dice expression near '${leftover}'`);
      }
    }

    if (terms.length === 0) {
      throw new Error(`Could not parse dice expression: '${expression}'`);
    }

    return terms;
  }

  /**
   * Evaluates a dice expression using the provided RNG and advantage mode.
   */
  static roll(
    expression: string,
    rng: Rng,
    advantageMode: AdvantageMode = 'none'
  ): DiceRollResult {
    const parsedTerms = this.parse(expression);
    const termResults: RollTermResult[] = [];
    let grandTotal = 0;

    for (let i = 0; i < parsedTerms.length; i++) {
      const term = parsedTerms[i];

      if (term.type === 'constant') {
        const signedValue = term.sign * term.value;
        grandTotal += signedValue;
        termResults.push({
          type: 'constant',
          value: signedValue,
        });
      } else {
        // Handle advantage / disadvantage for d20 (specifically when single d20 is rolled in the first term)
        if (term.sides === 20 && term.count === 1 && advantageMode !== 'none') {
          const roll1 = rng.rollDie(20);
          const roll2 = rng.rollDie(20);

          let kept: number;
          let discarded: number;

          if (advantageMode === 'advantage') {
            kept = Math.max(roll1, roll2);
            discarded = Math.min(roll1, roll2);
          } else {
            kept = Math.min(roll1, roll2);
            discarded = Math.max(roll1, roll2);
          }

          const signedTotal = term.sign * kept;
          grandTotal += signedTotal;

          termResults.push({
            type: 'dice',
            count: 1,
            sides: 20,
            rolls: [kept],
            discardedRolls: [discarded],
            total: signedTotal,
          });
        } else {
          // Standard dice rolls
          const rolls: number[] = [];
          let diceSum = 0;

          for (let c = 0; c < term.count; c++) {
            const roll = rng.rollDie(term.sides);
            rolls.push(roll);
            diceSum += roll;
          }

          const signedTotal = term.sign * diceSum;
          grandTotal += signedTotal;

          termResults.push({
            type: 'dice',
            count: term.count,
            sides: term.sides,
            rolls,
            total: signedTotal,
          });
        }
      }
    }

    return {
      expression,
      advantageMode,
      terms: termResults,
      total: grandTotal,
    };
  }
}
