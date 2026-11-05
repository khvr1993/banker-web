import React, { useEffect, useRef, useState } from 'react';
import { useGame } from '../context/GameContext';
import { hasStoredSession } from '../lib/net/clientSession';
import { normalizeRoom } from '../lib/net/protocol';

export const JoinSessionView: React.FC = () => {
  const {
    joinRoomToken,
    joinSession,
    connectionState,
    sessionError,
    joinPending,
    leaveSession,
    showToast,
  } = useGame();

  const [name, setName] = useState(() => localStorage.getItem('banker_display_name') || '');
  const [room, setRoom] = useState(joinRoomToken || '');
  const [submitting, setSubmitting] = useState(false);
  const autoTried = useRef(false);

  const connect = async (targetRoom: string, targetName: string) => {
    const cleanRoom = normalizeRoom(targetRoom);
    if (!cleanRoom) {
      showToast('Enter a room code or paste the join link', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await joinSession(cleanRoom, targetName.trim() || 'Player');
    } finally {
      setSubmitting(false);
    }
  };

  // Refresh / reopen with stored credentials: rejoin the same seat automatically.
  useEffect(() => {
    if (autoTried.current || !joinRoomToken) return;
    autoTried.current = true;
    if (hasStoredSession(joinRoomToken)) {
      const storedName = localStorage.getItem('banker_display_name') || 'Player';
      void connect(joinRoomToken, storedName);
    }
  }, [joinRoomToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      showToast('Enter your name so the banker knows who is joining', 'error');
      return;
    }
    localStorage.setItem('banker_display_name', cleanName);
    await connect(room || joinRoomToken || '', cleanName);
  };

  const busy = submitting || connectionState === 'connecting' || joinPending;
  const showRetry = !busy && (connectionState === 'error' || connectionState === 'reconnecting');

  let statusText = '';
  let statusClass = '';
  if (joinPending) {
    statusText = 'Request sent — waiting for the banker to allow you in.';
    statusClass = 'pending';
  } else if (connectionState === 'connecting' || submitting) {
    statusText = 'Connecting to the hosted table…';
    statusClass = 'pending';
  } else if (connectionState === 'reconnecting') {
    statusText = 'Connection lost — retrying automatically…';
    statusClass = 'warning';
  } else if (connectionState === 'error') {
    statusText = sessionError || 'Could not reach the banker.';
    statusClass = 'error';
  }

  return (
    <section className="join-screen" id="view-join">
      <div className="join-card">
        <div className="join-hero">
          <div className="logo-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M3 21h18M3 10h18M5 10v11M9 10v11M15 10v11M19 10v11M12 2L2 7h20L12 2z" />
            </svg>
          </div>
          <div>
            <div className="section-kicker">Live Table</div>
            <h2>Join Game Session</h2>
            <p className="text-muted text-sm">
              Enter the room code the banker shared. All balances are locked by the banker&apos;s ledger.
            </p>
          </div>
        </div>

        <form className="form-vertical" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="join-room-code">Room Code / Join Link</label>
            <input
              type="text"
              id="join-room-code"
              className="form-input mono-num"
              placeholder="join-…"
              autoComplete="off"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              disabled={busy}
            />
          </div>

          <div className="form-group">
            <label htmlFor="join-display-name">Your Name</label>
            <input
              type="text"
              id="join-display-name"
              className="form-input"
              placeholder="e.g. Alice"
              autoComplete="off"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </div>

          {statusText && (
            <div className={`join-status ${statusClass}`} id="join-status">
              <span className="connection-dot" aria-hidden="true" />
              <span>{statusText}</span>
            </div>
          )}

          <div className="join-actions">
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
              {busy ? 'Connecting…' : 'Connect to Table'}
            </button>
            {showRetry && (
              <button
                type="button"
                className="btn btn-secondary btn-block"
                disabled={submitting}
                onClick={() => connect(room || joinRoomToken || '', name)}
              >
                Retry Connection
              </button>
            )}
          </div>
        </form>

        <button type="button" className="btn btn-ghost btn-sm join-back" onClick={leaveSession}>
          Leave and open local mode
        </button>
      </div>
    </section>
  );
};
