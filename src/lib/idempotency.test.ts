import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { configureStorage } from './db';
import { localApi } from './api';
import { post } from './ledger';
import { createGame, addPlayer, startGame, finishGame } from './service';
import { journal, GameBundle } from './db';
import { ACCOUNT } from './domain';

function makeActiveBundle(): { bundle: GameBundle; alice: any; bob: any } {
  const game = createGame({
    name: 'Idempotency test',
    starting_cash: 1000,
    initial_bank_balance: 100000,
    salary_per_round: 200,
  });
  const bundle: GameBundle = { game, players: [], txns: [], rounds: [], audit: [] };
  const j = journal();
  const alice = addPlayer(bundle, j, game!.id, 'Alice', 1);
  const bob = addPlayer(bundle, j, game!.id, 'Bob', 2);
  startGame(bundle, j);
  return { bundle, alice, bob };
}

test('identical reuse replays the original transaction', () => {
  const { bundle, alice, bob } = makeActiveBundle();
  const params = {
    txnType: 'TRANSFER',
    category: 'RENT',
    amount: 100,
    from: { type: ACCOUNT.PLAYER, id: bob.id },
    to: { type: ACCOUNT.PLAYER, id: alice.id },
    idemKey: 'same-key',
  };
  const first = post(bundle, journal(), params);
  const count = bundle.txns.length;
  const second = post(bundle, journal(), params);

  assert.equal(second.replay, true);
  assert.equal(second.txn.id, first.txn.id);
  assert.equal(bundle.txns.length, count);
});

test('reusing a key for a different posting is a conflict', () => {
  const { bundle, alice, bob } = makeActiveBundle();
  const base = {
    txnType: 'TRANSFER',
    category: 'RENT',
    amount: 100,
    from: { type: ACCOUNT.PLAYER, id: bob.id },
    to: { type: ACCOUNT.PLAYER, id: alice.id },
    idemKey: 'conflict-key',
  };
  post(bundle, journal(), base);

  const variants = [
    { ...base, amount: 101 },
    { ...base, from: { type: ACCOUNT.PLAYER, id: alice.id }, to: { type: ACCOUNT.PLAYER, id: bob.id } },
    { ...base, to: { type: ACCOUNT.BANK, id: 'BANK' } },
    { ...base, category: 'GIFT' },
    { ...base, txnType: 'PAYOUT' },
  ];
  for (const variant of variants) {
    assert.throws(
      () => post(bundle, journal(), variant),
      (err: any) => err.kind === 'IDEMPOTENT_CONFLICT',
      `expected conflict for ${JSON.stringify(variant)}`
    );
  }
  assert.equal(bundle.txns.length, 4); // bank float + 2 starting cash + 1 rent
});

test('a retry after the game finished still replays', () => {
  const { bundle, alice, bob } = makeActiveBundle();
  const params = {
    txnType: 'TRANSFER',
    category: 'RENT',
    amount: 50,
    from: { type: ACCOUNT.PLAYER, id: bob.id },
    to: { type: ACCOUNT.PLAYER, id: alice.id },
    idemKey: 'finished-key',
  };
  const first = post(bundle, journal(), params);
  finishGame(bundle, journal());

  const replay = post(bundle, journal(), params);
  assert.equal(replay.replay, true);
  assert.equal(replay.txn.id, first.txn.id);
});

test('localApi transfers with the same key commit once', async () => {
  configureStorage({ dbName: `banker_idem_api_${Date.now()}` });
  const created = await localApi('/games', {
    method: 'POST',
    body: {
      name: 'API idempotency',
      starting_cash: 1000,
      initial_bank_balance: 100000,
      salary_per_round: 0,
    },
  });
  const gameId = created.id;
  const alice = await localApi(`/games/${gameId}/players`, {
    method: 'POST',
    body: { name: 'Alice' },
  });
  const bob = await localApi(`/games/${gameId}/players`, {
    method: 'POST',
    body: { name: 'Bob' },
  });
  await localApi(`/games/${gameId}/start`, { method: 'POST' });

  const request = {
    method: 'POST',
    headers: { 'Idempotency-Key': 'client-retry-1' },
    body: {
      from: { type: 'player', id: bob.id },
      to: { type: 'player', id: alice.id },
      amount: 100,
      account_category: 'RENT',
      description: 'Retry me',
    },
  };
  const first = await localApi(`/games/${gameId}/transfers`, request);
  const second = await localApi(`/games/${gameId}/transfers`, request);
  assert.equal(second.id, first.id);

  const ledger = await localApi(`/games/${gameId}/ledger`);
  assert.equal(ledger.transactions.filter((t: any) => t.description === 'Retry me').length, 1);
});
