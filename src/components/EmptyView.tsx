import React from 'react';
import { useGame } from '../context/GameContext';

export const EmptyView: React.FC = () => {
  const { openModal } = useGame();

  return (
    <section id="view-empty" className="view-panel">
      <div className="empty-hero">
        <div className="hero-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M7 15h0M2 9.5h20" />
          </svg>
        </div>
        <h2>No Active Game Session</h2>
        <p>
          Initialize a double-entry board game ledger to manage bank float reserves, player wallets, and real-time transfers.
        </p>
        <div className="hero-actions">
          <button className="btn btn-primary btn-lg" id="btn-empty-new-game" onClick={() => openModal('new-game')}>
            Create New Game
          </button>
          <button className="btn btn-secondary btn-lg" id="btn-empty-select-game" onClick={() => openModal('games-list')}>
            Open Existing Session
          </button>
        </div>
      </div>
    </section>
  );
};
