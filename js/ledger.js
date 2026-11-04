// Ledger engine — double-entry posting, statements, round summaries.
// Port of internal/ledger (post.go, read.go) working on the in-memory bundle.

import {
  ACCOUNT,
  accountKey,
  validCategory,
  fail,
  newId,
  nowTs,
  Dr,
  Cr,
} from "./domain.js";

export function balance(bundle, account) {
  let bal = 0;
  const at = account.type;
  const ref = accountKey(account);
  for (const t of bundle.txns) {
    for (const ln of t.entries) {
      if (ln.account_type === at && ln.account_ref === ref) {
        bal += ln.direction === Cr ? ln.amount : -ln.amount;
      }
    }
  }
  return bal;
}

export function findTxn(bundle, txnId) {
  return bundle.txns.find((t) => t.id === txnId) || null;
}

export function findByIdemKey(bundle, gameId, key) {
  return bundle.txns.find((t) => t.game_id === gameId && t.idempotency_key === key) || null;
}

// Post books one atomic money movement (DEBIT on From, CREDIT on To).
// Mutates the bundle and the journal so sequential posts in the same
// operation see each other's effects. Returns { txn, replay }.
export function post(bundle, j, p) {
  if (!Number.isInteger(p.amount) || p.amount <= 0) {
    throw fail("INVALID", "amount must be > 0");
  }
  if (p.from.type === p.to.type && accountKey(p.from) === accountKey(p.to)) {
    throw fail("INVALID", "from and to must differ");
  }
  if (!p.category || !p.txnType) {
    throw fail("INVALID", "txn_type and account_category are required");
  }
  if (!validCategory(p.category) && p.category !== "OPENING_BALANCE") {
    throw fail("INVALID", "unknown account_category " + p.category);
  }

  const game = bundle.game;
  if (!game) throw fail("NOT_FOUND", "game not found");
  if (game.status !== "active") {
    throw fail("INVALID_STATE",
      `game ${game.id} is "${game.status}", money movement requires an active game`);
  }

  // Idempotent replay: same key returns the already-posted txn unchanged.
  if (p.idemKey) {
    const existing = findByIdemKey(bundle, p.gameId || game.id, p.idemKey);
    if (existing) return { txn: existing, replay: true };
  }

  // Counterparties must be live, non-bankrupt players.
  for (const a of [p.from, p.to]) {
    if (a.type !== ACCOUNT.PLAYER) continue;
    const pl = bundle.players.find((x) => x.id === a.id);
    if (!pl) throw fail("NOT_FOUND", "player not found");
    if (pl.is_bankrupt) throw fail("INVALID_STATE", "player " + pl.name + " is bankrupt");
  }

  // Balance check of the paying side (equity is the virtual money source).
  if (p.from.type !== ACCOUNT.EQUITY) {
    const fromBal = balance(bundle, p.from);
    if (fromBal < p.amount) {
      throw fail("INSUFFICIENT_BALANCE",
        `account ${p.from.type}/${accountKey(p.from)} holds ${fromBal} but ${p.amount} is due`);
    }
  }

  const txnId = newId("txn");
  const desc = p.desc || `${p.category} ${accountKey(p.from)}→${accountKey(p.to)}`;
  const entries = [
    { account_type: p.from.type, account_ref: accountKey(p.from), direction: Dr, amount: p.amount },
    { account_type: p.to.type, account_ref: accountKey(p.to), direction: Cr, amount: p.amount },
  ];
  const txn = {
    id: txnId,
    game_id: game.id,
    txn_type: p.txnType,
    account_category: p.category,
    round: p.round || 0,
    amount: p.amount,
    description: desc,
    ref_txn_id: p.refTxnId || "",
    idempotency_key: p.idemKey || "",
    voided_by_txn: "",
    created_at: nowTs(),
    entries,
  };

  // Apply to bundle (so sequential posts in this operation see updated state)
  // and journal for persistence.
  bundle.txns.push(txn);
  j.txns.push(txn);
  bumpCash(bundle, j, p.from, -p.amount);
  bumpCash(bundle, j, p.to, p.amount);

  return { txn, replay: false };
}

function bumpCash(bundle, j, account, delta) {
  if (account.type !== ACCOUNT.PLAYER) return;
  const pl = bundle.players.find((x) => x.id === account.id);
  if (pl) {
    pl.cash = (pl.cash || 0) + delta;
    if (!j.players.includes(pl)) j.players.push(pl);
  }
}

// Statement — Dr/Cr ledger from one account's point of view (notebook layout).
export function statement(bundle, account) {
  const rows = [];
  const at = account.type;
  const ref = accountKey(account);
  for (const t of bundle.txns) {
    const mine = t.entries.find((l) => l.account_type === at && l.account_ref === ref);
    if (!mine) continue;
    const other = t.entries.find((l) => l !== mine) || mine;
    rows.push({
      txn_id: t.id,
      account_category: t.account_category,
      round: t.round,
      amount: t.amount,
      dr: mine.direction === Dr ? mine.amount : 0,
      cr: mine.direction === Cr ? mine.amount : 0,
      counterparty: other.account_ref,
      counterparty_type: other.account_type,
      description: t.description,
      voided: !!t.voided_by_txn,
      created_at: t.created_at,
    });
  }
  return rows;
}

// Txns with ledger filters used by /games/{id}/ledger & /transfers.
export function listTxns(bundle, filter = {}) {
  return bundle.txns.filter((t) => {
    if (filter.category && t.account_category !== filter.category) return false;
    if (filter.round && t.round !== filter.round) return false;
    if (filter.player_id) {
      const hit = t.entries.some(
        (l) => l.account_type === ACCOUNT.PLAYER && l.account_ref === filter.player_id
      );
      if (!hit) return false;
    }
    return true;
  });
}

// Round summaries — union of recorded rounds and rounds with money movement
// (so a zero-salary round still appears), excluding round 0.
export function roundSummaries(bundle) {
  const rounds = new Set(
    bundle.rounds.filter((r) => r.round_no > 0).map((r) => r.round_no)
  );
  for (const t of bundle.txns) {
    if (t.round > 0) rounds.add(t.round);
  }
  return [...rounds].sort((a, b) => a - b).map((round) => {
    const inRound = bundle.txns.filter((t) => t.round === round);
    return {
      round,
      txn_count: inRound.length,
      total_moved: inRound.reduce((s, t) => s + t.amount, 0),
    };
  });
}

export function findRoundByIdemKey(bundle, gid, key) {
  const r = bundle.rounds.find((x) => x.game_id === gid && x.idem_key === key);
  return r ? r.round_no : null;
}
