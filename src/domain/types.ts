export interface Campaign {
  id: string;
  stateVersion: number;
  createdAt: string;
}

export interface Character {
  id: string;
  campaignId: string;
  name: string;
  hp: number;
  maxHp: number;
  armorClass: number;
}

export interface AttackStats {
  attackBonus: number;
  damageDiceCount: number;
  damageDiceSides: number;
  damageBonus: number;
}

export interface AttackRollDetails {
  d20: number;
  attackBonus: number;
  attackTotal: number;
  targetAc: number;
  isHit: boolean;
  isCriticalHit: boolean;
  damageDiceRolls: number[];
  damageBonus: number;
  totalDamage: number;
}

export interface AttackResolutionResult {
  actionId: string;
  campaignId: string;
  stateVersion: number;
  attackerId: string;
  targetId: string;
  roll: {
    d20: number;
    bonus: number;
    total: number;
    targetAc: number;
    isHit: boolean;
    isCriticalHit: boolean;
  };
  damage: number;
  targetPreviousHp: number;
  targetHp: number;
  targetMaxHp: number;
  isDuplicate: boolean;
}

export interface GameEvent<TPayload = unknown> {
  id: string;
  campaignId: string;
  actionId: string;
  type: string;
  payload: TPayload;
  stateVersion: number;
  createdAt: string;
}

export interface SafeCharacterState {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  armorClass: number;
}

export interface SafeGameState {
  campaignId: string;
  stateVersion: number;
  characters: SafeCharacterState[];
}

export interface AttackIntent {
  campaignId: string;
  actionId: string;
  expectedVersion: number;
  attackerId: string;
  targetId: string;
}
