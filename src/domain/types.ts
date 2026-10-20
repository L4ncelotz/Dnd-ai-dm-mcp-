export interface Campaign {
  id: string;
  stateVersion: number;
  createdAt: string;
}

export interface Character {
  id: string;
  campaignId: string;
  name: string;
  role?: 'player' | 'npc' | 'monster';
  visibility?: 'public' | 'hidden';
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
  role?: 'player' | 'npc' | 'monster';
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

export interface PendingAction {
  id: string;
  campaignId: string;
  characterId: string;
  intentText: string;
  status: 'pending' | 'resolved' | 'cancelled';
  actionType?: string;
  createdAt: string;
}

export interface AbilityCheckIntent {
  characterId: string;
  ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  dc: number;
  skill?: string;
  reason: string;
  advantageMode?: 'none' | 'advantage' | 'disadvantage';
}

export interface AbilityCheckResult {
  actionId: string;
  campaignId: string;
  stateVersion: number;
  characterId: string;
  ability: string;
  skill?: string;
  dc: number;
  d20: number;
  discardedD20?: number;
  modifier: number;
  total: number;
  isSuccess: boolean;
  reason: string;
  isDuplicate: boolean;
}

export interface GameContext {
  campaignId: string;
  stateVersion: number;
  scene: {
    location: string;
    locationTh: string;
    description: string;
    descriptionTh: string;
    revealedClues: string[];
  };
  party: SafeCharacterState[];
  visibleEnemies: SafeCharacterState[];
  recentNarrations: Array<{
    id: string;
    speakerName?: string;
    text: string;
    createdAt: string;
  }>;
  pendingActionCount: number;
}

export interface ResolutionProposal {
  actionId: string;
  campaignId: string;
  pendingActionId?: string;
  proposedResolutionType: 'ATTACK' | 'ABILITY_CHECK' | 'HEAL' | 'APPLY_DAMAGE' | 'MOVE' | 'REST' | 'NARRATIVE';
  proposedRuleCitation?: string;
  dc?: number;
  parameters: Record<string, unknown>;
  explanation: string;
}

export interface NarrationPayload {
  actionId: string;
  campaignId: string;
  stateVersion: number;
  text: string;
  textTh?: string;
  speakerName?: string;
  isDuplicate: boolean;
}
