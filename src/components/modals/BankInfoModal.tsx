import React, { useState, useEffect } from 'react';
import { useGame } from '../../context/GameContext';
import { formatMoney } from '../../lib/constants';
import { localApi } from '../../lib/api';
import { BankInfo } from '../../types';

export const BankInfoModal: React.FC = () => {
  const { game, closeModal } = useGame();
  const [info, setInfo] = useState<BankInfo | null>(null);

  useEffect(() => {
    if (!game) return;
    localApi(`/games/${game.id}/bank`)
      .then((res) => setInfo(res))
      .catch((err) => console.warn(err));
  }, [game]);

  const curr = game?.currency || '₹';
  const drawerCash = info?.bank_balance ?? game?.bank_balance ?? 0;
  const activePlayers = info?.players_active ?? 0;
  const bankruptPlayers = info?.players_bankrupt ?? 0;

  return (
    <div className="modal-backdrop" id="modal-bank-info" style={{ display: 'flex' }}>
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Banker Drawer State</h3>
          <button className="modal-close" onClick={closeModal}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <div className="summary-cards-grid">
            <div className="summary-card">
              <span className="label">Drawer Cash</span>
              <strong id="modal-bank-drawer-cash">{formatMoney(drawerCash, curr)}</strong>
            </div>
            <div className="summary-card">
              <span className="label">Active Players</span>
              <strong id="modal-bank-active-players">{activePlayers}</strong>
            </div>
          </div>
          <div className="card mt-4 p-4 text-sm text-muted">
            <p>
              <strong>Double-entry integrity:</strong> The bank drawer holds all central reserves. Insolvent drawers trigger an automatic rejection on money movements to preserve board game money conservation.
            </p>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={closeModal}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
