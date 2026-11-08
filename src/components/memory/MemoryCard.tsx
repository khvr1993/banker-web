import React from 'react';
import type { MemoryCard } from './types';

interface MemoryCardTileProps {
  card: MemoryCard;
  faceUp: boolean;
  matched: boolean;
  wobbly: boolean;
  disabled: boolean;
  peeking: boolean;
  backIcon: string;
  onFlip: (uid: string) => void;
}

export const MemoryCardTile: React.FC<MemoryCardTileProps> = ({
  card,
  faceUp,
  matched,
  wobbly,
  disabled,
  peeking,
  backIcon,
  onFlip,
}) => {
  const { symbol } = card;
  const label = faceUp
    ? `${symbol.name}${symbol.hint ? `, ${symbol.hint}` : ''}${matched ? ', matched' : ''}`
    : 'Hidden card, press to flip';

  return (
    <button
      type="button"
      className={[
        'mm-card',
        faceUp ? 'is-up' : '',
        matched ? 'is-matched' : '',
        wobbly ? 'is-wobbly' : '',
        peeking ? 'is-peeking' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--card-accent': symbol.accent } as React.CSSProperties}
      onClick={() => onFlip(card.uid)}
      disabled={disabled || matched}
      aria-label={label}
      aria-pressed={faceUp}
      aria-hidden={peeking && !faceUp ? true : undefined}
    >
      <span className="mm-card-inner">
        <span className="mm-face mm-face-back" aria-hidden="true">
          <span className="mm-back-medallion">
            <span className="mm-back-icon">{backIcon}</span>
          </span>
          <span className="mm-back-sparkle mm-back-sparkle-a">✦</span>
          <span className="mm-back-sparkle mm-back-sparkle-b">✦</span>
        </span>
        <span className="mm-face mm-face-front">
          <span className="mm-card-emoji" aria-hidden="true">
            {symbol.emoji}
          </span>
          <span className="mm-card-name">{symbol.name}</span>
          {symbol.hint && <span className="mm-card-hint">{symbol.hint}</span>}
          {matched && (
            <span className="mm-matched-badge" aria-hidden="true">
              ✓
            </span>
          )}
        </span>
      </span>
    </button>
  );
};
