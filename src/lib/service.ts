// Service layer — business flows port.
import {
  ACCOUNT,
  GAME_STATUS,
  fail,
  newId,
  nowTs,
  accountKey,
  transferValidate,
} from './domain';
import {
  balance,
  post,
  findTxn,
  findByIdemKey,
  listTxns,
  roundSummaries,
  findRoundByIdemKey,
  statement,
} from './ledger';
import { Game, Player, Transaction, BankInfo, RoundSummary, StatementRow } from '../types';
import { GameBundle, Journal } from './db';

const NAME_RE = /^\S(.*\S)?$/;
export const validName = (n: string): boolean => typeof n === 'string' && n.length <= 64 && NAME_RE.test(n);
export const activePlayers = (ps: Player[]): Player[] => ps.filter((p) => !p.is_bankrupt);

// ---------- reads ----------

export interface GameViewResult extends Game {
  players: Player[];
  bank_balance: number;
}

export function gameView(bundle: GameBundle): GameViewResult {
  const g = bundle.game;
  if (!g) throw fail('NOT_FOUND', 'game not found');
  const players = bundle.players.slice().sort((a, b) => (a.seat_no || 0) - (b.seat_no || 0));
  return {
    ...g,
    players,
    bank_balance: balance(bundle, { type: ACCOUNT.BANK }),
  };
}

export interface PlayerViewResult extends Player {
  statement: StatementRow[];
}

export function playerView(bundle: GameBundle, pid: string): PlayerViewResult {
  const p = bundle.players.find((x) => x.id === pid);
  if (!p) throw fail('NOT_FOUND', 'player not found');
  return {
    ...p,
    statement: statement(bundle, { type: ACCOUNT.PLAYER, id: pid }),
  };
}

export function bankInfo(bundle: GameBundle): BankInfo {
  if (!bundle.game) throw fail('NOT_FOUND', 'game not found');
  const active = activePlayers(bundle.players);
  return {
    game_id: bundle.game.id,
    bank_balance: balance(bundle, { type: ACCOUNT.BANK }),
    currency: bundle.game.currency,
    players_active: active.length,
    players_bankrupt: bundle.players.length - active.length,
  };
}

// ---------- game lifecycle ----------

export interface CreateGameInput {
  name?: string;
  starting_cash?: number;
  initial_bank_balance?: number;
  salary_per_round?: number;
  currency?: string;
}

export function createGame(input?: CreateGameInput): Game {
  const req = input || {};
  const startingCash = Number(req.starting_cash);
  const initialBank = Number(req.initial_bank_balance);
  const salary = Number(req.salary_per_round);
  if (!Number.isInteger(startingCash) || startingCash <= 0) {
    throw fail('INVALID', 'starting_cash must be > 0');
  }
  if (!Number.isInteger(initialBank) || initialBank <= 0) {
    throw fail('INVALID', 'initial_bank_balance must be > 0');
  }
  if (!Number.isInteger(salary) || salary < 0) {
    throw fail('INVALID', 'salary_per_round cannot be negative');
  }
  if (!validName(String(req.name || '').trim())) {
    throw fail('INVALID', 'name must be 1..64 printable characters');
  }
  const currency = String(req.currency || '').trim() || '₹';

  return {
    id: newId('game'),
    name: String(req.name).trim(),
    status: GAME_STATUS.PENDING,
    starting_cash: startingCash,
    initial_bank_balance: initialBank,
    salary_per_round: salary,
    current_round: 0,
    currency,
    join_token: newId('join'),
    created_at: nowTs(),
    ended_at: '',
  };
}

export function patchGame(
  bundle: GameBundle,
  j: Journal,
  gid: string,
  salary: number | null,
  actor = 'banker'
): GameViewResult {
  const g = bundle.game;
  if (!g) throw fail('NOT_FOUND', 'game not found');
  if (g.status === GAME_STATUS.FINISHED) {
    throw fail('INVALID_STATE', 'cannot modify a finished game');
  }
  if (salary != null) {
    if (!Number.isInteger(Number(salary)) || Number(salary) < 0) {
      throw fail('INVALID', 'salary_per_round cannot be negative');
    }
    g.salary_per_round = Number(salary);
    j.games.push(g);
    audit(j, bundle, gid, 'salary.update', `salary_per_round=${Number(salary)}`, actor);
  }
  return gameView(bundle);
}

