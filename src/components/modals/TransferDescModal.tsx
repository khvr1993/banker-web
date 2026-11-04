import React, { useState } from 'react';
import { useGame } from '../../context/GameContext';

export const TransferDescModal: React.FC = () => {
  const { closeModal, customDesc, setCustomDesc, modalPayload } = useGame();
  const [val, setVal] = useState(customDesc);
  const autoDesc = modalPayload?.autoDesc || '-';

  const handleDone = () => {
    setCustomDesc(val);
    closeModal();
  };

  const handleReset = () => {
    setVal('');
    setCustomDesc('');
  };

  return (
    <div className="modal-backdrop" id="modal-transfer-desc" style={{ display: 'flex' }}>
      <div className="modal-dialog modal-sm">
        <div className="modal-header">
          <h3>Transaction Note / Memo</h3>
          <button type="button" className="modal-close" onClick={closeModal}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label htmlFor="transfer-description">Custom Description</label>
            <input
              type="text"
              id="transfer-description"
              className="form-input"
              placeholder="Optional description / memo"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              autoFocus
            />
            <div className="text-xs text-muted mt-2" id="desc-auto-preview">
              Standard: <span id="desc-auto-text">{autoDesc}</span>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary btn-sm" id="btn-desc-clear-custom" onClick={handleReset}>
            Reset Auto
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleDone}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
