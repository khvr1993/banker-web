import React, { useState } from 'react';
import { useGame } from '../../context/GameContext';
import { gameApi } from '../../lib/gameApi';
import { formatMoney } from '../../lib/constants';

export const PatchSalaryModal: React.FC = () => {
  const { game, closeModal, showToast, refreshActiveGame } = useGame();
  const [salary, setSalary] = useState(String(game?.salary_per_round || 0));
  const [submitting, setSubmitting] = useState(false);

  const curr = game?.currency || '₹';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!game) return;
    const num = parseInt(salary, 10);
    if (isNaN(num) || num < 0) return;

    try {
      setSubmitting(true);
      await gameApi(`/games/${game.id}`, {
        method: 'PATCH',
        body: { round_salary: num },
      });
      closeModal();
      showToast(`Round salary updated to ${formatMoney(num, curr)}`, 'success');
      await refreshActiveGame();
    } catch (err: any) {
      showToast(err.message || 'Failed to update salary', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" id="modal-patch-salary" style={{ display: 'flex' }}>
      <div className="modal-dialog modal-sm">
        <div className="modal-header">
          <h3>Edit Round Salary</h3>
          <button className="modal-close" onClick={closeModal}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <form id="form-patch-salary" className="form-vertical" onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="patch-salary-input">
                New Round Salary (<span className="currency-sym">{curr}</span>)
              </label>
              <input
                type="number"
                id="patch-salary-input"
                className="form-input"
                min="0"
                step="100"
                required
                value={salary}
                onChange={(e) => setSalary(e.target.value)}
                autoFocus
              />
              <span className="text-xs text-muted">Audit-logged on the game record</span>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeModal}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                Save Salary
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
