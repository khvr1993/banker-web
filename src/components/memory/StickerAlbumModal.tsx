import React, { useEffect, useMemo } from 'react';
import type { StickerRecord } from './types';
import { DIFFICULTIES, THEMES, TOTAL_STICKERS } from './themesData';
import { getStickerKey } from './gameLogic';

interface StickerAlbumModalProps {
  stickers: StickerRecord[];
  onClose: () => void;
}

export const StickerAlbumModal: React.FC<StickerAlbumModalProps> = ({ stickers, onClose }) => {
  const earnedById = useMemo(() => {
    const map = new Map<string, StickerRecord>();
    for (const sticker of stickers) map.set(sticker.id, sticker);
    return map;
  }, [stickers]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const earnedCount = stickers.filter((sticker) =>
    THEMES.some((theme) => theme.id === sticker.themeId)
  ).length;
  const percent = Math.round((Math.min(earnedCount, TOTAL_STICKERS) / TOTAL_STICKERS) * 100);

  return (
    <div className="mm-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="mm-modal mm-album"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mm-album-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mm-modal-head">
          <div>
            <h2 id="mm-album-title">📖 My Sticker Book</h2>
            <p className="mm-modal-sub">
              {earnedCount} of {TOTAL_STICKERS} shiny stickers collected
            </p>
          </div>
          <button type="button" className="mm-close-btn" onClick={onClose} aria-label="Close sticker book">
            ✕
          </button>
        </div>

        <div className="mm-progress" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </div>

        <div className="mm-album-body">
          {THEMES.map((theme) => (
            <section key={theme.id} className="mm-album-theme">
              <h3>
                <span aria-hidden="true">{theme.icon}</span> {theme.name}
              </h3>
              <div className="mm-album-grid">
                {DIFFICULTIES.map((difficulty) => {
                  const key = getStickerKey(theme.id, difficulty.id);
                  const earned = earnedById.get(key);
                  return (
                    <div
                      key={key}
                      className={`mm-sticker ${earned ? 'is-earned' : 'is-locked'}`}
                      aria-label={
                        earned
                          ? `${earned.name} sticker earned`
                          : `${difficulty.medalName} sticker for ${theme.name}, locked`
                      }
                    >
                      <span className="mm-sticker-emoji" aria-hidden="true">
                        {earned ? earned.emoji : '🔒'}
                      </span>
                      <span className="mm-sticker-name">{difficulty.medalName}</span>
                      <span className="mm-sticker-sub">{earned ? 'Collected!' : difficulty.gridLabel}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="mm-modal-footer">
          <button type="button" className="mm-btn mm-btn-primary" onClick={onClose}>
            Back to the game
          </button>
        </div>
      </div>
    </div>
  );
};
