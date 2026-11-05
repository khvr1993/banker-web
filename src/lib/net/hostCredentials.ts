// Durable host-side seat credentials. IndexedDB is the primary store;
// localStorage is a write-through fallback for private browsing / older data.

const SESSION_DB = 'banker_session_store';
const SESSION_VERSION = 1;
const STORE = 'credentials';

export interface JoinReservation {
  joinKey: string;
  playerId: string | null;
  playerToken: string;
  name: string;
  gameId: string;
  status: 'pending' | 'seated';
  createdAt: number;
}

export interface HostCredentialSnapshot {
  reservations: JoinReservation[];
  tokens: Record<string, string>; // legacy migration
}

export interface HostCredentialStore {
  load(gameId: string): Promise<HostCredentialSnapshot | null>;
  save(gameId: string, snapshot: HostCredentialSnapshot): Promise<void>;
}

function tokenKey(gameId: string): string {
  return `banker_tokens_${gameId}`;
}

function reservationKey(gameId: string): string {
  return `banker_reservations_${gameId}`;
}

function readLocalTokens(gameId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(tokenKey(gameId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [pid, token] of Object.entries(parsed)) {
      if (typeof pid === 'string' && typeof token === 'string') out[pid] = token;
    }
    return out;
  } catch {
    return {};
  }
}

function readLocalReservations(gameId: string): JoinReservation[] {
  try {
    const raw = localStorage.getItem(reservationKey(gameId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReservation);
  } catch {
    return [];
  }
}

function isReservation(value: any): value is JoinReservation {
  return (
    value &&
    typeof value.joinKey === 'string' &&
    (value.status === 'pending' || value.status === 'seated') &&
    typeof value.playerToken === 'string'
  );
}

function openSessionDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(SESSION_DB, SESSION_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

interface StoredRecord {
  id: string;
  reservations: JoinReservation[];
  tokens: Record<string, string>;
  updatedAt: number;
}

export function createHostCredentialStore(): HostCredentialStore {
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  const getDb = () => {
    if (!dbPromise) dbPromise = openSessionDb();
    return dbPromise;
  };

  return {
    async load(gameId: string): Promise<HostCredentialSnapshot | null> {
      let idbTokens: Record<string, string> = {};
      let idbReservations: JoinReservation[] = [];
      const db = await getDb();
      if (db) {
        try {
          idbTokens = await new Promise<Record<string, string>>((resolve) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(gameId);
            req.onsuccess = () => {
              const record = req.result as StoredRecord | undefined;
              resolve(record && record.tokens && typeof record.tokens === 'object' ? record.tokens : {});
            };
            req.onerror = () => resolve({});
          });
          idbReservations = await new Promise<JoinReservation[]>((resolve) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(gameId);
            req.onsuccess = () => {
              const record = req.result as StoredRecord | undefined;
              resolve(record && Array.isArray(record.reservations) ? record.reservations.filter(isReservation) : []);
            };
            req.onerror = () => resolve([]);
          });
        } catch {
          // fall through to localStorage
        }
      }

      const tokens = { ...readLocalTokens(gameId), ...idbTokens };
      const reservations = mergeReservations(idbReservations, readLocalReservations(gameId));

      // Legacy token-only maps become seated reservations against the token.
      for (const [playerId, token] of Object.entries(tokens)) {
        if (!reservations.some((r) => r.playerId === playerId)) {
          reservations.push({
            joinKey: `legacy:${playerId}`,
            playerId,
            playerToken: token,
            name: '',
            gameId,
            status: 'seated',
            createdAt: 0,
          });
        }
      }

      if (reservations.length === 0 && Object.keys(tokens).length === 0) return null;
      return { reservations, tokens };
    },

    async save(gameId: string, snapshot: HostCredentialSnapshot): Promise<void> {
      const db = await getDb();
      if (db) {
        try {
          await new Promise<void>((resolve) => {
            const tx = db.transaction(STORE, 'readwrite');
            const record: StoredRecord = {
              id: gameId,
              reservations: snapshot.reservations,
              tokens: snapshot.tokens,
              updatedAt: Date.now(),
            };
            tx.objectStore(STORE).put(record);
            tx.oncomplete = () => resolve();
            tx.onabort = () => resolve();
            tx.onerror = () => resolve();
          });
        } catch {
          // fall through to localStorage
        }
      }
      try {
        localStorage.setItem(tokenKey(gameId), JSON.stringify(snapshot.tokens));
      } catch {
        // storage unavailable
      }
      try {
        localStorage.setItem(reservationKey(gameId), JSON.stringify(snapshot.reservations));
      } catch {
        // storage unavailable
      }
    },
  };
}

function mergeReservations(primary: JoinReservation[], fallback: JoinReservation[]): JoinReservation[] {
  const out: JoinReservation[] = [];
  const seenJoin = new Set<string>();
  const seenPlayer = new Set<string>();
  for (const res of [...primary, ...fallback]) {
    if (!isReservation(res)) continue;
    if (seenJoin.has(res.joinKey)) continue;
    if (res.playerId && seenPlayer.has(res.playerId)) continue;
    seenJoin.add(res.joinKey);
    if (res.playerId) seenPlayer.add(res.playerId);
    out.push(res);
  }
  return out;
}
