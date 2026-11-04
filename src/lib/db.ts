// Storage layer — IndexedDB with atomic read-modify-write semantics.
import { Game, Player, Transaction, RoundRecord, AuditRecord } from '../types';

const DB_NAME = 'banker_db';
const DB_VERSION = 1;

export const STORES = ['games', 'players', 'txns', 'rounds', 'audit'] as const;
export type StoreName = typeof STORES[number];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('games', { keyPath: 'id' });
      const player = db.createObjectStore('players', { keyPath: 'id' });
      player.createIndex('by_game', 'game_id', { unique: false });
      const txn = db.createObjectStore('txns', { keyPath: 'id' });
      txn.createIndex('by_game', 'game_id', { unique: false });
      const round = db.createObjectStore('rounds', { keyPath: 'key' });
      round.createIndex('by_game', 'game_id', { unique: false });
      const audit = db.createObjectStore('audit', { keyPath: 'id' });
      audit.createIndex('by_game', 'game_id', { unique: false });
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function allInStore<T>(store: StoreName, indexName?: string, key?: IDBValidKey): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORES as unknown as string[], 'readonly');
        const os = tx.objectStore(store);
        const source = indexName ? os.index(indexName) : os;
        const req = key === undefined ? source.getAll() : source.getAll(key);
        req.onsuccess = () => resolve((req.result as T[]) || []);
        req.onerror = () => reject(req.error);
      })
  );
}

export async function listGames(status?: string): Promise<Game[]> {
  const all = await allInStore<Game>('games');
  const games = status ? all.filter((g) => g.status === status) : all.slice();
  games.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return games;
}

export async function listAllGames(): Promise<Game[]> {
  return allInStore<Game>('games');
}

export interface GameBundle {
  game: Game | null;
  players: Player[];
  txns: Transaction[];
  rounds: RoundRecord[];
  audit: AuditRecord[];
}

export async function loadGame(gameId: string): Promise<GameBundle> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES as unknown as string[], 'readonly');
    const get = <T>(store: StoreName, key: IDBValidKey) => reqToPromise<T>(tx.objectStore(store).get(key) as IDBRequest<T>);
    const getBy = <T>(store: StoreName, index: string, key: IDBValidKey) =>
      reqToPromise<T[]>(tx.objectStore(store).index(index).getAll(key) as IDBRequest<T[]>);

    Promise.all([
      get<Game>('games', gameId),
      getBy<Player>('players', 'by_game', gameId),
      getBy<Transaction>('txns', 'by_game', gameId),
      getBy<RoundRecord>('rounds', 'by_game', gameId),
      getBy<AuditRecord>('audit', 'by_game', gameId),
    ]).then(
      ([game, players, txns, rounds, audit]) => {
        const sortedPlayers = (players || []).slice().sort((a, b) => (a.seat_no || 0) - (b.seat_no || 0));
        const sortedTxns = (txns || []).slice().sort((a, b) => {
          const t = String(a.created_at).localeCompare(String(b.created_at));
          return t !== 0 ? t : String(a.id).localeCompare(String(b.id));
        });
        const sortedRounds = (rounds || []).slice().sort((a, b) => (a.round_no || 0) - (b.round_no || 0));
        const sortedAudit = (audit || []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        resolve({ game: game || null, players: sortedPlayers, txns: sortedTxns, rounds: sortedRounds, audit: sortedAudit });
      },
      reject
    );
  });
}

export async function listDump(): Promise<Record<string, unknown[]>> {
  const db = await openDb();
  const dump: Record<string, unknown[]> = {};
  for (const store of STORES) {
    const tx = db.transaction(STORES as unknown as string[], 'readonly');
    dump[store] = await reqToPromise(tx.objectStore(store).getAll());
  }
  return dump;
}

export interface Journal {
  games: Game[];
  players: Player[];
  txns: Transaction[];
  rounds: RoundRecord[];
  audit: AuditRecord[];
  deletedPlayers: { game_id: string; id: string }[];
  isEmpty: () => boolean;
}

export function journal(): Journal {
  return {
    games: [],
    players: [],
    txns: [],
    rounds: [],
    audit: [],
    deletedPlayers: [],
    isEmpty() {
      return (
        this.games.length === 0 &&
        this.players.length === 0 &&
        this.txns.length === 0 &&
        this.rounds.length === 0 &&
        this.audit.length === 0 &&
        this.deletedPlayers.length === 0
      );
    },
  };
}

export async function commit(j: Journal): Promise<void> {
  if (j.isEmpty()) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES as unknown as string[], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('commit aborted'));
    tx.onerror = () => reject(tx.error || new Error('commit failed'));

    for (const g of j.games) tx.objectStore('games').put(g);
    for (const p of j.players) tx.objectStore('players').put(p);
    for (const d of j.deletedPlayers) tx.objectStore('players').delete(d.id);
    for (const t of j.txns) tx.objectStore('txns').put(t);
    for (const r of j.rounds) tx.objectStore('rounds').put(r);
    for (const a of j.audit) tx.objectStore('audit').put(a);
  });
}

export async function clearAll(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES as unknown as string[], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
    for (const s of STORES) tx.objectStore(s).clear();
  });
}

export interface DumpPayload {
  app: string;
  version: number;
  exported_at: string;
  data: Record<string, unknown[]>;
}

export async function restoreFromDump(dump: DumpPayload): Promise<void> {
  if (!dump || dump.app !== 'business-game-banker-web') {
    throw new Error('Not a Banker backup file');
  }
  if (dump.version !== 1) {
    throw new Error(`Unsupported backup version ${dump.version}`);
  }
  const data = dump.data || {};
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES as unknown as string[], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
    for (const s of STORES) {
      const os = tx.objectStore(s);
      os.clear();
      for (const row of data[s] || []) os.put(row);
    }
  });
}