export function startGame(bundle: GameBundle, j: Journal, actor = 'banker'): GameViewResult {
  const g = bundle.game;
  if (!g) throw fail('NOT_FOUND', 'game not found');
  if (g.status !== GAME_STATUS.PENDING) {
    throw fail('INVALID_STATE', `only a pending game can be started (current: ${g.status})`);
  }
  const players = activePlayers(bundle.players);
  if (players.length < 1) {
    throw fail('INVALID_STATE', 'at least 1 player is required to start');
  }
  const needed = g.starting_cash * players.length;
  if (g.initial_bank_balance < needed) {
    throw fail(
      'BANK_INSOLVENT',
      `initial bank balance ${g.initial_bank_balance} is insufficient for starting cash ${needed} (${players.length} players x ${g.starting_cash})`
    );
  }

  g.status = GAME_STATUS.ACTIVE;
  j.games.push(g);

  const bank = { type: ACCOUNT.BANK };
  const equity = { type: ACCOUNT.EQUITY, id: 'GAME_EQUITY' };
  post(bundle, j, {
    txnType: 'EQUITY',
    category: 'OPENING_BALANCE',
    amount: g.initial_bank_balance,
    desc: 'Initial bank drawer float',
    from: equity,
    to: bank,
    idemKey: 'bankfloat:' + g.id,
  });
  for (const p of players) {
    post(bundle, j, {
      txnType: 'PAYOUT',
      category: 'STARTING_CASH',
      amount: g.starting_cash,
      desc: `Starting cash → ${p.name}`,
      from: bank,
      to: { type: ACCOUNT.PLAYER, id: p.id },
      idemKey: `start:${g.id}:${p.id}`,
    });
  }
  audit(j, bundle, g.id, 'game.start', `${players.length} players x ${g.starting_cash}`, actor);
  return gameView(bundle);
}

export function finishGame(bundle: GameBundle, j: Journal, actor = 'banker'): GameViewResult {
  const g = bundle.game;
  if (!g) throw fail('NOT_FOUND', 'game not found');
  if (g.status !== GAME_STATUS.ACTIVE) {
    throw fail('INVALID_STATE', 'only an active game can be finished');
  }
  g.status = GAME_STATUS.FINISHED;
  g.ended_at = nowTs();
  j.games.push(g);
  audit(j, bundle, g.id, 'game.finish', '', actor);
  return gameView(bundle);
}

// ---------- players ----------

export function addPlayer(bundle: GameBundle, j: Journal, gid: string, name?: string, seat?: number): Player {
  const g = bundle.game;
  if (!g) throw fail('NOT_FOUND', 'game not found');
  if (g.status !== GAME_STATUS.PENDING) {
    throw fail('INVALID_STATE', 'players can only join a pending game');
  }
  const clean = String(name || '').trim();
  if (!validName(clean)) {
    throw fail('INVALID', 'player name must be 1..64 printable characters');
  }
  let seatNo = Number(seat || 0) | 0;
  if (seatNo === 0) {
    seatNo = bundle.players.reduce((m, p) => Math.max(m, p.seat_no || 0), 0) + 1;
  }
  const p: Player = {
    id: newId('pl'),
    game_id: gid,
    name: clean,
    seat_no: seatNo,
    is_bankrupt: false,
    cash: 0,
    created_at: nowTs(),
  };
  bundle.players.push(p);
  j.players.push(p);
  return p;
}

export function removePlayer(bundle: GameBundle, j: Journal, gid: string, pid: string): void {
  const g = bundle.game;
  if (!g) throw fail('NOT_FOUND', 'game not found');
  if (g.status !== GAME_STATUS.PENDING) {
    throw fail('INVALID_STATE', 'started games only support the bankruptcy flow for exits');
  }
  const idx = bundle.players.findIndex((p) => p.id === pid);
  if (idx === -1) throw fail('NOT_FOUND', 'player not found in this game');
  const [p] = bundle.players.splice(idx, 1);
  j.deletedPlayers.push({ game_id: gid, id: p.id });
}

