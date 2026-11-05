import React, { useState } from 'react';
import { useGame } from '../context/GameContext';
import { buildJoinUrl, buildShareUrl, isLoopbackOrigin } from '../lib/net/joinUrl';
import { JoinQr } from './JoinQr';

export const HostSessionPanel: React.FC = () => {
  const {
    game,
    sessionRole,
    roomCode,
    joinUrl,
    remotePeers,
    connectionState,
    startHosting,
    stopHosting,
    approveJoin,
    denyJoin,
    kickPeer,
    showToast,
  } = useGame();
  const [starting, setStarting] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [publicBase, setPublicBase] = useState(() => {
    try {
      return localStorage.getItem('banker_public_url') || '';
    } catch {
      return '';
    }
  });

  if (!game || sessionRole === 'client') return null;

  const effectiveJoinUrl =
    joinUrl && publicBase.trim() ? buildJoinUrl(roomCode || '', publicBase.trim()) : joinUrl;
  const loopbackWarning = Boolean(joinUrl && !publicBase.trim() && isLoopbackOrigin(joinUrl));

  const handleStart = async () => {
    setStarting(true);
    // PeerJS Cloud can hold the previous peer id briefly after a reload.
    const timer = setTimeout(() => setReclaiming(true), 2500);
    try {
      await startHosting();
    } finally {
      clearTimeout(timer);
      setReclaiming(false);
      setStarting(false);
    }
  };

  const handleCopy = async () => {
    if (!effectiveJoinUrl) return;
    try {
      await navigator.clipboard.writeText(effectiveJoinUrl);
      showToast('Join link copied', 'success', 1800);
    } catch {
      showToast('Copy failed — select the link manually', 'error');
    }
  };

  const handleCopyRoom = async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      showToast('Room code copied', 'success', 1800);
    } catch {
      showToast('Copy failed — select the code manually', 'error');
    }
  };

  const handleShareTab = () => {
    if (!roomCode) return;
    const url = buildShareUrl(roomCode, publicBase.trim() || undefined, game?.name);
    // A second tab/window is easier to hand around or put on a second screen
    // than copy-pasting the join URL.
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  if (sessionRole !== 'host') {
    return (
      <div className="card host-session-card" id="host-session-card">
        <div className="card-body host-session-idle">
          <div>
            <h3>Play together on phones</h3>
            <p className="text-muted text-sm">
              Host this table so players can join from their own devices. You stay the banker and keep the
              authoritative ledger; phones only mirror it.
            </p>
          </div>
          <button
            className="btn btn-secondary"
            id="btn-host-session"
            onClick={handleStart}
            disabled={starting || connectionState === 'connecting'}
          >
            {reclaiming ? 'Reclaiming room…' : starting ? 'Starting…' : 'Host Online Session'}
          </button>
        </div>
      </div>
    );
  }

  const pending = remotePeers.filter((p) => p.status === 'pending');
  const connected = remotePeers.filter((p) => p.status === 'connected');

  return (
    <div className="card host-session-card is-live" id="host-session-panel">
      <div className="card-header">
        <h3>Hosted Session</h3>
        <span className="host-live-tag">
          <span className="connection-dot" aria-hidden="true" /> Live
        </span>
      </div>
      <div className="card-body host-session-body">
        <div className="host-room-row">
          <div className="host-room-code">
            <span className="label">Room code</span>
            <div className="host-room-code-value">
              <strong className="mono-num" id="host-room-code">{roomCode}</strong>
              <button className="btn btn-ghost btn-xs" onClick={handleCopyRoom}>
                Copy
              </button>
            </div>
          </div>
          <div className="host-room-actions">
            <button className="btn btn-primary btn-sm" onClick={handleShareTab}>
              Share screen
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowQr((value) => !value)}
              aria-expanded={showQr}
            >
              {showQr ? 'Hide QR' : 'Show QR'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleCopy}>
              Copy join link
            </button>
            <button className="btn btn-ghost btn-sm" onClick={stopHosting}>
              Stop hosting
            </button>
          </div>
        </div>

        {effectiveJoinUrl && (
          <div className="host-join-url mono-num" id="host-join-url" title={effectiveJoinUrl}>
            {effectiveJoinUrl}
          </div>
        )}

        {showQr && effectiveJoinUrl && (
          <div className="host-share-qr" id="host-share-qr">
            <JoinQr value={effectiveJoinUrl} size={168} />
            <div className="host-share-qr-meta">
              <span className="label">Scan to join</span>
              <strong className="mono-num">{roomCode}</strong>
              <span className="text-xs text-muted">
                Point a phone camera here. For a bigger display, open the share screen in its own
                tab.
              </span>
            </div>
          </div>
        )}

        {loopbackWarning && (
          <div className="join-status warning" id="host-loopback-warning">
            <span className="connection-dot" aria-hidden="true" />
            <span>
              This link points at localhost and will not open on a phone. Share the room code, open the
              app via your computer&apos;s LAN IP, or set a public base URL below.
            </span>
          </div>
        )}

        <div className="host-public-url">
          <label className="flow-label" htmlFor="host-public-base">
            Public base URL (optional)
          </label>
          <div className="host-room-actions">
            <input
              id="host-public-base"
              className="form-input mono-num"
              placeholder="https://your-app.example.com"
              value={publicBase}
              onChange={(e) => setPublicBase(e.target.value)}
            />
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                const clean = publicBase.trim().replace(/\/$/, '');
                try {
                  if (clean) localStorage.setItem('banker_public_url', clean);
                  else localStorage.removeItem('banker_public_url');
                } catch {
                  // ignore storage failures
                }
                setPublicBase(clean);
                showToast(clean ? 'Public join base saved' : 'Public join base cleared', 'success', 1800);
              }}
            >
              Save link base
            </button>
          </div>
        </div>

        <p className="host-hint text-xs text-muted">
          Keep this tab open and awake — the banker device must stay connected. Players join from the same
          Wi-Fi or any network that allows WebRTC.
        </p>

        {pending.length > 0 && (
          <div className="host-section">
            <div className="host-section-title">
              Join requests <span className="meta-inline mono-num">{pending.length}</span>
            </div>
            <div className="host-peer-list">
              {pending.map((peer) => (
                <div key={peer.sessionId} className="host-peer-row pending">
                  <div>
                    <strong>{peer.name}</strong>
                    <div className="text-xs text-muted">
                      {peer.kicked
                        ? 'Was removed — allow to rejoin the same seat'
                        : peer.reclaiming
                          ? 'Reconnecting to an existing seat'
                          : 'Waiting for approval'}
                    </div>
                  </div>
                  <div className="host-peer-actions">
                    <button className="btn btn-primary btn-xs" onClick={() => approveJoin(peer.sessionId)}>
                      Allow
                    </button>
                    <button className="btn btn-ghost btn-xs" onClick={() => denyJoin(peer.sessionId)}>
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="host-section">
          <div className="host-section-title">
            Connected devices <span className="meta-inline mono-num">{connected.length}</span>
          </div>
          {connected.length === 0 ? (
            <div className="text-muted text-xs">No phones connected yet.</div>
          ) : (
            <div className="host-peer-list">
              {connected.map((peer) => (
                <div key={peer.sessionId} className="host-peer-row">
                  <div>
                    <strong>{peer.name}</strong>
                    <div className="text-xs text-muted">Live · seat synced</div>
                  </div>
                  <button className="btn btn-ghost btn-xs" onClick={() => kickPeer(peer.sessionId)}>
                    Kick
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
