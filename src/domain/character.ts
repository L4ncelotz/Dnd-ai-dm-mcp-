export interface AbilityScores {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

export function calculateAbilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export interface WeaponAttack {
  id: string;
  name: string;
  nameTh: string;
  attackBonus: number;
  damageFormula: string;
  damageType: string;
  range?: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  nameTh: string;
  quantity: number;
  equipped?: boolean;
  description?: string;
}

export interface Position2D {
  x: number;
  y: number;
}

export interface CharacterProficiencies {
  skills: string[];
  expertise: string[];
  savingThrows: string[];
}

export interface CharacterSheet {
  id: string;
  campaignId: string;
  name: string;
  nameTh: string;
  className: string;
  classNameTh: string;
  role: 'player' | 'npc' | 'monster';
  visibility: 'public' | 'hidden';
  level: number;
  hp: number;
  maxHp: number;
  armorClass: number;
  speed: number;
  proficiencyBonus: number;
  abilities: AbilityScores;
  proficiencies: CharacterProficiencies;
  attacks: WeaponAttack[];
  inventory: InventoryItem[];
  position: Position2D;
}

/**
 * Three canonical premade level-1 characters for the 3 human players.
 * Based on SRD 5.2.1 rules subset.
 */
export const PREMADE_CHARACTERS: ReadonlyArray<Omit<CharacterSheet, 'campaignId'>> = [
  {
    id: 'char-fighter-1',
    name: 'Kaelen Stormborn',
    nameTh: 'คาเลน สตอร์มบอร์น',
    className: 'Fighter',
    classNameTh: 'นักรบ',
    role: 'player',
    visibility: 'public',
    level: 1,
    hp: 12,
    maxHp: 12,
    armorClass: 18, // Chain Mail (16) + Shield (+2)
    speed: 30,
    proficiencyBonus: 2,
    abilities: { str: 16, dex: 12, con: 15, int: 10, wis: 13, cha: 8 },
    proficiencies: {
      skills: ['Athletics', 'Perception'],
      expertise: [],
      savingThrows: ['str', 'con'],
    },
    attacks: [
      {
        id: 'longsword',
        name: 'Longsword',
        nameTh: 'ดาบยาว',
        attackBonus: 5, // +3 STR, +2 Prof
        damageFormula: '1d8+3',
        damageType: 'slashing',
      },
      {
        id: 'light-crossbow',
        name: 'Light Crossbow',
        nameTh: 'หน้าไม้เบา',
        attackBonus: 3, // +1 DEX, +2 Prof
        damageFormula: '1d8+1',
        damageType: 'piercing',
        range: '80/320',
      },
    ],
    inventory: [
      { id: 'item-chain-mail', name: 'Chain Mail', nameTh: 'เกราะโซ่ถัก', quantity: 1, equipped: true },
      { id: 'item-shield', name: 'Shield', nameTh: 'โล่', quantity: 1, equipped: true },
      { id: 'item-longsword', name: 'Longsword', nameTh: 'ดาบยาว', quantity: 1, equipped: true },
      { id: 'item-crossbow', name: 'Light Crossbow', nameTh: 'หน้าไม้เบา', quantity: 1 },
      { id: 'item-bolts', name: 'Crossbow Bolts', nameTh: 'ลูกดอกหน้าไม้', quantity: 20 },
      { id: 'item-potion-healing', name: 'Potion of Healing', nameTh: 'น้ำยาฟื้นพลังชีวิต', quantity: 1 },
    ],
    position: { x: 2, y: 5 },
  },
  {
    id: 'char-cleric-1',
    name: 'Lyra Dawnseeker',
    nameTh: 'ไลรา ดอว์นซีคเกอร์',
    className: 'Cleric',
    classNameTh: 'นักบวช',
    role: 'player',
    visibility: 'public',
    level: 1,
    hp: 10,
    maxHp: 10,
    armorClass: 18, // Scale Mail (14) + DEX (+2) + Shield (+2)
    speed: 30,
    proficiencyBonus: 2,
    abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 16, cha: 12 },
    proficiencies: {
      skills: ['Insight', 'Religion'],
      expertise: [],
      savingThrows: ['wis', 'cha'],
    },
    attacks: [
      {
        id: 'mace',
        name: 'Mace',
        nameTh: 'กระบองเหล็ก',
        attackBonus: 4, // +2 STR, +2 Prof
        damageFormula: '1d6+2',
        damageType: 'bludgeoning',
      },
    ],
    inventory: [
      { id: 'item-scale-mail', name: 'Scale Mail', nameTh: 'เกราะเกล็ด', quantity: 1, equipped: true },
      { id: 'item-cleric-shield', name: 'Shield', nameTh: 'โล่', quantity: 1, equipped: true },
      { id: 'item-mace', name: 'Mace', nameTh: 'กระบองเหล็ก', quantity: 1, equipped: true },
      { id: 'item-holy-symbol', name: 'Holy Symbol', nameTh: 'สัญลักษณ์ศักดิ์สิทธิ์', quantity: 1, equipped: true },
      { id: 'item-cleric-potion', name: 'Potion of Healing', nameTh: 'น้ำยาฟื้นพลังชีวิต', quantity: 1 },
    ],
    position: { x: 3, y: 5 },
  },
  {
    id: 'char-rogue-1',
    name: 'Vael Whisperwind',
    nameTh: 'วาเอล วิสเปอร์วินด์',
    className: 'Rogue',
    classNameTh: 'จอมโจร',
    role: 'player',
    visibility: 'public',
    level: 1,
    hp: 9,
    maxHp: 9,
    armorClass: 14, // Leather (11) + DEX (+3)
    speed: 30,
    proficiencyBonus: 2,
    abilities: { str: 10, dex: 16, con: 12, int: 13, wis: 12, cha: 14 },
    proficiencies: {
      skills: ['Stealth', 'Sleight of Hand', 'Acrobatics'],
      expertise: ['Stealth'],
      savingThrows: ['dex', 'int'],
    },
    attacks: [
      {
        id: 'shortsword',
        name: 'Shortsword',
        nameTh: 'ดาบสั้น',
        attackBonus: 5, // +3 DEX, +2 Prof
        damageFormula: '1d6+3',
        damageType: 'piercing',
      },
      {
        id: 'shortbow',
        name: 'Shortbow',
        nameTh: 'ธนูสั้น',
        attackBonus: 5, // +3 DEX, +2 Prof
        damageFormula: '1d6+3',
        damageType: 'piercing',
        range: '80/320',
      },
    ],
    inventory: [
      { id: 'item-leather-armor', name: 'Leather Armor', nameTh: 'เกราะหนัง', quantity: 1, equipped: true },
      { id: 'item-shortsword', name: 'Shortsword', nameTh: 'ดาบสั้น', quantity: 2, equipped: true },
      { id: 'item-shortbow', name: 'Shortbow', nameTh: 'ธนูสั้น', quantity: 1 },
      { id: 'item-arrows', name: 'Arrows', nameTh: 'ลูกธนู', quantity: 20 },
      { id: 'item-thieves-tools', name: 'Thieves Tools', nameTh: 'ชุดเครื่องมือสะเดาะกลอน', quantity: 1 },
    ],
    position: { x: 4, y: 5 },
  },
];