export function declareBankrupt(
  bundle: GameBundle,
  j: Journal,
  gid: string,
  pid: string,
  actor = 'banker'
): PlayerViewResult {
  const g = bundle.game;
  if (!g) throw fail('NOT_FOUND', 'game not found');
  if (g.status !== GAME_STATUS.ACTIVE) {
    throw fail('INVALID_STATE', 'bankruptcy requires an active game');
  }
  const p = bundle.players.find((x) => x.id === pid);
  if (!p) throw fail('NOT_FOUND', 'player not found');
  if (p.is_bankrupt) {
    throw fail('INVALID_STATE', 'player ' + p.name + ' is already bankrupt');
  }
  const acc = { type: ACCOUNT.PLAYER, id: pid };
  const bank = { type: ACCOUNT.BANK };
  const bal = balance(bundle, acc);
  if (bal > 0) {
    post(bundle, j, {
      txnType: 'TRANSFER',
      category: 'TRANSFER',
      amount: bal,
      desc: 'Bankruptcy settlement — remaining cash to bank',
      from: acc,
      to: bank,
    });
  }
  p.is_bankrupt = true;
  if (!j.players.includes(p)) j.players.push(p);
  audit(j, bundle, gid, 'player.bankrupt', 'player=' + pid, actor);
  return playerView(bundle, pid);
}

// ---------- rounds ----------

export interface StartRoundResult {
  round: number;
  transactions: Transaction[];
  replayed?: boolean;
}

export function startRound(
  bundle: GameBundle,
  j: Journal,
  gid: string,
  idemKey?: string,
  actor = 'banker'
): StartRoundResult {
  const g = bundle.game;
  if (!g) throw fail('NOT_FOUND', 'game not found');
  if (g.status !== GAME_STATUS.ACTIVE) {
    throw fail('INVALID_STATE', 'rounds can only start in an active game');
  }
  const key = String(idemKey || '').trim();

  // Idempotent replay
  if (key) {
    let round = findRoundByIdemKey(bundle, gid, key);
    let txn: Transaction | null = null;
    if (!round) {
      txn = findByIdemKey(bundle, gid, key);
      if (
        txn &&
        txn.txn_type === 'PAYOUT' &&
        txn.account_category === 'ROUND_COMPLETE' &&
        txn.game_id === gid
      ) {
        round = txn.round;
      }
    }
    if (round) {
      const txns = listTxns(bundle, { round, category: 'ROUND_COMPLETE' });
      return { round, transactions: txns, replayed: true };
    }
  }

  const round = (g.current_round || 0) + 1;
  const active = activePlayers(bundle.players);
  const bank = { type: ACCOUNT.BANK };
  const txns: Transaction[] = [];

  bundle.rounds.push({
    key: gid + ':' + round,
    game_id: gid,
    round_no: round,
    idem_key: key,
    created_at: nowTs(),
  });
  j.rounds.push(bundle.rounds[bundle.rounds.length - 1]);

  if (g.salary_per_round > 0) {
    for (const p of active) {
      const payKey = key ? `${key}:p:${p.id}` : `round:${gid}:${round}:${p.id}`;
      const { txn } = post(bundle, j, {
        txnType: 'PAYOUT',
        category: 'ROUND_COMPLETE',
        round,
        amount: g.salary_per_round,
        desc: `Round ${round} salary → ${p.name}`,
        from: bank,
        to: { type: ACCOUNT.PLAYER, id: p.id },
        idemKey: payKey,
      });
      txns.push(txn);
    }
  }
  g.current_round = round;
  j.games.push(g);
  audit(j, bundle, gid, 'round.start', `round=${round} salary=${g.salary_per_round}`, actor);
  return { round, transactions: txns };
}

export function roundDetail(bundle: GameBundle, round: number): { round: number; transactions: Transaction[] } {
  if (!bundle.game) throw fail('NOT_FOUND', 'game not found');
  return { round, transactions: listTxns(bundle, { round }) };
}

