import React, { useRef } from 'react';
import { useGame } from '../../context/GameContext';
import { exportBackup, importBackup } from '../../lib/api';

export const BackupRestoreModal: React.FC = () => {
  const { closeModal, showToast } = useGame();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    try {
      await exportBackup();
      showToast('Backup downloaded. Open it here or on another device to restore.', 'success', 4000);
    } catch (err: any) {
      console.error('Backup export failed:', err);
      showToast('Could not create backup: ' + (err?.message || err), 'error');
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const confirmed = window.confirm(
      'Restoring replaces ALL current games in this browser with the backup contents.\n\nContinue?'
    );
    if (!confirmed) return;

    try {
      await importBackup(file);
      showToast('Backup restored! Reloading…', 'success', 2000);
      setTimeout(() => window.location.reload(), 800);
    } catch (err: any) {
      console.error('Backup restore failed:', err);
      showToast('Restore failed: ' + (err?.message || err), 'error');
    }
  };

  return (
    <div className="modal-backdrop" id="modal-backup" style={{ display: 'flex' }}>
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Backup &amp; Restore</h3>
          <button className="modal-close" onClick={closeModal}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <p className="text-muted text-xs" style={{ lineHeight: 1.6 }}>
            Games live in this browser&apos;s storage on this device — there is no server.
            Download a backup file before clearing browser data, switching devices, or reinstalling.
          </p>

          <div className="backup-actions mt-3" style={{ display: 'grid', gap: '10px' }}>
            <button className="btn btn-primary" id="btn-export-backup" onClick={handleExport}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              <span>Download Backup (.json)</span>
            </button>

            <button
              className="btn btn-secondary"
              id="btn-import-backup"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
              </svg>
              <span>Restore from Backup File…</span>
            </button>
            <input
              type="file"
              ref={fileInputRef}
              id="input-backup-file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>

          <div
            className="text-xs text-muted"
            style={{
              lineHeight: 1.7,
              background: '#0f172a',
              padding: '12px',
              borderRadius: '8px',
              border: '1px solid #1e293b',
              marginTop: '12px',
            }}
          >
            <strong style={{ color: '#fbbf24' }}>⚠ Before restoring:</strong> restoring{' '}
            <strong>replaces everything</strong> currently in the app. Your current games will be overwritten by the
            backup. This cannot be undone.
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
