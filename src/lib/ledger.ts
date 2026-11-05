// Ledger engine — double-entry posting, statements, round summaries.
import {
  ACCOUNT,
  accountKey,
  validCategory,
  fail,
  newId,
  nowTs,
  Dr,
  Cr,
} from './domain';
import { Account, StatementRow, Transaction, RoundSummary } from '../types';
import { GameBundle, Journal } from './db';

export function balance(bundle: GameBundle, account: Account): number {
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

export function findTxn(bundle: GameBundle, txnId: string): Transaction | null {
  return bundle.txns.find((t) => t.id === txnId) || null;
}

export function findByIdemKey(bundle: GameBundle, gameId: string, key: string): Transaction | null {
  return bundle.txns.find((t) => t.game_id === gameId && t.idempotency_key === key) || null;
}

export interface PostParams {
  amount: number;
  from: Account;
  to: Account;
  category: string;
  txnType: string;
  gameId?: string;
  round?: number;
  desc?: string;
  refTxnId?: string;
  idemKey?: string;
}

export function post(bundle: GameBundle, j: Journal, p: PostParams): { txn: Transaction; replay: boolean } {
  if (!Number.isInteger(p.amount) || p.amount <= 0) {
    throw fail('INVALID', 'amount must be > 0');
  }
  if (p.from.type === p.to.type && accountKey(p.from) === accountKey(p.to)) {
    throw fail('INVALID', 'from and to must differ');
  }
  if (!p.category || !p.txnType) {
    throw fail('INVALID', 'txn_type and account_category are required');
  }
  if (!validCategory(p.category) && p.category !== 'OPENING_BALANCE') {
    throw fail('INVALID', 'unknown account_category ' + p.category);
  }

  const game = bundle.game;
  if (!game) throw fail('NOT_FOUND', 'game not found');

  // Replay/conflict check before the status check: a retry may arrive after the
  // game finished, and returning the original txn is still correct.
  if (p.idemKey) {
    const existing = findByIdemKey(bundle, p.gameId || game.id, p.idemKey);
    if (existing) {
      if (!samePosting(existing, p, game.id)) {
        throw fail(
          'IDEMPOTENT_CONFLICT',
          `idempotency key ${p.idemKey} was already used for a different posting`
        );
      }
      return { txn: existing, replay: true };
    }
  }

  if (game.status !== 'active') {
    throw fail(
      'INVALID_STATE',
      `game ${game.id} is "${game.status}", money movement requires an active game`
    );
  }

  // Counterparties must be live, non-bankrupt players.
  for (const a of [p.from, p.to]) {
    if (a.type !== ACCOUNT.PLAYER) continue;
    const pl = bundle.players.find((x) => x.id === a.id);
    if (!pl) throw fail('NOT_FOUND', 'player not found');
    if (pl.is_bankrupt) throw fail('INVALID_STATE', 'player ' + pl.name + ' is bankrupt');
  }

  // Balance check of the paying side (equity is the virtual money source).
  if (p.from.type !== ACCOUNT.EQUITY) {
    const fromBal = balance(bundle, p.from);
    if (fromBal < p.amount) {
      throw fail(
        'INSUFFICIENT_BALANCE',
        `account ${p.from.type}/${accountKey(p.from)} holds ${fromBal} but ${p.amount} is due`
      );
    }
  }

  const txnId = newId('txn');
  const desc = p.desc || `${p.category} ${accountKey(p.from)}→${accountKey(p.to)}`;
  const entries = [
    { account_type: p.from.type, account_ref: accountKey(p.from), direction: Dr, amount: p.amount },
    { account_type: p.to.type, account_ref: accountKey(p.to), direction: Cr, amount: p.amount },
  ];
  const txn: Transaction = {
    id: txnId,
    game_id: game.id,
    txn_type: p.txnType,
    account_category: p.category,
    round: p.round || 0,
    amount: p.amount,
    description: desc,
    ref_txn_id: p.refTxnId || '',
    idempotency_key: p.idemKey || '',
    voided_by_txn: '',
    created_at: nowTs(),
    entries,
  };

  bundle.txns.push(txn);
  j.txns.push(txn);
  bumpCash(bundle, j, p.from, -p.amount);
  bumpCash(bundle, j, p.to, p.amount);

  return { txn, replay: false };
}

function samePosting(t: Transaction, p: PostParams, gameId: string): boolean {
  if (t.game_id !== gameId) return false;
  if (t.txn_type !== p.txnType) return false;
  if (t.account_category !== p.category) return false;
  if (t.amount !== p.amount) return false;
  if ((t.ref_txn_id || '') !== (p.refTxnId || '')) return false;
  if (p.round !== undefined && t.round !== (p.round || 0)) return false;

  const dr = t.entries.find((e) => e.direction === Dr);
  const cr = t.entries.find((e) => e.direction === Cr);
  return (
    !!dr &&
    !!cr &&
    dr.account_type === p.from.type &&
    dr.account_ref === accountKey(p.from) &&
    cr.account_type === p.to.type &&
    cr.account_ref === accountKey(p.to)
  );
}

function bumpCash(bundle: GameBundle, j: Journal, account: Account, delta: number): void {
  if (account.type !== ACCOUNT.PLAYER) return;
  const pl = bundle.players.find((x) => x.id === account.id);
  if (pl) {
    pl.cash = (pl.cash || 0) + delta;
    if (!j.players.includes(pl)) j.players.push(pl);
  }
}

// Statement — Dr/Cr ledger from one account's point of view (notebook layout).
export function statement(bundle: GameBundle, account: Account): StatementRow[] {
  const rows: StatementRow[] = [];
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
      voided: Boolean(t.voided_by_txn),
      created_at: t.created_at,
    });
  }
  return rows;
}

export interface ListTxnsFilter {
  category?: string;
  round?: number;
  player_id?: string;
}

export function listTxns(bundle: GameBundle, filter: ListTxnsFilter = {}): Transaction[] {
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

export function roundSummaries(bundle: GameBundle): RoundSummary[] {
  const rounds = new Set<number>(
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

export function findRoundByIdemKey(bundle: GameBundle, gid: string, key: string): number | null {
  const r = bundle.rounds.find((x) => x.game_id === gid && x.idem_key === key);
  return r ? r.round_no : null;
}
