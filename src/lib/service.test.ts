import test from 'node:test';
import assert from 'node:assert/strict';
import { journal, GameBundle } from './db';
import { createGame, addPlayer, startGame, transfer, voidTxn, startRound } from './service';

function makeBundle(gameInput = { name: 'Test Game', starting_cash: 10000, initial_bank_balance: 100000, salary_per_round: 2000, currency: '₹' }): GameBundle {
  const game = createGame(gameInput);
  return {
    game,
    players: [],
    txns: [],
    rounds: [],
    audit: [],
  };
}

test('game lifecycle: create, seat players, start game, transfer, and void', () => {
  const bundle = makeBundle();
  const j = journal();

  const alice = addPlayer(bundle, j, bundle.game!.id, 'Alice', 1);
  const bob = addPlayer(bundle, j, bundle.game!.id, 'Bob', 2);

  assert.equal(bundle.players.length, 2);
  assert.equal(alice.seat_no, 1);
  assert.equal(bob.seat_no, 2);

  const startedView = startGame(bundle, j);
  assert.equal(startedView.status, 'active');
  assert.equal(startedView.bank_balance, 80000);
  assert.equal(bundle.players[0].cash, 10000);
  assert.equal(bundle.players[1].cash, 10000);

  // Transfer rent from Bob to Alice
  const rentTxn = transfer(bundle, j, bundle.game!.id, {
    from: { type: 'player', id: bob.id },
    to: { type: 'player', id: alice.id },
    amount: 1500,
    account_category: 'RENT',
    description: 'RENT: Bob -> Alice',
  });

  assert.equal(bundle.players[0].cash, 11500);
  assert.equal(bundle.players[1].cash, 8500);

  // Void the rent transaction
  voidTxn(bundle, j, bundle.game!.id, rentTxn.id);
  assert.equal(bundle.players[0].cash, 10000);
  assert.equal(bundle.players[1].cash, 10000);

  // Advance round
  const roundRes = startRound(bundle, j, bundle.game!.id, 'idem-r1');
  assert.equal(roundRes.round, 1);
  assert.equal(bundle.players[0].cash, 12000);
  assert.equal(bundle.players[1].cash, 12000);
});

test('audit rows record the acting identity', () => {
  const bundle = makeBundle();
  const j = journal();
  const alice = addPlayer(bundle, j, bundle.game!.id, 'Alice', 1);
  const bob = addPlayer(bundle, j, bundle.game!.id, 'Bob', 2);
  startGame(bundle, j);

  const txn = transfer(
    bundle,
    j,
    bundle.game!.id,
    {
      from: { type: 'player', id: bob.id },
      to: { type: 'player', id: alice.id },
      amount: 300,
      account_category: 'RENT',
      description: 'RENT: Bob -> Alice',
    },
    'player-key-1',
    `player:${bob.id}`
  );

  const transferRow = bundle.audit.find((a) => a.action === 'transfer');
  assert.equal(transferRow?.actor, `player:${bob.id}`);

  voidTxn(bundle, j, bundle.game!.id, txn.id, `player:${alice.id}`);
  const voidRow = bundle.audit.find((a) => a.action === 'transfer.void');
  assert.equal(voidRow?.actor, `player:${alice.id}`);

  startRound(bundle, j, bundle.game!.id, 'round-key-1');
  const roundRow = bundle.audit.find((a) => a.action === 'round.start');
  assert.equal(roundRow?.actor, 'banker');

  assert.equal(
    bundle.audit.every((a) => typeof a.actor === 'string' && a.actor.length > 0),
    true
  );
});
