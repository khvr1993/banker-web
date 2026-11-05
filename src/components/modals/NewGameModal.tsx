import React, { useState } from 'react';
import { useGame } from '../../context/GameContext';
import { gameApi } from '../../lib/gameApi';

export const NewGameModal: React.FC = () => {
  const { closeModal, showToast, loadGame } = useGame();
  const [name, setName] = useState('');
  const [startingCash, setStartingCash] = useState('10000');
  const [bankBalance, setBankBalance] = useState('100000');
  const [salary, setSalary] = useState('2000');
  const [currency, setCurrency] = useState('₹');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) return;

    try {
      setSubmitting(true);
      const game = await gameApi('/games', {
        method: 'POST',
        body: {
          name: cleanName,
          starting_cash: parseInt(startingCash, 10),
          initial_bank_balance: parseInt(bankBalance, 10),
          salary_per_round: parseInt(salary, 10),
          currency: currency.trim() || '₹',
        },
      });

      closeModal();
      showToast(`Game "${game.name}" created!`, 'success');
      loadGame(game.id);
    } catch (err: any) {
      showToast(err.message || 'Failed to create game', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" id="modal-new-game" style={{ display: 'flex' }}>
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Create New Game</h3>
          <button className="modal-close" onClick={closeModal}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <form id="form-new-game" className="form-vertical" onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="new-game-name">Game Name *</label>
              <input
                type="text"
                id="new-game-name"
                className="form-input"
                required
                placeholder="e.g. Monopoly Family Night"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="form-row-3">
              <div className="form-group">
                <label htmlFor="new-starting-cash">Starting Cash</label>
                <input
                  type="number"
                  id="new-starting-cash"
                  className="form-input"
                  min="0"
                  step="100"
                  value={startingCash}
                  onChange={(e) => setStartingCash(e.target.value)}
                />
                <span className="text-xs text-muted">Per player</span>
              </div>
              <div className="form-group">
                <label htmlFor="new-bank-balance">Bank Float</label>
                <input
                  type="number"
                  id="new-bank-balance"
                  className="form-input"
                  min="0"
                  step="1000"
                  value={bankBalance}
                  onChange={(e) => setBankBalance(e.target.value)}
                />
                <span className="text-xs text-muted">Drawer seed</span>
              </div>
              <div className="form-group">
                <label htmlFor="new-salary">Round Salary</label>
                <input
                  type="number"
                  id="new-salary"
                  className="form-input"
                  min="0"
                  step="100"
                  value={salary}
                  onChange={(e) => setSalary(e.target.value)}
                />
                <span className="text-xs text-muted">Per round pass</span>
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="new-currency">Currency Symbol</label>
              <input
                type="text"
                id="new-currency"
                className="form-input"
                maxLength={5}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              />
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeModal}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                Create & Open Lobby
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
