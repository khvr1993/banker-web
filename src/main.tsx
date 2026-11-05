import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { GameProvider } from './context/GameContext';
import { ShareSessionView } from './components/ShareSessionView';
import './style.css';

const params = new URLSearchParams(window.location.search);
const shareRoom = params.get('share');
const shareName = params.get('name') || undefined;

const root = ReactDOM.createRoot(document.getElementById('root')!);

if (shareRoom) {
  // The share screen is deliberately standalone: it shows the QR code and room
  // code without opening the ledger or starting a second WebRTC host.
  root.render(
    <React.StrictMode>
      <ShareSessionView room={shareRoom} gameName={shareName} />
    </React.StrictMode>
  );
} else {
  root.render(
    <React.StrictMode>
      <GameProvider>
        <App />
      </GameProvider>
    </React.StrictMode>
  );
}
