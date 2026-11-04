import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Game, Player, Transaction, BankInfo, ToastMessage } from '../types';
import { localApi } from '../lib/api';
import { sound } from '../lib/sound';

interface ModalState {
  name: string | null;
  payload: any;
}

interface GameContextType {
  currentGameId: string | null;
  game: Game | null;
  players: Player[];
  transactions: Transaction[];
  bankInfo: BankInfo | null;
  appMode: 'banker' | 'player';
  myPlayerId: string | null;
  soundEnabled: boolean;
  toasts: ToastMessage[];
  activeModal: string | null;
  modalPayload: any;
  prevBalances: Map<string, number>;
  activeTransferTab: string;
  customDesc: string;
  setCustomDesc: (desc: string) => void;
  setActiveTransferTab: (tab: string) => void;
  openModal: (name: string, payload?: any) => void;
  closeModal: () => void;
  showToast: (message: string, type?: 'info' | 'success' | 'error', duration?: number) => void;
  toggleSound: () => void;
  setAppMode: (mode: 'banker' | 'player') => void;
  setMyPlayerId: (id: string | null) => void;
  loadGame: (id: string) => Promise<void>;
  refreshActiveGame: () => Promise<void>;
}

const GameContext = createContext<GameContextType | undefined>(undefined);

export const GameProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentGameId, setCurrentGameId] = useState<string | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [bankInfo, setBankInfo] = useState<BankInfo | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [modalState, setModalState] = useState<ModalState>({ name: null, payload: null });
  const [activeTransferTab, setActiveTransferTab] = useState<string>('bank-pay');
  const [customDesc, setCustomDesc] = useState<string>('');

  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    return localStorage.getItem('banker_sound') !== 'false';
  });

  const [appMode, setAppModeState] = useState<'banker' | 'player'>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const m = urlParams.get('mode');
    if (m === 'banker' || m === 'player') return m;
    const saved = localStorage.getItem('banker_app_mode');
    return saved === 'player' ? 'player' : 'banker';
  });

  const [myPlayerId, setMyPlayerIdState] = useState<string | null>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const p = urlParams.get('player');
    if (p) return p;
    return null;
  });

  const prevBalancesRef = useRef<Map<string, number>>(new Map());

  const showToast = useCallback((text: string, type: 'info' | 'success' | 'error' = 'info', duration = 3500) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, text, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const openModal = useCallback((name: string, payload: any = null) => {
    setModalState({ name, payload });
  }, []);

  const closeModal = useCallback(() => {
    setModalState({ name: null, payload: null });
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const next = !prev;
      sound.enabled = next;
      localStorage.setItem('banker_sound', String(next));
      showToast(next ? 'Audio cues enabled' : 'Audio cues muted', 'info', 1500);
      return next;
    });
  }, [showToast]);

  const setAppMode = useCallback((mode: 'banker' | 'player') => {
    setAppModeState(mode);
    localStorage.setItem('banker_app_mode', mode);
    if (mode === 'banker') {
      setActiveTransferTab((prev) => (prev !== 'bank-pay' && prev !== 'custom' ? 'bank-pay' : prev));
    } else {
      setActiveTransferTab('custom');
    }
  }, []);

  const setMyPlayerId = useCallback((id: string | null) => {
    setMyPlayerIdState(id);
    if (currentGameId) {
      if (id) {
        localStorage.setItem('banker_player_id_' + currentGameId, id);
      } else {
        localStorage.removeItem('banker_player_id_' + currentGameId);
      }
    }
  }, [currentGameId]);

  const loadGame = useCallback(async (gameId: string) => {
    try {
      setCurrentGameId(gameId);
      localStorage.setItem('banker_last_game_id', gameId);

      const savedPlayer = localStorage.getItem('banker_player_id_' + gameId);
      if (savedPlayer) {
        setMyPlayerIdState(savedPlayer);
      }

      const [gameData, txnsData, bankData] = await Promise.all([
        localApi(`/games/${gameId}`),
        localApi(`/games/${gameId}/ledger`),
        localApi(`/games/${gameId}/bank`).catch(() => null),
      ]);

      setGame(gameData);
      setPlayers(gameData.players || []);
      setTransactions(txnsData.transactions || []);
      setBankInfo(bankData);
    } catch (err: any) {
      showToast(err.message || 'Failed to load game', 'error');
      setGame(null);
      setCurrentGameId(null);
    }
  }, [showToast]);

  const refreshActiveGame = useCallback(async () => {
    if (!currentGameId) return;
    try {
      const [gameData, txnsData, bankData] = await Promise.all([
        localApi(`/games/${currentGameId}`),
        localApi(`/games/${currentGameId}/ledger`),
        localApi(`/games/${currentGameId}/bank`).catch(() => null),
      ]);

      setGame(gameData);
      setPlayers(gameData.players || []);
      setTransactions(txnsData.transactions || []);
      setBankInfo(bankData);
    } catch (err: any) {
      console.warn('Background poll failed:', err.message);
    }
  }, [currentGameId]);

  // Polling every 2.5s for real-time reactivity
  useEffect(() => {
    if (!currentGameId) return;
    const interval = setInterval(() => {
      refreshActiveGame();
    }, 2500);
    return () => clearInterval(interval);
  }, [currentGameId, refreshActiveGame]);

  // Initial load
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const gameParam = urlParams.get('game');
    const targetGameId = gameParam || localStorage.getItem('banker_last_game_id');

    const init = async () => {
      if (targetGameId) {
        try {
          await loadGame(targetGameId);
          return;
        } catch (_) {}
      }
      // Fallback: list games and pick first
      try {
        const res = await localApi('/games');
        if (res.games && res.games.length > 0) {
          await loadGame(res.games[0].id);
        }
      } catch (_) {}
    };

    init();
  }, [loadGame]);

  // Keyboard shortcut: Escape closes modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeModal]);

  return (
    <GameContext.Provider
      value={{
        currentGameId,
        game,
        players,
        transactions,
        bankInfo,
        appMode,
        myPlayerId,
        soundEnabled,
        toasts,
        activeModal: modalState.name,
        modalPayload: modalState.payload,
        prevBalances: prevBalancesRef.current,
        activeTransferTab,
        customDesc,
        setCustomDesc,
        setActiveTransferTab,
        openModal,
        closeModal,
        showToast,
        toggleSound,
        setAppMode,
        setMyPlayerId,
        loadGame,
        refreshActiveGame,
      }}
    >
      {children}
    </GameContext.Provider>
  );
};

export const useGame = () => {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used within GameProvider');
  return ctx;
};
