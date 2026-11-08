import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGame } from '../../context/GameContext';
import { MemoryCardTile } from './MemoryCard';
import { StickerAlbumModal } from './StickerAlbumModal';
import {
  DIFFICULTIES,
  PLAYERS,
  THEMES,
  TOTAL_STICKERS,
  getDifficulty,
  getStickerAward,
  getTheme,
} from './themesData';
import {
  buildDeck,
  cardsMatch,
  computeStars,
  getWinner,
  readStickers,
  unlockSticker,
} from './gameLogic';
import { memorySounds } from './soundEffects';
import type {
  DifficultyId,
  GameMode,
  MemoryCard,
  PlayerId,
  Scores,
  StickerRecord,
  ThemeId,
  VictorySummary,
} from './types';

const CONFETTI_COLORS = ['#F97316', '#F43F5E', '#8B5CF6', '#06B6D4', '#22C55E', '#FACC15', '#EC4899'];

const DEFAULT_THEME: ThemeId = 'animals';
const DEFAULT_DIFFICULTY: DifficultyId = 'explorer';

export const MemoryMatchGame: React.FC = () => {
  const { soundEnabled } = useGame();

  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_THEME);
  const [difficultyId, setDifficultyId] = useState<DifficultyId>(DEFAULT_DIFFICULTY);
  const [mode, setMode] = useState<GameMode>('solo');
  const [cards, setCards] = useState<MemoryCard[]>(() =>
    buildDeck(getTheme(DEFAULT_THEME), getDifficulty(DEFAULT_DIFFICULTY))
  );
  const [flipped, setFlipped] = useState<string[]>([]);
  const [matched, setMatched] = useState<Set<string>>(() => new Set());
  const [moves, setMoves] = useState(0);
  const [scores, setScores] = useState<Scores>({ teddy: 0, bunny: 0 });
  const [turn, setTurn] = useState<PlayerId>('teddy');
  const [phase, setPhase] = useState<'playing' | 'won'>('playing');
  const [locked, setLocked] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [peeksLeft, setPeeksLeft] = useState(2);
  const [wobble, setWobble] = useState<string[]>([]);
  const [victory, setVictory] = useState<VictorySummary | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [albumOpen, setAlbumOpen] = useState(false);
  const [stickers, setStickers] = useState<StickerRecord[]>(() => readStickers());

  const flippedRef = useRef<string[]>([]);
  const matchedRef = useRef<Set<string>>(new Set());
  const movesRef = useRef(0);
  const scoresRef = useRef<Scores>({ teddy: 0, bunny: 0 });
  const turnRef = useRef<PlayerId>('teddy');
  const lockedRef = useRef(false);
  const peekingRef = useRef(false);
  const phaseRef = useRef<'playing' | 'won'>('playing');
  const settingsRef = useRef<{ themeId: ThemeId; difficultyId: DifficultyId; mode: GameMode }>({
    themeId: DEFAULT_THEME,
    difficultyId: DEFAULT_DIFFICULTY,
    mode: 'solo',
  });
  const timersRef = useRef<number[]>([]);

  const theme = getTheme(themeId);
  const difficulty = getDifficulty(difficultyId);
  const isDuo = mode === 'duo';
  const pairsFound = matched.size / 2;
  const collectedCount = stickers.filter((sticker) =>
    THEMES.some((item) => item.id === sticker.themeId)
  ).length;

  const later = useCallback((fn: () => void, delay: number) => {
    const id = window.setTimeout(fn, delay);
    timersRef.current.push(id);
    return id;
  }, []);

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current = [];
  }, []);

  useEffect(() => {
    memorySounds.enabled = soundEnabled;
  }, [soundEnabled]);

  useEffect(
    () => () => {
      clearTimers();
    },
    [clearTimers]
  );

  const setFlippedBoth = (next: string[]) => {
    flippedRef.current = next;
    setFlipped(next);
  };

  const setMatchedBoth = (next: Set<string>) => {
    matchedRef.current = next;
    setMatched(next);
  };

  const finishGame = (finalMoves: number, finalScores: Scores) => {
    phaseRef.current = 'won';
    setPhase('won');
    memorySounds.victory();

    const settings = settingsRef.current;
    const finalDifficulty = getDifficulty(settings.difficultyId);
    const stars = computeStars(finalMoves, finalDifficulty.pairs);
    const winner = settings.mode === 'duo' ? getWinner(finalScores) : null;
    const award = getStickerAward(settings.themeId, settings.difficultyId);
    const result = unlockSticker(award);
    setStickers(result.stickers);
    setVictory({
      stars,
      moves: finalMoves,
      winner,
      scores: finalScores,
      sticker: result.sticker,
      isNew: result.isNew,
    });
    setShowConfetti(true);
  };

  const startGame = (next?: { themeId?: ThemeId; difficultyId?: DifficultyId; mode?: GameMode }) => {
    clearTimers();
    const nextTheme = next?.themeId ?? settingsRef.current.themeId;
    const nextDifficulty = next?.difficultyId ?? settingsRef.current.difficultyId;
    const nextMode = next?.mode ?? settingsRef.current.mode;
    settingsRef.current = { themeId: nextTheme, difficultyId: nextDifficulty, mode: nextMode };

    setThemeId(nextTheme);
    setDifficultyId(nextDifficulty);
    setMode(nextMode);
    setCards(buildDeck(getTheme(nextTheme), getDifficulty(nextDifficulty)));
    setFlippedBoth([]);
    setMatchedBoth(new Set());
    movesRef.current = 0;
    setMoves(0);
    scoresRef.current = { teddy: 0, bunny: 0 };
    setScores({ teddy: 0, bunny: 0 });
    turnRef.current = 'teddy';
    setTurn('teddy');
    lockedRef.current = false;
    setLocked(false);
    peekingRef.current = false;
    setPeeking(false);
    setPeeksLeft(2);
    setWobble([]);
    phaseRef.current = 'playing';
    setPhase('playing');
    setVictory(null);
    setShowConfetti(false);
  };

  const handleFlip = (uid: string) => {
    if (phaseRef.current !== 'playing' || lockedRef.current || peekingRef.current) return;
    const card = cards.find((item) => item.uid === uid);
    if (!card) return;
    if (matchedRef.current.has(uid) || flippedRef.current.includes(uid)) return;

    const currentFlipped = flippedRef.current;
    memorySounds.flip();

    if (currentFlipped.length === 0) {
      setFlippedBoth([uid]);
      return;
    }

    if (currentFlipped.length !== 1) return;
    const first = cards.find((item) => item.uid === currentFlipped[0]);
    if (!first) {
      setFlippedBoth([uid]);
      return;
    }

    setFlippedBoth([first.uid, uid]);
    lockedRef.current = true;
    setLocked(true);

    const nextMoves = movesRef.current + 1;
    movesRef.current = nextMoves;
    setMoves(nextMoves);

    if (cardsMatch(first, card)) {
      later(() => {
        const nextMatched = new Set(matchedRef.current);
        nextMatched.add(first.uid);
        nextMatched.add(uid);
        setMatchedBoth(nextMatched);
        setFlippedBoth([]);
        const isFinalPair = nextMatched.size >= cards.length;
        lockedRef.current = isFinalPair;
        setLocked(isFinalPair);
        memorySounds.match();

        let resolvedScores = scoresRef.current;
        if (settingsRef.current.mode === 'duo') {
          resolvedScores = {
            ...resolvedScores,
            [turnRef.current]: resolvedScores[turnRef.current] + 1,
          };
          scoresRef.current = resolvedScores;
          setScores(resolvedScores);
        }

        if (isFinalPair) {
          later(() => finishGame(nextMoves, resolvedScores), 700);
        }
      }, 480);
      return;
    }

    later(() => {
      memorySounds.mismatch();
      setWobble([first.uid, uid]);
    }, 380);

    later(() => {
      setFlippedBoth([]);
      setWobble([]);
      lockedRef.current = false;
      setLocked(false);
      if (settingsRef.current.mode === 'duo') {
        const next = turnRef.current === 'teddy' ? 'bunny' : 'teddy';
        turnRef.current = next;
        setTurn(next);
      }
    }, 1050);
  };

  const handlePeek = () => {
    if (phaseRef.current !== 'playing' || peekingRef.current || lockedRef.current || peeksLeft <= 0) return;
    peekingRef.current = true;
    setPeeking(true);
    setPeeksLeft((previous) => previous - 1);
    memorySounds.peek();
    later(() => {
      peekingRef.current = false;
      setPeeking(false);
    }, 2000);
  };

  const closeAlbum = useCallback(() => setAlbumOpen(false), []);

  const confetti = useMemo(() => {
    if (!showConfetti) return [];
    return Array.from({ length: 46 }, (_, index) => ({
      id: index,
      left: Math.random() * 100,
      delay: Math.random() * 0.9,
      duration: 2.1 + Math.random() * 1.5,
      size: 7 + Math.random() * 8,
      color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
      tilt: Math.random() * 360,
    }));
  }, [showConfetti, victory]);

  return (
    <div className={`memory-game theme-${themeId}`}>
      <section className="mm-hero">
        <div className="mm-hero-mascots" aria-hidden="true">
          <span>🐻</span>
          <span>🪄</span>
          <span>🐰</span>
        </div>
        <div className="mm-hero-copy">
          <span className="mm-kicker">Kids Corner · Ages 4+</span>
          <h1>
            Memory Match <span className="mm-hero-spark" aria-hidden="true">✨</span>
          </h1>
          <p>{theme.tagline}</p>
        </div>
        <div className="mm-hero-actions">
          <button type="button" className="mm-btn mm-btn-sticker" onClick={() => setAlbumOpen(true)}>
            <span aria-hidden="true">📖</span> Sticker Book
            <span className="mm-count-badge">
              {collectedCount}/{TOTAL_STICKERS}
            </span>
          </button>
          <button type="button" className="mm-btn mm-btn-ghost" onClick={() => startGame()}>
            <span aria-hidden="true">🔄</span> New Game
          </button>
        </div>
      </section>

      <section className="mm-controls">
        <div className="mm-control-block">
          <span className="mm-section-label">1 · Pick a theme</span>
          <div className="mm-theme-ribbon" role="group" aria-label="Choose a theme">
            {THEMES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`mm-theme-pill ${themeId === item.id ? 'is-active' : ''}`}
                onClick={() => startGame({ themeId: item.id })}
                aria-pressed={themeId === item.id}
              >
                <span className="mm-theme-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.shortName}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="mm-controls-row">
          <div className="mm-control-block">
            <span className="mm-section-label">2 · Choose a size</span>
            <div className="mm-pill-row" role="group" aria-label="Choose difficulty">
              {DIFFICULTIES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`mm-pill ${difficultyId === item.id ? 'is-active' : ''}`}
                  onClick={() => startGame({ difficultyId: item.id })}
                  aria-pressed={difficultyId === item.id}
                >
                  <span aria-hidden="true">{item.icon}</span>
                  <span>{item.name}</span>
                  <span className="mm-pill-grid">{item.gridLabel}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mm-control-block">
            <span className="mm-section-label">3 · Who is playing?</span>
            <div className="mm-mode-switch" role="group" aria-label="Choose players">
              <button
                type="button"
                className={mode === 'solo' ? 'is-active' : ''}
                onClick={() => startGame({ mode: 'solo' })}
                aria-pressed={mode === 'solo'}
              >
                <span aria-hidden="true">🧒</span> Solo
              </button>
              <button
                type="button"
                className={mode === 'duo' ? 'is-active' : ''}
                onClick={() => startGame({ mode: 'duo' })}
                aria-pressed={mode === 'duo'}
              >
                <span aria-hidden="true">🐻🐰</span> Two players
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="mm-scoreboard" aria-label="Game status">
        <div className="mm-score-main">
          {isDuo ? (
            <div className="mm-players">
              {(['teddy', 'bunny'] as PlayerId[]).map((playerId) => (
                <div
                  key={playerId}
                  className={`mm-player-chip ${
                    turn === playerId && phase === 'playing' ? 'is-turn' : ''
                  }`}
                  style={{ '--player-color': PLAYERS[playerId].color } as React.CSSProperties}
                >
                  <span className="mm-player-emoji" aria-hidden="true">
                    {PLAYERS[playerId].emoji}
                  </span>
                  <span className="mm-player-info">
                    <strong>{PLAYERS[playerId].name}</strong>
                    <span>{scores[playerId]} pairs</span>
                  </span>
                  {turn === playerId && phase === 'playing' && (
                    <span className="mm-turn-tag">Your turn</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="mm-stat-bubbles">
              <div className="mm-stat-bubble">
                <span>Moves</span>
                <strong>{moves}</strong>
              </div>
              <div className="mm-stat-bubble">
                <span>Pairs</span>
                <strong>
                  {pairsFound} / {difficulty.pairs}
                </strong>
              </div>
            </div>
          )}
        </div>

        <div className="mm-score-actions">
          {isDuo && (
            <span className="mm-duo-pairs">
              {pairsFound} / {difficulty.pairs} pairs
            </span>
          )}
          <button
            type="button"
            className={`mm-wand ${peeking ? 'is-active' : ''}`}
            onClick={handlePeek}
            disabled={peeksLeft <= 0 || locked || peeking || phase !== 'playing'}
            aria-label={`Magic peek helper, ${peeksLeft} peeks left`}
            title="Show every card for a moment"
          >
            <span className="mm-wand-icon" aria-hidden="true">🪄</span>
            <span className="mm-wand-label">Peek</span>
            <span className="mm-wand-count">{peeksLeft}</span>
          </button>
        </div>
      </section>

      <section className={`mm-board-wrap ${peeking ? 'is-peeking' : ''}`}>
        {peeking && (
          <div className="mm-peek-banner" aria-hidden="true">
            ✨ Magic peek! ✨
          </div>
        )}
        <div
          className={`mm-board ${difficulty.columns >= 5 ? 'is-dense' : ''}`}
          style={{ '--mm-cols': difficulty.columns } as React.CSSProperties}
        >
          {cards.map((card, index) => (
            <React.Fragment key={card.uid}>
              {difficulty.centerStar && index === cards.length / 2 && (
                <div className="mm-lucky-cell" aria-hidden="true">
                  <span className="mm-lucky-star">⭐</span>
                  <span className="mm-lucky-label">Lucky Star</span>
                </div>
              )}
              <MemoryCardTile
                card={card}
                faceUp={peeking || flipped.includes(card.uid) || matched.has(card.uid)}
                matched={matched.has(card.uid)}
                wobbly={wobble.includes(card.uid)}
                disabled={locked || phase !== 'playing'}
                peeking={peeking}
                backIcon={theme.backIcon}
                onFlip={handleFlip}
              />
            </React.Fragment>
          ))}
        </div>
      </section>

      {victory && (
        <div className="mm-modal-backdrop mm-victory-backdrop" role="presentation">
          {showConfetti && (
            <div className="mm-confetti" aria-hidden="true">
              {confetti.map((piece) => (
                <span
                  key={piece.id}
                  className="mm-confetti-piece"
                  style={{
                    left: `${piece.left}%`,
                    width: `${piece.size}px`,
                    height: `${piece.size * 1.6}px`,
                    backgroundColor: piece.color,
                    animationDelay: `${piece.delay}s`,
                    animationDuration: `${piece.duration}s`,
                    transform: `rotate(${piece.tilt}deg)`,
                  }}
                />
              ))}
            </div>
          )}
          <div
            className="mm-modal mm-victory"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mm-victory-title"
          >
            <div className="mm-stars" aria-label={`${victory.stars} of 3 stars`}>
              {[1, 2, 3].map((star) => (
                <span key={star} className={star <= victory.stars ? 'is-on' : ''} aria-hidden="true">
                  ⭐
                </span>
              ))}
            </div>

            <h2 id="mm-victory-title">
              {victory.winner === 'tie'
                ? "It's a tie!"
                : victory.winner
                  ? `${PLAYERS[victory.winner].emoji} ${PLAYERS[victory.winner].name} wins!`
                  : 'You did it!'}
            </h2>
            <p className="mm-victory-line">
              {isDuo
                ? 'High fives, Teddy and Bunny! You cleared the whole board!'
                : `You found all ${difficulty.pairs} pairs. You are a memory superstar!`}
            </p>

            <div className="mm-victory-sticker">
              <span className="mm-victory-sticker-emoji" aria-hidden="true">
                {victory.sticker.emoji}
              </span>
              <div className="mm-victory-sticker-copy">
                <strong>{victory.sticker.name}</strong>
                <span>{victory.isNew ? 'New sticker unlocked!' : 'Sticker already in your book'}</span>
              </div>
              {victory.isNew && <span className="mm-new-badge">NEW</span>}
            </div>

            <div className="mm-victory-stats">
              <div>
                <span>Moves</span>
                <strong>{victory.moves}</strong>
              </div>
              <div>
                <span>Pairs</span>
                <strong>{difficulty.pairs}</strong>
              </div>
              {isDuo && (
                <div>
                  <span>Score</span>
                  <strong>
                    {victory.scores.teddy} – {victory.scores.bunny}
                  </strong>
                </div>
              )}
            </div>

            <div className="mm-modal-footer mm-victory-actions">
              <button type="button" className="mm-btn mm-btn-ghost" onClick={() => setAlbumOpen(true)}>
                <span aria-hidden="true">📖</span> Sticker Book
              </button>
              <button type="button" className="mm-btn mm-btn-primary" onClick={() => startGame()}>
                Play again <span aria-hidden="true">🎉</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {albumOpen && <StickerAlbumModal stickers={stickers} onClose={closeAlbum} />}
    </div>
  );
};
