import React, { useState } from 'react';
import { useGame } from '../../context/GameContext';
import { gameApi } from '../../lib/gameApi';
import { sound } from '../../lib/sound';
import { Player } from '../../types';

export const ConfirmBankruptModal: React.FC = () => {
  const { game, closeModal, showToast, refreshActiveGame, modalPayload } = useGame();
  const [submitting, setSubmitting] = useState(false);
  const player: Player | undefined = modalPayload?.player;

  const handleBankrupt = async () => {
    if (!game || !player) return;
    try {
      setSubmitting(true);
      await gameApi(`/games/${game.id}/players/${player.id}/bankrupt`, {
        method: 'POST',
      });
      sound.playVoid();
      closeModal();
      showToast('Player declared bankrupt and remaining cash swept to Bank', 'info');
      await refreshActiveGame();
    } catch (err: any) {
      showToast(err.message || 'Bankruptcy declaration failed', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!player) return null;

  return (
    <div className="modal-backdrop" id="modal-confirm-bankrupt" style={{ display: 'flex' }}>
      <div className="modal-dialog modal-sm">
        <div className="modal-header">
          <h3>Declare Bankruptcy</h3>
          <button className="modal-close" onClick={closeModal}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <p>
            Declare <strong id="bankrupt-player-name">{player.name}</strong> bankrupt?
          </p>
          <p className="text-sm text-muted mt-2">
            All remaining cash will be swept back to the Bank drawer, and this account will be frozen from future transfers.
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={closeModal}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            id="btn-execute-bankrupt"
            onClick={handleBankrupt}
            disabled={submitting}
          >
            Declare Bankrupt
          </button>
        </div>
      </div>
    </div>
  );
};
