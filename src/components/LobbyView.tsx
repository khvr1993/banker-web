import React, { useState } from 'react';
import { useGame } from '../context/GameContext';
import { formatMoney, deriveNextSeat, derivePlayerColor } from '../lib/constants';
import { localApi } from '../lib/api';
import { sound } from '../lib/sound';

export const LobbyView: React.FC = () => {
  const { game, players, showToast, refreshActiveGame } = useGame();
  const [playerName, setPlayerName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!game) return null;

  const curr = game.currency || '₹';
  const nextSeat = deriveNextSeat(players);
  const color = derivePlayerColor(nextSeat);

  const handleAddPlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = playerName.trim();
    if (!clean) return;

    try {
      setSubmitting(true);
      await localApi(`/games/${game.id}/players`, {
        method: 'POST',
        body: { name: clean, seat: nextSeat },
      });
      setPlayerName('');
      showToast(`Seated ${clean} at Seat ${nextSeat}`, 'success');
      await refreshActiveGame();
    } catch (err: any) {
      showToast(err.message || 'Failed to seat player', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemovePlayer = async (pid: string) => {
    try {
      await localApi(`/games/${game.id}/players/${pid}`, { method: 'DELETE' });
      showToast('Player removed', 'info');
      await refreshActiveGame();
    } catch (err: any) {
      showToast(err.message || 'Failed to remove player', 'error');
    }
  };

  const handleStartGame = async () => {
    if (players.length < 1) {
      showToast('Seat at least 1 player before starting!', 'error');
      return;
    }

    try {
      await localApi(`/games/${game.id}/start`, { method: 'POST' });
      sound.playRoundBell();
      showToast('Game started! Starting cash distributed.', 'success');
      await refreshActiveGame();
    } catch (err: any) {
      showToast(err.message || 'Failed to start game', 'error');
    }
  };

  return (
    <section id="view-lobby" className="view-panel" style={{ display: 'flex' }}>
      <div className="panel-header">
        <div>
          <span className="badge badge-warning">LOBBY / SETUP</span>
          <h2 id="lobby-game-title">{game.name}</h2>
          <p className="text-muted">
            Seat all players around the table before starting. Cash will be distributed once the game starts.
          </p>
        </div>
        <div className="panel-actions">
          <button id="btn-start-game" className="btn btn-emerald btn-lg" onClick={handleStartGame}>
            🚀 Start Game & Pay Cash
          </button>
        </div>
      </div>

      {/* Game Parameters Summary */}
      <div className="summary-cards-grid">
        <div className="summary-card">
          <span className="label">Starting Cash</span>
          <strong id="lobby-starting-cash">{formatMoney(game.starting_cash, curr)}</strong>
          <span className="subtext">Given to each player at start</span>
        </div>
        <div className="summary-card">
          <span className="label">Initial Bank Float</span>
          <strong id="lobby-bank-balance">{formatMoney(game.initial_bank_balance, curr)}</strong>
          <span className="subtext">Drawer money supply</span>
        </div>
        <div className="summary-card">
          <span className="label">Round Salary</span>
          <strong id="lobby-round-salary">{formatMoney(game.salary_per_round, curr)}</strong>
          <span className="subtext">Paid when advancing rounds</span>
        </div>
      </div>

      {/* Seated Players Section */}
      <div className="lobby-grid">
        <div className="card lobby-players-card">
          <div className="card-header">
            <h3>Seated Players (<span id="lobby-player-count">{players.length}</span>)</h3>
            <span className="text-muted text-sm">Need at least 1 player to start</span>
          </div>
          <div className="card-body">
            <div id="lobby-players-list" className="lobby-players-list">
              {players.length === 0 ? (
                <div className="text-muted text-center p-4">
                  No players seated yet. Add at least 1 player below.
                </div>
              ) : (
                players.map((p) => {
                  const pColor = derivePlayerColor(p.seat_no);
                  return (
                    <div key={p.id} className="lobby-player-row">
                      <div className="lobby-player-left">
                        <div className="player-avatar" style={{ backgroundColor: pColor.bg, color: pColor.text }}>
                          {p.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <strong>{p.name}</strong>
                          <div className="text-xs text-muted">Seat {p.seat_no}</div>
                        </div>
                      </div>
                      <button
                        className="btn btn-ghost btn-xs btn-remove-player"
                        onClick={() => handleRemovePlayer(p.id)}
                        title="Remove player"
                      >
                        Remove
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Add Player Card */}
        <div className="card lobby-add-card">
          <div className="card-header">
            <h3>Seat Next Player</h3>
          </div>
          <div className="card-body">
            <form id="form-add-player" className="form-vertical" onSubmit={handleAddPlayer}>
              <div className="form-group">
                <label htmlFor="input-player-name">Player Name</label>
                <input
                  type="text"
                  id="input-player-name"
                  className="form-input"
                  placeholder="e.g. Alice, Bob, Raj"
                  required
                  autoComplete="off"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                />
              </div>
              <div className="derived-info-box">
                <div className="info-row">
                  <span>Assigned Seat:</span>
                  <strong id="derived-seat-no">Seat {nextSeat}</strong>
                </div>
                <div className="info-row">
                  <span>Assigned Color:</span>
                  <div
                    className="color-preview"
                    id="derived-color-preview"
                    style={{ backgroundColor: color.bg }}
                    title={color.name}
                  />
                </div>
              </div>
              <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
                + Seat Player
              </button>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
};
