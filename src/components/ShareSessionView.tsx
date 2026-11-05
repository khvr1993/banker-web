import React, { useEffect, useState } from 'react';
import { buildJoinUrl, isLoopbackOrigin } from '../lib/net/joinUrl';
import { sanitizeRoom } from '../lib/net/protocol';
import { JoinQr } from './JoinQr';

interface ShareSessionViewProps {
  room: string;
  gameName?: string;
}

function storedPublicBase(): string {
  try {
    return localStorage.getItem('banker_public_url') || '';
  } catch {
    return '';
  }
}

/**
 * Standalone share screen, opened via `?share=<room>` in a second tab/window.
 * It intentionally does not boot the game or the WebRTC session: it only shows
 * the QR code and room code the phones need to join.
 */
export const ShareSessionView: React.FC<ShareSessionViewProps> = ({ room, gameName }) => {
  const cleanRoom = sanitizeRoom(room);
  const [publicBase] = useState(storedPublicBase);
  const [theme] = useState(() => {
    try {
      return localStorage.getItem('banker_theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [copied, setCopied] = useState<'link' | 'room' | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.classList.toggle('light', theme === 'light');
    root.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const joinUrl = cleanRoom ? buildJoinUrl(cleanRoom, publicBase.trim() || undefined) : '';
  const loopback = !publicBase.trim() && isLoopbackOrigin(window.location.origin);

  const copy = async (text: string, target: 'link' | 'room') => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(target);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  };

  if (!cleanRoom) {
    return (
      <div className="share-screen">
        <div className="share-card">
          <div className="section-kicker">Hosted Session</div>
          <h1>No room code</h1>
          <p className="text-muted">
            Open this screen with the “Share screen” button on the banker&apos;s Hosted Session panel.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="share-screen">
      <div className="share-card">
        <div className="share-brand">
          <div className="logo-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M3 21h18M3 10h18M5 10v11M9 10v11M15 10v11M19 10v11M12 2L2 7h20L12 2z" />
            </svg>
          </div>
          <span>Business Game Banker</span>
        </div>

        <div className="section-kicker">Live Table</div>
        <h1>Scan to join</h1>
        {gameName && <p className="share-game">{gameName}</p>}

        <div className="share-qr-frame">
          <JoinQr value={joinUrl} size={280} />
        </div>

        <div className="share-room">
          <div>
            <span className="label">Room code</span>
            <strong className="mono-num">{cleanRoom}</strong>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => copy(cleanRoom, 'room')}>
            {copied === 'room' ? 'Copied' : 'Copy code'}
          </button>
        </div>

        <div className="share-url mono-num" title={joinUrl}>
          {joinUrl}
        </div>
        <button className="btn btn-primary btn-block" onClick={() => copy(joinUrl, 'link')}>
          {copied === 'link' ? 'Join link copied' : 'Copy join link'}
        </button>

        <ol className="share-steps">
          <li>Open the camera on a phone.</li>
          <li>Scan the code and enter your name.</li>
          <li>Wait for the banker to tap Allow.</li>
        </ol>

        {loopback && (
          <div className="join-status warning">
            <span className="connection-dot" aria-hidden="true" />
            <span>
              This screen is on localhost, so phones cannot reach it. Open the app via your
              computer&apos;s LAN IP or set a Public base URL in the Hosted Session panel.
            </span>
          </div>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-sm share-back"
          onClick={() => window.location.assign(window.location.pathname)}
        >
          Back to the table
        </button>
      </div>
    </div>
  );
};
