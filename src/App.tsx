import React from 'react';
import { useGame } from './context/GameContext';
import { Header } from './components/Header';
import { EmptyView } from './components/EmptyView';
import { LobbyView } from './components/LobbyView';
import { BankerConsoleView } from './components/BankerConsoleView';
import { PlayerView } from './components/PlayerView';
import { AllModals } from './components/modals/AllModals';
import { ToastContainer } from './components/ToastContainer';

export const App: React.FC = () => {
  const { game, appMode } = useGame();

  const renderMainContent = () => {
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
      <Header />
      <main className="main-content">{renderMainContent()}</main>
      <AllModals />
      <ToastContainer />
    </>
  );
};

export default App;
