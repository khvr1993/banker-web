export type ThemeId = 'animals' | 'fruits' | 'india' | 'shapes' | 'vehicles';

export type DifficultyId = 'toddler' | 'easy' | 'explorer' | 'champion';

export type GameMode = 'solo' | 'duo';

export type PlayerId = 'teddy' | 'bunny';

export interface MemorySymbol {
  id: string;
  name: string;
  speech: string;
  emoji: string;
  accent: string;
  hint?: string;
}

export interface MemoryTheme {
  id: ThemeId;
  name: string;
  shortName: string;
  tagline: string;
  icon: string;
  backIcon: string;
  symbols: MemorySymbol[];
}

export interface Difficulty {
  id: DifficultyId;
  name: string;
  gridLabel: string;
  pairs: number;
  columns: number;
  icon: string;
  medalEmoji: string;
  medalName: string;
}

export interface PlayerProfile {
  name: string;
  emoji: string;
  color: string;
}

export interface MemoryCard {
  uid: string;
  pairId: string;
  symbol: MemorySymbol;
}

export interface StickerRecord {
  id: string;
  themeId: ThemeId;
  difficultyId: DifficultyId;
  name: string;
  emoji: string;
  earnedAt: string;
}

export type StickerAward = Omit<StickerRecord, 'earnedAt'>;

export interface Scores {
  teddy: number;
  bunny: number;
}

export type Winner = PlayerId | 'tie' | null;

export interface VictorySummary {
  stars: number;
  moves: number;
  winner: Winner;
  scores: Scores;
  sticker: StickerRecord;
  isNew: boolean;
}
