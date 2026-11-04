// Local "REST" router — implements the exact /api/v1 contract of the Go
// service against the browser database. The UI keeps talking to paths like
// "/games" and "/games/:id/players"; nothing reaches the network.

import {
  ACCOUNT_CATEGORIES,
  DomainError,
  errorStatus,
  isDomainError,
} from "./domain.js";
import {
  loadGame,
  listGames,
  journal,
  commit,
  listDump,
  restoreFromDump,
} from "./db.js";
import * as svc from "./service.js";
import {
  gameView,
} from "./service.js";
import { listTxns } from "./ledger.js";

// ---- response shaping ----

export class ApiError extends Error {
  constructor(kind, detail, status) {
    super(detail);
    this.name = "ApiError";
    this.status = status ?? errorStatus(kind);
    this.type = kind;
  }
}

function toApiError(e) {
  if (isDomainError(e)) return new ApiError(e.kind, e.detail, errorStatus(e.kind));
  console.error("Unexpected local API error:", e);
  return new ApiError("INTERNAL", "internal error", 500);
}

// ---- serialized access: every call queues behind the previous one ----

let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

// ---- helpers ----

const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, "'")}"`;

export function buildCsv(bundle) {
  const header = "txn_id,txn_type,account_category,round,amount,from,from_type,to,to_type,description,created_at,voided\n";
  const rows = [];
  for (const t of bundle.txns) {
    let from = "", to = "", fromT = "", toT = "";
    for (const ln of t.entries) {
      if (ln.direction === "DR") { from = ln.account_ref; fromT = ln.account_type; }
      else { to = ln.account_ref; toT = ln.account_type; }
    }
    const created = t.created_at ? (t.created_at.includes("Z") ? t.created_at : t.created_at + "Z") : "";
    rows.push(
      [
        t.id, t.txn_type, t.account_category, t.round, t.amount,
        from, fromT, to, toT,
        csvEscape(t.description), created, String(!!t.voided_by_txn),
      ].join(",")
    );
  }
  return header + rows.join("\n") + (rows.length ? "\n" : "");
}

