import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Game, Player, Transaction, BankInfo, ToastMessage } from '../types';
import { gameApi, setClientSession } from '../lib/gameApi';
import { Journal, setCommitListener } from '../lib/db';
import { applyMirrorDelta, applyMirrorSnapshot, configureMirrorStorage } from '../lib/remoteDb';
import { HostSession, RemotePeerInfo } from '../lib/net/hostSession';
import { ClientSession } from '../lib/net/clientSession';
import { normalizeRoom } from '../lib/net/protocol';
import { sound } from '../lib/sound';

type SessionRole = 'local' | 'host' | 'client';
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

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
  theme: 'dark' | 'light';
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
  toggleTheme: () => void;
  setAppMode: (mode: 'banker' | 'player') => void;
  setMyPlayerId: (id: string | null) => void;
  loadGame: (id: string) => Promise<void>;
  refreshActiveGame: () => Promise<void>;
  // Multiplayer session
  sessionRole: SessionRole;
  connectionState: ConnectionState;
  roomCode: string | null;
  joinUrl: string | null;
  hostRev: number;
  remotePeers: RemotePeerInfo[];
  hostOnline: boolean;
  joinRoomToken: string | null;
  sessionError: string | null;
  sessionReady: boolean;
  joinPending: boolean;
  sessionKicked: boolean;
  latencyMs: number;
  startHosting: () => Promise<void>;
  stopHosting: () => void;
  joinSession: (room: string, name: string) => Promise<void>;
  leaveSession: () => void;
  approveJoin: (sessionId: string) => Promise<void>;
  denyJoin: (sessionId: string) => void;
  kickPeer: (sessionId: string) => void;
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

  const [sessionRole, setSessionRole] = useState<SessionRole>('local');
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [hostRev, setHostRev] = useState(0);
  const [remotePeers, setRemotePeers] = useState<RemotePeerInfo[]>([]);
  const [hostOnline, setHostOnline] = useState(false);
  const [joinRoomToken, setJoinRoomToken] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [joinPending, setJoinPending] = useState(false);
  const [sessionKicked, setSessionKicked] = useState(false);
  const [latencyMs, setLatencyMs] = useState(0);

  const hostRef = useRef<HostSession | null>(null);
  const clientRef = useRef<ClientSession | null>(null);
  const sessionRoleRef = useRef<SessionRole>('local');
  const currentGameIdRef = useRef<string | null>(null);
  const hostEpochRef = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const autoHostTriedRef = useRef<string | null>(null);
  const hostStartingRef = useRef(false);

  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    return localStorage.getItem('banker_sound') !== 'false';
  });

  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('banker_theme');
    return saved === 'light' ? 'light' : 'dark';
  });

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.classList.toggle('light', theme === 'light');
    root.classList.toggle('dark', theme === 'dark');
  }, [theme]);

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

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('banker_theme', next);
      return next;
    });
  }, []);

  const setAppMode = useCallback((mode: 'banker' | 'player') => {
    const next = sessionRoleRef.current === 'client' ? 'player' : mode;
    setAppModeState(next);
    if (next === 'player') setActiveTransferTab('custom');
    localStorage.setItem('banker_app_mode', next);
    if (next === 'banker') {
      setActiveTransferTab((prev) => (prev !== 'bank-pay' && prev !== 'custom' ? 'bank-pay' : prev));
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

  const teardownHost = useCallback(
    (
      options: { code?: 'host-stopped' | 'game-switched'; reason?: string } = {},
      gameId: string | null = currentGameIdRef.current
    ) => {
      const session = hostRef.current;
      hostRef.current = null;
      session?.stop(options);
      setCommitListener(null);
      setRemotePeers([]);
      setHostOnline(false);
      setHostRev(0);
      setRoomCode(null);
      setJoinUrl(null);
      setConnectionState('idle');
      sessionRoleRef.current = 'local';
      setSessionRole('local');
      if (gameId) {
        try {
          localStorage.removeItem('banker_hosting_' + gameId);
        } catch {
          // ignore storage failures
        }
      }
    },
    []
  );

  const loadGame = useCallback(async (gameId: string) => {
    const previous = currentGameIdRef.current;
    if (hostRef.current && previous && previous !== gameId) {
      teardownHost(
        { code: 'game-switched', reason: 'The banker opened another game' },
        previous
      );
      showToast('Hosted session stopped because you opened another game', 'info');
    } else if (sessionRoleRef.current === 'host' && !hostRef.current) {
      // Cancel an in-flight start that would otherwise bind the old game.
      hostEpochRef.current += 1;
    }
    currentGameIdRef.current = gameId;

    try {
      setCurrentGameId(gameId);
      localStorage.setItem('banker_last_game_id', gameId);

      if (sessionRoleRef.current !== 'client') {
        const savedPlayer = localStorage.getItem('banker_player_id_' + gameId);
        if (savedPlayer) {
          setMyPlayerIdState(savedPlayer);
        }
      }

      const [gameData, txnsData, bankData] = await Promise.all([
        gameApi(`/games/${gameId}`),
        gameApi(`/games/${gameId}/ledger`),
        gameApi(`/games/${gameId}/bank`).catch(() => null),
      ]);

      setGame(gameData);
      setPlayers(gameData.players || []);
      setTransactions(txnsData.transactions || []);
      setBankInfo(bankData);
    } catch (err: any) {
      showToast(err.message || 'Failed to load game', 'error');
      setGame(null);
      setCurrentGameId(null);
      currentGameIdRef.current = null;
    }
  }, [showToast, teardownHost]);

  const refreshActiveGame = useCallback(async () => {
    if (!currentGameId) return;
    try {
      const [gameData, txnsData, bankData] = await Promise.all([
        gameApi(`/games/${currentGameId}`),
        gameApi(`/games/${currentGameId}/ledger`),
        gameApi(`/games/${currentGameId}/bank`).catch(() => null),
      ]);

      setGame(gameData);
      setPlayers(gameData.players || []);
      setTransactions(txnsData.transactions || []);
      setBankInfo(bankData);
    } catch (err: any) {
      console.warn('Background poll failed:', err.message);
    }
  }, [currentGameId]);

  useEffect(() => {
    refreshRef.current = refreshActiveGame;
  }, [refreshActiveGame]);

  // Local/host poll fast; clients are delta-driven with a slow repair poll.
  useEffect(() => {
    if (!currentGameId) return;
    const interval = setInterval(
      () => {
        refreshActiveGame();
      },
      sessionRole === 'client' ? 10000 : 2500
    );
    return () => clearInterval(interval);
  }, [currentGameId, refreshActiveGame, sessionRole]);

  const applySessionRole = useCallback((role: SessionRole) => {
    sessionRoleRef.current = role;
    setSessionRole(role);
  }, []);

  const startHosting = useCallback(async () => {
    if (hostRef.current || hostStartingRef.current) return;
    if (!game || !currentGameId) {
      showToast('Open a game before hosting a session', 'error');
      return;
    }
    hostStartingRef.current = true;
    const gameId = currentGameId;
    const epoch = ++hostEpochRef.current;
    try {
      setConnectionState('connecting');
      let publicBaseUrl: string | undefined;
      try {
        publicBaseUrl = localStorage.getItem('banker_public_url') || undefined;
      } catch {
        publicBaseUrl = undefined;
      }
      const session = await HostSession.start({
        room: game.join_token,
        gameId,
        publicBaseUrl,
        onPeersChanged: (peers) => setRemotePeers(peers),
        onJoinRequest: (peer) =>
          showToast(
            peer.kicked
              ? `${peer.name} was removed and wants to rejoin`
              : `${peer.name} wants to join`,
            'info',
            6000
          ),
        onError: (msg) => showToast(msg, 'error'),
        onLog: (msg) => console.info('[host]', msg),
      });
      if (epoch !== hostEpochRef.current || currentGameIdRef.current !== gameId) {
        session.stop({ notify: false });
        setConnectionState('idle');
        return;
      }
      hostRef.current = session;
      applySessionRole('host');
      setRoomCode(session.room);
      setJoinUrl(session.joinUrl);
      setConnectionState('connected');
      setHostOnline(true);
      setCommitListener((j: Journal) => {
        hostRef.current?.broadcastJournal(j);
        setHostRev(hostRef.current?.hostRev ?? 0);
        void refreshRef.current();
      });
      try {
        localStorage.setItem('banker_hosting_' + gameId, '1');
      } catch {
        // ignore storage failures
      }
      showToast('Session live — share the join link with players', 'success', 5000);
    } catch (err: any) {
      setConnectionState('error');
      const message =
        err?.type === 'browser-incompatible'
          ? 'This browser does not support WebRTC multiplayer'
          : err?.message || 'Could not start the hosted session';
      showToast(message, 'error');
    } finally {
      hostStartingRef.current = false;
    }
  }, [game, currentGameId, applySessionRole, showToast]);

  const stopHosting = useCallback(() => {
    teardownHost({
      code: 'host-stopped',
      reason: 'The banker ended the session',
    });
    showToast('Hosted session stopped', 'info');
  }, [teardownHost, showToast]);

  // Host reload recovery: resume hosting so reconnecting phones resync.
  useEffect(() => {
    if (!game || !currentGameId || sessionRole !== 'local' || hostRef.current) return;
    if (autoHostTriedRef.current === currentGameId) return;
    let flagged = false;
    try {
      flagged = localStorage.getItem('banker_hosting_' + currentGameId) === '1';
    } catch {
      flagged = false;
    }
    if (!flagged) return;
    autoHostTriedRef.current = currentGameId;
    void startHosting();
  }, [game, currentGameId, sessionRole, startHosting]);

  const joinSession = useCallback(
    async (room: string, name: string) => {
      const cleanRoom = normalizeRoom(room);
      if (!cleanRoom) {
        setSessionError('Enter a valid room code or join link');
        return;
      }
      clientRef.current?.leave();
      clientRef.current = null;
      configureMirrorStorage();
      applySessionRole('client');
      setAppModeState('player');
      setActiveTransferTab('custom');
      setSessionReady(false);
      setSessionError(null);
      setJoinPending(false);
      setSessionKicked(false);
      setConnectionState('connecting');
      setJoinRoomToken(cleanRoom);
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('join', cleanRoom);
        window.history.replaceState(null, '', url.toString());
      } catch {
        // ignore history failures
      }

      let session: ClientSession | null = null;
      // A kick fires onKicked, then onRejected/onError from failJoin. Keep the
      // friendlier "removed" copy instead of letting later callbacks overwrite it.
      let wasKicked = false;
      try {
        session = await ClientSession.create(cleanRoom, {
          onSnapshot: async (snapshot, gameId) => {
            await applyMirrorSnapshot(snapshot);
            if (gameId) {
              try {
                await loadGame(gameId);
              } catch (err) {
                console.warn('Mirror load failed:', err);
              }
            }
            setHostOnline(true);
          },
          onDelta: async (journal) => {
            await applyMirrorDelta(journal);
            await refreshRef.current();
          },
          onStatus: (state) => {
            setConnectionState(state);
            setHostOnline(state === 'connected');
            if (state === 'connected') setLatencyMs(session?.latencyMs ?? 0);
            else setLatencyMs(0);
          },
          onLatency: (ms) => setLatencyMs(ms),
          onJoined: (info) => {
            wasKicked = false;
            setMyPlayerIdState(info.playerId);
            setSessionReady(true);
            setJoinPending(false);
            setSessionKicked(false);
            setSessionError(null);
            setHostOnline(true);
            setLatencyMs(session?.latencyMs ?? 0);
          },
          onPending: () => {
            setJoinPending(true);
            setConnectionState('connecting');
          },
          onKicked: () => {
            wasKicked = true;
            setJoinPending(false);
            setSessionKicked(true);
            setSessionError(
              'The banker removed this device from the table. Ask to rejoin and they can let you back in.'
            );
            setConnectionState('error');
            setSessionReady(false);
          },
          onRejected: (reason) => {
            if (wasKicked) return;
            setJoinPending(false);
            setSessionError(reason);
            setConnectionState('error');
            setSessionReady(false);
          },
          onEvent: (event) => {
            if (event.kind === 'round') {
              sound.playRoundBell();
              showToast(event.round ? `Round ${event.round} started` : 'A new round started', 'info');
            } else if (event.kind === 'void') {
              sound.playVoid();
              showToast('A transaction was voided by the banker', 'info');
            } else if (event.description) {
              sound.playCoin();
              showToast(event.description, 'success', 2500);
            }
          },
          onError: (message) => {
            if (!wasKicked) setSessionError(message);
          },
        });
        clientRef.current = session;
        setClientSession(session);
        await session.join(name);
        const gameId = session.currentGameId;
        if (gameId) await loadGame(gameId);
        setSessionReady(true);
        setConnectionState('connected');
      } catch (err: any) {
        if (session && clientRef.current === session) {
          session.leave();
          clientRef.current = null;
          setClientSession(null);
        }
        setSessionError(err?.message || 'Could not join the session');
        setConnectionState('error');
        setSessionReady(false);
      }
    },
    [applySessionRole, loadGame, showToast]
  );

  const leaveSession = useCallback(() => {
    clientRef.current?.leave();
    clientRef.current = null;
    setClientSession(null);
    // Keep the stored joinKey: leaving does not revoke the seat.
    setSessionReady(false);
    setJoinPending(false);
    setSessionKicked(false);
    setConnectionState('idle');
    setSessionError(null);
    window.location.assign(window.location.pathname);
  }, []);

  const approveJoin = useCallback(
    async (sessionId: string) => {
      try {
        await hostRef.current?.approve(sessionId);
        await refreshRef.current();
      } catch (err: any) {
        showToast(err.message || 'Failed to approve the player', 'error');
      }
    },
    [showToast]
  );

  const denyJoin = useCallback((sessionId: string) => {
    hostRef.current?.deny(sessionId);
  }, []);

  const kickPeer = useCallback((sessionId: string) => {
    hostRef.current?.kick(sessionId);
  }, []);

  // Stop transports when the provider unmounts.
  useEffect(() => {
    return () => {
      // A page reload/unmount is not an explicit stop: close silently so
      // players reconnect instead of seeing a terminal bye.
      hostRef.current?.stop({ notify: false });
      clientRef.current?.leave();
      setCommitListener(null);
    };
  }, []);

  // Initial load: ?join boots a player session against the mirror database;
  // otherwise keep the existing local/last-game behavior.
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const joinParam = urlParams.get('join');
    if (joinParam) {
      const room = normalizeRoom(joinParam);
      configureMirrorStorage();
      sessionRoleRef.current = 'client';
      setSessionRole('client');
      setJoinRoomToken(room);
      setAppModeState('player');
      setActiveTransferTab('custom');
      // Do not mark the session as connecting here: on a fresh device no
      // join has been attempted yet. JoinSessionView enables the form and
      // starts the attempt when the player submits it. Marking it connecting
      // here disabled the name field and hung on "Connecting…" forever.
      setConnectionState('idle');
      return;
    }

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
        const res = await gameApi('/games');
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
        theme,
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
        toggleTheme,
        setAppMode,
        setMyPlayerId,
        loadGame,
        refreshActiveGame,
        sessionRole,
        connectionState,
        roomCode,
        joinUrl,
        hostRev,
        remotePeers,
        hostOnline,
        joinRoomToken,
        sessionError,
        sessionReady,
        joinPending,
        sessionKicked,
        latencyMs,
        startHosting,
        stopHosting,
        joinSession,
        leaveSession,
        approveJoin,
        denyJoin,
        kickPeer,
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
