import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STICKER_STORAGE_KEY,
  buildDeck,
  canFlipCard,
  cardsMatch,
  computeStars,
  getWinner,
  nextPlayer,
  readStickers,
  shuffle,
  unlockSticker,
  type StorageLike,
} from './gameLogic';
import { DIFFICULTIES, THEMES, getStickerAward, getTheme } from './themesData';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

class FakeStorage implements StorageLike {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

test('shuffle keeps every item and does not mutate the input', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const snapshot = [...input];
  const shuffled = shuffle(input, seededRandom(7));

  assert.deepEqual(input, snapshot);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), snapshot);
});

test('buildDeck creates exactly two of every pair for every theme and size', () => {
  for (const theme of THEMES) {
    for (const difficulty of DIFFICULTIES) {
      const deck = buildDeck(theme, difficulty, seededRandom(theme.id.length + difficulty.pairs));
      assert.equal(deck.length, difficulty.pairs * 2);

      const counts = new Map<string, number>();
      for (const card of deck) {
        counts.set(card.pairId, (counts.get(card.pairId) || 0) + 1);
        assert.ok(theme.symbols.some((symbol) => symbol.id === card.pairId));
      }
      assert.equal(counts.size, difficulty.pairs);
      for (const count of counts.values()) assert.equal(count, 2);

      const uids = new Set(deck.map((card) => card.uid));
      assert.equal(uids.size, deck.length);
    }
  }
});

test('buildDeck is deterministic for a seeded random source', () => {
  const theme = getTheme('animals');
  const difficulty = DIFFICULTIES[2];
  const first = buildDeck(theme, difficulty, seededRandom(42));
  const second = buildDeck(theme, difficulty, seededRandom(42));
  assert.deepEqual(first.map((card) => card.uid), second.map((card) => card.uid));
});

test('cardsMatch only matches two different cards with the same pair id', () => {
  const deck = buildDeck(getTheme('fruits'), DIFFICULTIES[0], seededRandom(3));
  const first = deck[0];
  const second = deck.find((card) => card.pairId === first.pairId && card.uid !== first.uid);
  const other = deck.find((card) => card.pairId !== first.pairId);
  if (!second || !other) throw new Error('deck is missing expected cards');

  assert.equal(cardsMatch(first, second), true);
  assert.equal(cardsMatch(first, first), false);
  assert.equal(cardsMatch(first, other), false);
});

test('canFlipCard blocks matched and already-flipped cards', () => {
  const deck = buildDeck(getTheme('shapes'), DIFFICULTIES[0], seededRandom(5));
  const card = deck[0];
  assert.equal(canFlipCard(card, new Set(), []), true);
  assert.equal(canFlipCard(card, new Set([card.uid]), []), false);
  assert.equal(canFlipCard(card, new Set(), [card.uid]), false);
});

test('nextPlayer alternates between Teddy and Bunny', () => {
  assert.equal(nextPlayer('teddy'), 'bunny');
  assert.equal(nextPlayer('bunny'), 'teddy');
});

test('computeStars rewards efficient play and always gives at least one star', () => {
  assert.equal(computeStars(2, 2), 3);
  assert.equal(computeStars(6, 6), 3);
  assert.equal(computeStars(11, 6), 3);
  assert.equal(computeStars(14, 6), 2);
  assert.equal(computeStars(30, 6), 1);
  assert.equal(computeStars(100, 8), 1);
});

test('getWinner reports a winner or a tie', () => {
  assert.equal(getWinner({ teddy: 4, bunny: 2 }), 'teddy');
  assert.equal(getWinner({ teddy: 1, bunny: 3 }), 'bunny');
  assert.equal(getWinner({ teddy: 3, bunny: 3 }), 'tie');
});

test('sticker unlocks persist, deduplicate, and survive corrupt storage', () => {
  const storage = new FakeStorage();
  const award = getStickerAward('india', 'champion');

  const first = unlockSticker(award, storage);
  assert.equal(first.isNew, true);
  assert.equal(first.stickers.length, 1);
  assert.equal(first.sticker.id, 'india:champion');
  assert.ok(first.sticker.earnedAt);

  const second = unlockSticker(award, storage);
  assert.equal(second.isNew, false);
  assert.equal(second.stickers.length, 1);

  const persisted = readStickers(storage);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].themeId, 'india');

  storage.setItem(STICKER_STORAGE_KEY, '{not-json');
  assert.deepEqual(readStickers(storage), []);
});

test('readStickers ignores malformed entries', () => {
  const storage = new FakeStorage();
  storage.setItem(
    STICKER_STORAGE_KEY,
    JSON.stringify([{ id: 'animals:toddler', themeId: 'animals' }, null, { nope: true }])
  );
  const stickers = readStickers(storage);
  assert.equal(stickers.length, 1);
  assert.equal(stickers[0].id, 'animals:toddler');
});

test('every theme has enough symbols for the 5x5 legend board', () => {
  for (const theme of THEMES) {
    assert.ok(theme.symbols.length >= 12, `${theme.id} needs at least 12 symbols`);
    const ids = new Set(theme.symbols.map((symbol) => symbol.id));
    assert.equal(ids.size, theme.symbols.length, `${theme.id} has duplicate symbol ids`);
  }
});

test('legend is a 5x5 board with 12 pairs and a lucky center cell', () => {
  const legend = DIFFICULTIES.find((difficulty) => difficulty.id === 'legend');
  if (!legend) throw new Error('legend difficulty is missing');
  assert.equal(legend.gridLabel, '5 × 5');
  assert.equal(legend.columns, 5);
  assert.equal(legend.pairs, 12);
  assert.equal(legend.centerStar, true);

  const deck = buildDeck(getTheme('animals'), legend, seededRandom(11));
  assert.equal(deck.length, 24);
  assert.equal(new Set(deck.map((card) => card.pairId)).size, 12);
});
