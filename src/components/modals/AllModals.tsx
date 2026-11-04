import React from 'react';
import { useGame } from '../../context/GameContext';
import { GamesListModal } from './GamesListModal';
import { NewGameModal } from './NewGameModal';
import { PlayerStatementModal } from './PlayerStatementModal';
import { TransferDescModal } from './TransferDescModal';
import { BankInfoModal } from './BankInfoModal';
import { PatchSalaryModal } from './PatchSalaryModal';
import { ConfirmVoidModal } from './ConfirmVoidModal';
import { ConfirmBankruptModal } from './ConfirmBankruptModal';
import { BackupRestoreModal } from './BackupRestoreModal';

export const AllModals: React.FC = () => {
  const { activeModal } = useGame();

  if (!activeModal) return null;

  switch (activeModal) {
    case 'games-list':
      return <GamesListModal />;
    case 'new-game':
      return <NewGameModal />;
    case 'player-statement':
      return <PlayerStatementModal />;
    case 'transfer-desc':
      return <TransferDescModal />;
    case 'bank-info':
      return <BankInfoModal />;
    case 'patch-salary':
      return <PatchSalaryModal />;
    case 'confirm-void':
      return <ConfirmVoidModal />;
    case 'confirm-bankrupt':
      return <ConfirmBankruptModal />;
    case 'backup':
      return <BackupRestoreModal />;
    default:
      return null;
  }
};
