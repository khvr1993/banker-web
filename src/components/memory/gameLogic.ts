import type {
  Difficulty,
  DifficultyId,
  MemoryCard,
  MemoryTheme,
  PlayerId,
  Scores,
  StickerAward,
  StickerRecord,
  ThemeId,
  Winner,
} from './types';

export type RandomFn = () => number;

export function shuffle<T>(items: readonly T[], random: RandomFn = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function pickSymbols(theme: MemoryTheme, pairs: number, random: RandomFn = Math.random) {
  return shuffle(theme.symbols, random).slice(0, pairs);
}

export function buildDeck(
  theme: MemoryTheme,
  difficulty: Difficulty,
  random: RandomFn = Math.random
): MemoryCard[] {
  const deck: MemoryCard[] = [];
  for (const symbol of pickSymbols(theme, difficulty.pairs, random)) {
    deck.push({ uid: `${symbol.id}-a`, pairId: symbol.id, symbol });
    deck.push({ uid: `${symbol.id}-b`, pairId: symbol.id, symbol });
  }
  return shuffle(deck, random);
}

export function cardsMatch(first: MemoryCard, second: MemoryCard): boolean {
  return first.uid !== second.uid && first.pairId === second.pairId;
}

export function canFlipCard(card: MemoryCard, matched: Set<string>, flipped: string[]): boolean {
  return !matched.has(card.uid) && !flipped.includes(card.uid);
}

export function nextPlayer(current: PlayerId): PlayerId {
  return current === 'teddy' ? 'bunny' : 'teddy';
}

export function computeStars(moves: number, pairs: number): number {
  if (moves <= pairs + Math.ceil(pairs * 0.75)) return 3;
  if (moves <= Math.ceil(pairs * 2.5)) return 2;
  return 1;
}

export function getWinner(scores: Scores): Winner {
  if (scores.teddy === scores.bunny) return 'tie';
  return scores.teddy > scores.bunny ? 'teddy' : 'bunny';
}

export const STICKER_STORAGE_KEY = 'memory_match_stickers_v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: StorageLike): StorageLike | undefined {
  if (storage) return storage;
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

export function readStickers(storage?: StorageLike): StickerRecord[] {
  const target = resolveStorage(storage);
  if (!target) return [];
  try {
    const raw = target.getItem(STICKER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StickerRecord =>
      Boolean(item) && typeof item.id === 'string' && typeof item.themeId === 'string'
    );
  } catch {
    return [];
  }
}

export function unlockSticker(
  award: StickerAward,
  storage?: StorageLike
): { stickers: StickerRecord[]; sticker: StickerRecord; isNew: boolean } {
  const stickers = readStickers(storage);
  const existing = stickers.find((sticker) => sticker.id === award.id);
  if (existing) {
    return { stickers, sticker: existing, isNew: false };
  }

  const sticker: StickerRecord = { ...award, earnedAt: new Date().toISOString() };
  const next = [...stickers, sticker];
  const target = resolveStorage(storage);
  if (target) {
    try {
      target.setItem(STICKER_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // A full or private-mode storage should never block the celebration.
    }
  }
  return { stickers: next, sticker, isNew: true };
}

export function getStickerKey(themeId: ThemeId, difficultyId: DifficultyId): string {
  return `${themeId}:${difficultyId}`;
}
