import React from 'react';
import { useGame } from '../context/GameContext';
import { formatMoney } from '../lib/constants';

export const Header: React.FC = () => {
  const {
    game,
    appMode,
    setAppMode,
    soundEnabled,
    toggleSound,
    theme,
    toggleTheme,
    openModal,
  } = useGame();

  const isPlayerMode = appMode === 'player';
  const curr = game?.currency || '₹';
  const initBank = game?.initial_bank_balance || 1;
  const bankBal = game?.bank_balance ?? 0;
  const bankPercent = Math.min(100, Math.max(0, (bankBal / initBank) * 100));

  return (
    <header className="top-nav">
      <div className="nav-top-row">
        <div className="nav-brand">
          <div className="logo-icon" title="Banker Console" aria-label="Banker Console">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M3 21h18M3 10h18M5 10v11M9 10v11M15 10v11M19 10v11M12 2L2 7h20L12 2z" />
            </svg>
          </div>
        </div>

        {/* Workspace Navigation & Actions */}
        <div className="nav-actions">
          <button
            id="btn-backup"
            className="btn btn-ghost btn-sm"
            title="Backup or restore your games (stored in this browser)"
            onClick={() => openModal('backup')}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            <span className="btn-text">Backup</span>
          </button>

          <button
            id="btn-toggle-theme"
            className="btn btn-ghost btn-sm"
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? (
              <svg id="theme-icon-sun" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            ) : (
              <svg id="theme-icon-moon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>

          <button
            id="btn-toggle-sound"
            className="btn btn-ghost btn-sm"
            title="Toggle audio cues"
            aria-label="Toggle audio cues"
            onClick={toggleSound}
          >
            {soundEnabled ? (
              <svg id="sound-icon-on" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            ) : (
              <svg id="sound-icon-off" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            )}
          </button>

          {(!isPlayerMode || !game) && (
            <button
              id="btn-open-games-list"
              className="btn btn-secondary btn-sm"
              onClick={() => openModal('games-list')}
            >
              Games
            </button>
          )}

          {(!isPlayerMode || !game) && (
            <button
              id="btn-new-game-modal"
              className="btn btn-primary btn-sm"
              onClick={() => openModal('new-game')}
            >
              + New
            </button>
          )}

          {game && (
            <button
              id="btn-toggle-mode"
              className={`btn mode-toggle-btn ${isPlayerMode ? 'btn-secondary' : 'btn-emerald'}`}
              title="Switch between Banker and Player View"
              onClick={() => setAppMode(isPlayerMode ? 'banker' : 'player')}
            >
              {isPlayerMode ? (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              )}
              <span id="mode-text">{isPlayerMode ? 'Banker View' : 'Player View'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Active Game Context Strip */}
      {game && (
        <div className="game-header-controls" id="game-header-controls">
          <button
            type="button"
            className="header-metric-item"
            id="btn-switch-game"
            title="Click to switch or view games"
            onClick={() => openModal('games-list')}
          >
            <span className="metric-label">Session</span>
            <strong id="hdr-game-name">{game.name}</strong>
            <span className="metric-sep" aria-hidden="true">·</span>
            <span className={`status-text ${game.status}`} id="hdr-game-status">
              {game.status}
            </span>
          </button>

          <div className="header-divider" aria-hidden="true" />

          <button
            type="button"
            className="header-metric-item"
            id="btn-bank-info"
            title="View Banker Drawer details"
            onClick={() => openModal('bank-info')}
          >
            <span className="metric-label">Bank Reserve</span>
            <strong className="mono-num" id="hdr-bank-balance">{formatMoney(bankBal, curr)}</strong>
            <div className="mini-health-bar" aria-hidden="true">
              <div
                className="mini-health-fill"
                id="hdr-bank-float-bar"
                style={{ width: `${bankPercent}%` }}
              />
            </div>
          </button>

          <div className="header-divider" aria-hidden="true" />

          <div className="header-metric-item static-metric" id="hdr-round-container">
            <span className="metric-label">Round</span>
            <strong className="mono-num" id="hdr-round-no">{game.current_round}</strong>
          </div>
        </div>
      )}
    </header>
  );
};
