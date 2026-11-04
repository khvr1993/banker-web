import React from 'react';
import { useGame } from '../context/GameContext';

export const ToastContainer: React.FC = () => {
  const { toasts } = useGame();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" id="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
};