export function listRounds(bundle: GameBundle): RoundSummary[] {
  if (!bundle.game) throw fail('NOT_FOUND', 'game not found');
  return roundSummaries(bundle);
}

// ---------- transfers ----------

export interface TransferRequest {
  from: { type: string; id?: string };
  to: { type: string; id?: string };
  amount: number;
  account_category: string;
  description?: string;
}

export function transfer(
  bundle: GameBundle,
  j: Journal,
  gid: string,
  req: TransferRequest,
  idemKey?: string,
  actor = 'banker'
): Transaction {
  const key = String(idemKey || '').trim();
  const parsed = {
    from: req?.from as any,
    to: req?.to as any,
    amount: Number(req?.amount),
    category: String(req?.account_category || ''),
    description: req?.description,
  };
  transferValidate(parsed);
  const { txn } = post(bundle, j, {
    txnType: 'TRANSFER',
    category: parsed.category,
    amount: parsed.amount,
    desc: parsed.description,
    from: parsed.from,
    to: parsed.to,
    idemKey: key || undefined,
  });
  audit(
    j,
    bundle,
    gid,
    'transfer',
    `${parsed.category} ${parsed.amount} ${accountKey(parsed.from)}→${accountKey(parsed.to)}`,
    actor
  );
  return txn;
}

export function voidTxn(
  bundle: GameBundle,
  j: Journal,
  gid: string,
  txnId: string,
  actor = 'banker'
): Transaction {
  if (!bundle.game) throw fail('NOT_FOUND', 'game not found');
  const orig = findTxn(bundle, txnId);
  if (!orig || orig.game_id !== gid) throw fail('NOT_FOUND', 'transaction not found');
  return voidOne(bundle, j, gid, orig, actor);
}

function voidOne(
  bundle: GameBundle,
  j: Journal,
  gid: string,
  orig: Transaction,
  actor = 'banker'
): Transaction {
  if (orig.voided_by_txn) {
    throw fail('INVALID_STATE', 'transaction already voided by ' + orig.voided_by_txn);
  }
  if (orig.ref_txn_id) {
    throw fail('INVALID_STATE', 'a void entry cannot be voided');
  }
  if (orig.txn_type === 'EQUITY' || orig.account_category === 'OPENING_BALANCE') {
    throw fail('INVALID_STATE', 'system transactions cannot be voided');
  }
  if (bundle.game!.status !== GAME_STATUS.ACTIVE) {
    throw fail('INVALID_STATE', 'voiding requires an active game');
  }
  const dr = orig.entries.find((l) => l.direction === 'DR');
  const cr = orig.entries.find((l) => l.direction === 'CR');
  if (!dr || !cr) throw fail('INVALID_STATE', 'transaction lines are malformed');
  const from = { type: dr.account_type, id: dr.account_ref };
  const to = { type: cr.account_type, id: cr.account_ref };
  if (from.type === ACCOUNT.EQUITY || to.type === ACCOUNT.EQUITY) {
    throw fail('INVALID_STATE', 'equity transactions cannot be voided');
  }
  if (from.type === ACCOUNT.BANK) from.id = 'BANK';
  if (to.type === ACCOUNT.BANK) to.id = 'BANK';

  const { txn: rev } = post(bundle, j, {
    txnType: 'VOID',
    category: orig.account_category,
    round: orig.round,
    amount: orig.amount,
    desc: 'VOID of ' + orig.id,
    from: to,
    to: from,
    refTxnId: orig.id,
  });
  orig.voided_by_txn = rev.id;
  if (!j.txns.includes(orig)) j.txns.push(orig);
  audit(
    j,
    bundle,
    gid,
    'transfer.void',
    `voiding ${orig.id} of category ${orig.account_category} amount ${orig.amount}`,
    actor
  );
  return rev;
}

function audit(
  j: Journal,
  bundle: GameBundle,
  gid: string,
  action: string,
  detail: string,
  actor = 'banker'
): void {
  const row = {
    id: newId('aud'),
    game_id: gid,
    actor,
    action,
    detail: String(detail || ''),
    created_at: nowTs(),
  };
  bundle.audit.push(row);
  j.audit.push(row);
}
