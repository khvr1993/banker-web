import React from 'react';
import { useGame } from '../context/GameContext';

export const EmptyView: React.FC = () => {
  const { openModal } = useGame();

  return (
    <section id="view-empty" className="view-panel" style={{ display: 'flex' }}>
      <div className="empty-hero">
        <div className="hero-icon">🎲</div>
        <h2>Welcome to Business Game Banker</h2>
        <p>Digitalize the money, drawer float, rounds, and double-entry ledger of your board game.</p>
        <div className="hero-actions">
          <button className="btn btn-primary btn-lg" id="btn-empty-new-game" onClick={() => openModal('new-game')}>
            Create New Game
          </button>
          <button className="btn btn-secondary btn-lg" id="btn-empty-select-game" onClick={() => openModal('games-list')}>
            Select Existing Game
          </button>
        </div>
      </div>
    </section>
  );
};
