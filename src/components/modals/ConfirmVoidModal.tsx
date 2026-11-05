import React, { useState } from 'react';
import { useGame } from '../../context/GameContext';
import { gameApi } from '../../lib/gameApi';
import { sound } from '../../lib/sound';
import { formatMoney } from '../../lib/constants';
import { Transaction } from '../../types';

export const ConfirmVoidModal: React.FC = () => {
  const { game, closeModal, showToast, refreshActiveGame, modalPayload } = useGame();
  const [submitting, setSubmitting] = useState(false);
  const txn: Transaction | undefined = modalPayload?.transaction;

  const curr = game?.currency || '₹';

  const handleVoid = async () => {
    if (!game || !txn) return;
    try {
      setSubmitting(true);
      await gameApi(`/games/${game.id}/transfers/${txn.id}/void`, {
        method: 'POST',
      });
      sound.playVoid();
      closeModal();
      showToast('Transaction voided with reversal entry!', 'success');
      await refreshActiveGame();
    } catch (err: any) {
      showToast(err.message || 'Failed to void transaction', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!txn) return null;

  return (
    <div className="modal-backdrop" id="modal-confirm-void" style={{ display: 'flex' }}>
      <div className="modal-dialog modal-sm">
        <div className="modal-header">
          <h3>Void Transaction</h3>
          <button className="modal-close" onClick={closeModal}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <p>
            Are you sure you want to void this transaction? A compensating reversal entry will be written to the double-entry ledger.
          </p>
          <div className="void-preview-card mt-3" id="void-preview-info">
            <div>
              <strong>Txn ID:</strong> <code>{txn.id}</code>
            </div>
            <div>
              <strong>Category:</strong> {txn.account_category}
            </div>
            <div>
              <strong>Amount:</strong> {formatMoney(txn.amount, curr)}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" id="btn-execute-void" onClick={handleVoid} disabled={submitting}>
            Confirm Void
          </button>
        </div>
      </div>
    </div>
  );
};
