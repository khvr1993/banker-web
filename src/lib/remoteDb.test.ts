import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDelta, applySnapshot, configureStorage, loadGame } from './db';

const GID = 'game-test';

function makeGame(): any {
  return {
    id: GID,
    name: 'Mirror Test',
    status: 'active',
    starting_cash: 1000,
    initial_bank_balance: 5000,
    salary_per_round: 100,
    current_round: 1,
    currency: '₹',
    join_token: 'join-test',
    created_at: '2026-01-01T00:00:00',
    ended_at: '',
  };
}

function makePlayer(id: string, name: string, cash: number): any {
  return {
    id,
    game_id: GID,
    name,
    seat_no: 1,
    is_bankrupt: false,
    cash,
    created_at: '2026-01-01T00:00:00',
  };
}

function makeTxn(id: string, voidedBy = ''): any {
  return {
    id,
    game_id: GID,
    txn_type: 'TRANSFER',
    account_category: 'RENT',
    round: 1,
    amount: 100,
    description: 'RENT',
    ref_txn_id: '',
    idempotency_key: id,
    voided_by_txn: voidedBy,
    created_at: '2026-01-01T00:00:00',
    entries: [
      { account_type: 'player', account_ref: 'pl-a', direction: 'DR', amount: 100 },
      { account_type: 'player', account_ref: 'pl-b', direction: 'CR', amount: 100 },
    ],
  };
}

const game = makeGame();
const alice = makePlayer('pl-a', 'Alice', 900);
const bob = makePlayer('pl-b', 'Bob', 1100);

test('mirror applies snapshots and deltas idempotently', async () => {
  configureStorage({ dbName: `banker_mirror_test_${Date.now()}` });

  await applySnapshot({ games: [game], players: [alice, bob], txns: [], rounds: [], audit: [] });
  let bundle = await loadGame(GID);
  assert.equal(bundle.players.length, 2);

  const txn = makeTxn('txn-1');
  const delta = {
    games: [],
    players: [makePlayer('pl-a', 'Alice', 800)],
    txns: [txn],
    rounds: [],
    audit: [],
    deletedPlayers: [{ game_id: GID, id: 'pl-b' }],
  };

  await applyDelta(delta);
  bundle = await loadGame(GID);
  assert.equal(bundle.players.length, 1);
  assert.equal(bundle.players[0].cash, 800);
  assert.equal(bundle.txns.length, 1);

  // Replaying the same delta must not duplicate or regress anything.
  await applyDelta(delta);
  bundle = await loadGame(GID);
  assert.equal(bundle.players.length, 1);
  assert.equal(bundle.txns.length, 1);

  // Voids arrive as updates to the existing immutable transaction row.
  await applyDelta({ games: [], players: [], txns: [makeTxn('txn-1', 'txn-2')], rounds: [], audit: [], deletedPlayers: [] });
  bundle = await loadGame(GID);
  assert.equal(bundle.txns[0].voided_by_txn, 'txn-2');
});

test('snapshot replaces stale mirror rows', async () => {
  configureStorage({ dbName: `banker_mirror_test_${Date.now()}` });
  await applySnapshot({ games: [game], players: [alice, bob], txns: [makeTxn('txn-1')], rounds: [], audit: [] });
  await applySnapshot({ games: [game], players: [alice], txns: [], rounds: [], audit: [] });
  const bundle = await loadGame(GID);
  assert.equal(bundle.players.length, 1);
  assert.equal(bundle.txns.length, 0);
});
