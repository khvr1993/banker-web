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
          <div className="logo-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 21h18M3 10h18M5 10v11M9 10v11M15 10v11M19 10v11M12 2L2 7h20L12 2z" />
            </svg>
          </div>
          <div>
            <h1 className="app-title">Banker Console</h1>
            <span className="app-subtitle" id="connection-status">Offline-ready</span>
          </div>
        </div>

        {/* Utilities (Backup, Sound, Games, New Game, Mode Toggle) */}
        <div className="nav-actions">
          <button
            id="btn-backup"
            className="btn btn-ghost btn-sm btn-icon-mobile"
            title="Backup or restore your games (stored in this browser)"
            onClick={() => openModal('backup')}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            <span className="btn-text">Backup</span>
          </button>

          <button
            id="btn-toggle-sound"
            className="btn btn-ghost btn-sm"
            title="Toggle audio cues"
            onClick={toggleSound}
          >
            {soundEnabled ? (
              <svg id="sound-icon-on" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            ) : (
              <svg id="sound-icon-off" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
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
              className={`btn btn-sm mode-toggle-btn ${isPlayerMode ? 'btn-secondary' : 'btn-emerald'}`}
              title="Switch between Banker and Player View"
              onClick={() => setAppMode(isPlayerMode ? 'banker' : 'player')}
            >
              <span id="mode-icon">{isPlayerMode ? '👑' : '👤'}</span>
              <span id="mode-text">{isPlayerMode ? 'Banker View' : 'Player View'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Active Game Controls */}
      {game && (
        <div className="game-header-controls" id="game-header-controls" style={{ display: 'flex' }}>
          <div
            className="header-pill game-info-pill"
            id="btn-switch-game"
            title="Click to switch or view games"
            onClick={() => openModal('games-list')}
          >
            <span className="pill-label">Game</span>
            <strong id="hdr-game-name">{game.name}</strong>
            <span className={`status-badge ${game.status}`} id="hdr-game-status">
              {game.status.toUpperCase()}
            </span>
          </div>

          <div
            className="header-pill bank-drawer-pill"
            id="btn-bank-info"
            title="View Banker Drawer details"
            onClick={() => openModal('bank-info')}
          >
            <span className="pill-label">Bank Drawer</span>
            <strong id="hdr-bank-balance">{formatMoney(bankBal, curr)}</strong>
            <div className="mini-health-bar">
              <div
                className="mini-health-fill"
                id="hdr-bank-float-bar"
                style={{ width: `${bankPercent}%` }}
              />
            </div>
          </div>

          <div className="header-pill round-pill" id="hdr-round-container">
            <span className="pill-label">Round</span>
            <strong id="hdr-round-no">{game.current_round}</strong>
          </div>
        </div>
      )}
    </header>
  );
};
