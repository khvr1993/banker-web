// Storage layer — IndexedDB with atomic read-modify-write semantics.
//
// Strategy: every mutation loads the full game state in memory, applies the
// business logic synchronously, then commits ALL changes in one IndexedDB
// transaction. Callers therefore get all-or-nothing semantics with no
// interleaving — the same guarantee the Go store gets from `InTx`.

const DB_NAME = "banker_db";
const DB_VERSION = 1;

export const STORES = ["games", "players", "txns", "rounds", "audit"];

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const game = db.createObjectStore("games", { keyPath: "id" });
      const player = db.createObjectStore("players", { keyPath: "id" });
      player.createIndex("by_game", "game_id", { unique: false });
      const txn = db.createObjectStore("txns", { keyPath: "id" });
      txn.createIndex("by_game", "game_id", { unique: false });
      const round = db.createObjectStore("rounds", { keyPath: "key" });
      round.createIndex("by_game", "game_id", { unique: false });
      const audit = db.createObjectStore("audit", { keyPath: "id" });
      audit.createIndex("by_game", "game_id", { unique: false });
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

// ---- low-level helpers ----

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function allInStore(store, indexName, key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORES, "readonly");
        const os = tx.objectStore(store);
        const source = indexName ? os.index(indexName) : os;
        const req = key === undefined ? source.getAll() : source.getAll(key);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      })
  );
}

export async function listGames(status) {
  const all = await allInStore("games", undefined);
  const games = status ? all.filter((g) => g.status === status) : all.slice();
  games.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return games;
}

export async function listAllGames() {
  return allInStore("games", undefined);
}

// ---- loaded bundle (read path) ----

export async function loadGame(gameId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, "readonly");
    const get = (store, key) => reqToPromise(tx.objectStore(store).get(key));
    const getBy = (store, index, key) => reqToPromise(tx.objectStore(store).index(index).getAll(key));
    Promise.all([
      get("games", gameId),
      getBy("players", "by_game", gameId),
      getBy("txns", "by_game", gameId),
      getBy("rounds", "by_game", gameId),
      getBy("audit", "by_game", gameId),
    ]).then(
      ([game, players, txns, rounds, audit]) => {
        players = (players || []).slice().sort((a, b) => (a.seat_no || 0) - (b.seat_no || 0));
        txns = (txns || []).slice().sort((a, b) => {
          const t = String(a.created_at).localeCompare(String(b.created_at));
          return t !== 0 ? t : String(a.id).localeCompare(String(b.id));
        });
        rounds = (rounds || []).slice().sort((a, b) => (a.round_no || 0) - (b.round_no || 0));
        audit = (audit || []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        resolve({ game: game || null, players, txns, rounds, audit });
      },
      reject
    );
  });
}

export async function listDump() {
  const db = await openDb();
  const dump = {};
  for (const store of STORES) {
    const tx = db.transaction(STORES, "readonly");
    dump[store] = await reqToPromise(tx.objectStore(store).getAll());
  }
  return dump;
}

// ---- journal / commit (write path) ----

export function journal() {
  return {
    games: [],
    players: [],
    txns: [],
    rounds: [],
    audit: [],
    deletedPlayers: [], // { game_id, id }
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

export async function commit(j) {
  if (j.isEmpty()) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, "readwrite");
    const finish = () => resolve();
    tx.oncomplete = finish;
    tx.onabort = () => reject(tx.error || new Error("commit aborted"));
    tx.onerror = () => reject(tx.error || new Error("commit failed"));

    for (const g of j.games) tx.objectStore("games").put(g);
    for (const p of j.players) tx.objectStore("players").put(p);
    for (const d of j.deletedPlayers) tx.objectStore("players").delete(d.id);
    for (const t of j.txns) tx.objectStore("txns").put(t);
    for (const r of j.rounds) tx.objectStore("rounds").put(r);
    for (const a of j.audit) tx.objectStore("audit").put(a);
  });
}

export async function clearAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
    for (const s of STORES) tx.objectStore(s).clear();
  });
}

export async function restoreFromDump(dump) {
  if (!dump || dump.app !== "business-game-banker-web") {
    throw new Error("Not a Banker backup file");
  }
  if (dump.version !== 1) {
    throw new Error(`Unsupported backup version ${dump.version}`);
  }
  const data = dump.data || {};
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, "readwrite");
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