export async function downloadGameCsv(gameId) {
  const bundle = await loadGame(gameId);
  if (!bundle.game) throw toApiError(new Error("game not found"));
  const blob = new Blob([buildCsv(bundle)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ledger.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---- backup / restore of the whole database ----

export async function exportBackup() {
  const data = await listDump();
  const payload = {
    app: "business-game-banker-web",
    version: 1,
    exported_at: new Date().toISOString(),
    data,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `banker-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function importBackup(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Backup file is not valid JSON");
  }
  await restoreFromDump(parsed);
  return true;
}

// ---- the router ----

async function route(method, path, query, body, headers) {
  const parts = path.split("/").filter(Boolean);

  const health = () => ({ status: "ok", service: "business-game-banker", storage: "local" });
  const categories = () => ({ account_categories: ACCOUNT_CATEGORIES });

  // /games collection
  if (parts[0] === "health" && parts.length === 1 && method === "GET") return health();
  if (parts[0] === "meta" && parts[1] === "categories" && method === "GET") return categories();

  if (parts[0] === "games") {
    // POST /games
    if (parts.length === 1 && method === "POST") {
      const g = svc.createGame(body);
      const j = journal();
      j.games.push(g);
      await commit(j);
      const view = { ...g, bank_balance: 0, players: [] };
      if (view.players.length === 0) delete view.players;
      return view;
    }
    // GET /games
    if (parts.length === 1 && method === "GET") {
      const status = new URLSearchParams(query).get("status") || undefined;
      const games = await listGames(status);
      return { games };
    }
    const gid = parts[1];
    const game = await loadGame(gid);

    // GET /games/:id
    if (parts.length === 2 && method === "GET") {
      if (!game.game) throw toApiError(new DomainError("NOT_FOUND", "game not found"));
      return gameView(game);
    }
    // PATCH /games/:id
    if (parts.length === 2 && method === "PATCH") {
      const j = journal();
      const salary = body?.round_salary ?? null;
      const view = svc.patchGame(game, j, gid, salary);
      await commit(j);
      return view;
    }
    // POST start / finish
    if (parts.length === 3 && method === "POST" && parts[2] === "start") {
      const j = journal();
      const view = svc.startGame(game, j);
      await commit(j);
      return view;
    }
    if (parts.length === 3 && method === "POST" && parts[2] === "finish") {
      const j = journal();
      const view = svc.finishGame(game, j);
      await commit(j);
      return view;
    }
    // GET ledger
    if (parts.length === 3 && method === "GET" && parts[2] === "ledger") {
      const q = new URLSearchParams(query);
      const round = Number(q.get("round") || 0) | 0;
      return {
        transactions: listTxns(game, {
          category: q.get("account_category") || undefined,
          round: round > 0 ? round : undefined,
          player_id: q.get("player_id") || undefined,
        }),
      };
    }
    // ---- players ----
    if (parts.length === 3 && parts[2] === "players" && method === "POST") {
      const j = journal();
      const p = svc.addPlayer(game, j, gid, body?.name, body?.seat);
      await commit(j);
      return p;
    }
    if (parts[2] === "players" && parts.length >= 4) {
      const pid = parts[3];
      if (parts.length === 4 && method === "DELETE") {
        const j = journal();
        svc.removePlayer(game, j, gid, pid);
        await commit(j);
        return null;
      }
      if (parts.length === 4 && method === "GET") {
        return svc.playerView(game, pid);
      }
      if (parts.length === 5 && parts[4] === "ledger" && method === "GET") {
        const view = svc.playerView(game, pid);
        return { statement: view.statement };
      }
      if (parts.length === 5 && parts[4] === "bankrupt" && method === "POST") {
        const j = journal();
        const view = svc.declareBankrupt(game, j, gid, pid);
        await commit(j);
        return view;
      }
    }
    // ---- rounds ----
    if (parts.length === 3 && parts[2] === "rounds" && method === "POST") {
      const j = journal();
      const idem = headers?.["Idempotency-Key"] || headers?.["idempotency-key"] || "";
      const out = svc.startRound(game, j, gid, idem);
      await commit(j);
      return out;
    }
    if (parts.length === 3 && parts[2] === "rounds" && method === "GET") {
      return { rounds: svc.listRounds(game) };
    }
    if (parts.length === 4 && parts[2] === "rounds" && method === "GET") {
      const round = Number(parts[3]);
      if (!Number.isInteger(round) || round <= 0) {
        throw toApiError(new DomainError("INVALID", "round number must be a positive integer"));
      }
      return svc.roundDetail(game, round);
    }
    // ---- transfers ----
    if (parts.length === 3 && parts[2] === "transfers" && method === "POST") {
      const j = journal();
      const idem = headers?.["Idempotency-Key"] || headers?.["idempotency-key"] || "";
      const txn = svc.transfer(game, j, gid, body, idem);
      await commit(j);
      return txn;
    }
    if (parts.length === 3 && parts[2] === "transfers" && method === "GET") {
      const q = new URLSearchParams(query);
      const round = Number(q.get("round") || 0) | 0;
      return {
        transactions: listTxns(game, {
          category: q.get("account_category") || undefined,
          round: round > 0 ? round : undefined,
          player_id: q.get("player_id") || undefined,
        }),
      };
    }
    if (parts.length === 5 && parts[2] === "transfers" && parts[4] === "void" && method === "POST") {
      const j = journal();
      const txn = svc.voidTxn(game, j, gid, parts[3]);
      await commit(j);
      return txn;
    }
    // ---- bank ----
    if (parts.length === 3 && parts[2] === "bank" && method === "GET") {
      return svc.bankInfo(game);
    }
  }

  throw toApiError(new DomainError("NOT_FOUND", `no local route for ${method} ${path}`));
}

// path may carry a query string (e.g. "/games?status=active")
export async function localApi(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = options.headers || {};
  let body = options.body;
  if (typeof body === "string" && body) {
    try { body = JSON.parse(body); } catch { body = undefined; }
  }
  const i = path.indexOf("?");
  const clean = i === -1 ? path : path.slice(0, i);
  const query = i === -1 ? "" : path.slice(i + 1);

  return enqueue(async () => {
    try {
      return await route(method, clean, query, body, headers);
    } catch (e) {
      throw e instanceof ApiError ? e : toApiError(e);
    }
  });
}
