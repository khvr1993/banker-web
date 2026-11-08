import React, { useCallback, useEffect, useState } from 'react';
import { useGame } from './context/GameContext';
import { Header } from './components/Header';
import type { GameView } from './components/Header';
import { EmptyView } from './components/EmptyView';
import { LobbyView } from './components/LobbyView';
import { BankerConsoleView } from './components/BankerConsoleView';
import { PlayerView } from './components/PlayerView';
import { AllModals } from './components/modals/AllModals';
import { ToastContainer } from './components/ToastContainer';
import { JoinSessionView } from './components/JoinSessionView';
import { MemoryMatchGame } from './components/memory/MemoryMatchGame';
import './components/memory/memory.css';

function readGameView(): GameView {
  if (typeof window === 'undefined') return 'banker';
  const hash = window.location.hash.replace(/^#\/?/, '').toLowerCase();
  if (hash === 'memory' || hash === 'memory-match') return 'memory';
  const query = new URLSearchParams(window.location.search).get('game');
  return query === 'memory' ? 'memory' : 'banker';
}

export const App: React.FC = () => {
  const { game, appMode, sessionRole, sessionReady } = useGame();
  const [activeGame, setActiveGame] = useState<GameView>(() => readGameView());

  useEffect(() => {
    const syncFromUrl = () => setActiveGame(readGameView());
    window.addEventListener('popstate', syncFromUrl);
    window.addEventListener('hashchange', syncFromUrl);
    return () => {
      window.removeEventListener('popstate', syncFromUrl);
      window.removeEventListener('hashchange', syncFromUrl);
    };
  }, []);

  const switchGame = useCallback((next: GameView) => {
    setActiveGame(next);
    const url = new URL(window.location.href);
    url.searchParams.delete('game');
    url.hash = next === 'memory' ? '/memory' : '';
    const target = `${url.pathname}${url.search}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (target !== current) {
      window.history.pushState({ game: next }, '', target);
    }
  }, []);

  const renderMainContent = () => {
    if (sessionRole === 'client' && !sessionReady) {
      return <JoinSessionView />;
    }

    if (!game) {
      return <EmptyView />;
    }

    if (appMode === 'player') {
      return <PlayerView />;
    }

    if (game.status === 'pending') {
      return <LobbyView />;
    }

    return <BankerConsoleView />;
  };

  return (
    <>
      <Header activeGame={activeGame} onSwitchGame={switchGame} />
      <main className={activeGame === 'memory' ? 'main-content mm-main' : 'main-content'}>
        {activeGame === 'memory' ? <MemoryMatchGame /> : renderMainContent()}
      </main>
      {activeGame === 'banker' && <AllModals />}
      <ToastContainer />
    </>
  );
};

export default App;
