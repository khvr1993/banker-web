import React from 'react';
import { useGame } from '../context/GameContext';

export const ConnectionPill: React.FC = () => {
  const { sessionRole, connectionState, remotePeers, latencyMs } = useGame();

  if (sessionRole === 'local') return null;

  let label = 'Offline';
  let state = 'error';

  if (sessionRole === 'host') {
    label = `Hosting · ${remotePeers.filter((p) => p.status === 'connected').length}`;
    state = 'connected';
  } else if (connectionState === 'connected') {
    label = latencyMs > 0 ? `Joined · ${latencyMs} ms` : 'Joined · live';
    state = 'connected';
  } else if (connectionState === 'connecting') {
    label = 'Joining…';
    state = 'connecting';
  } else if (connectionState === 'reconnecting') {
    label = 'Reconnecting…';
    state = 'reconnecting';
  } else if (connectionState === 'error') {
    label = 'Offline';
    state = 'error';
  }

  return (
    <span className={`connection-pill ${state}`} id="connection-pill" title={label}>
      <span className="connection-dot" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
};
