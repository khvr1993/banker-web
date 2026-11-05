import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCommand, gameIdFromPath } from './authz';

const GID = 'game-1';
const ME = 'pl-me';
const OTHER = 'pl-other';

const transferPath = `/games/${GID}/transfers`;
const ownTransfer = { from: { type: 'player', id: ME }, to: { type: 'bank', id: 'BANK' }, amount: 100 };

test('gameIdFromPath parses the game segment', () => {
  assert.equal(gameIdFromPath(`/games/${GID}/transfers`), GID);
  assert.equal(gameIdFromPath(`/games/${GID}?x=1`), GID);
  assert.equal(gameIdFromPath('/health'), null);
  assert.equal(gameIdFromPath(''), null);
});

test('player may transfer from their own seat', () => {
  const result = authorizeCommand(ME, transferPath, 'POST', ownTransfer);
  assert.equal(result.ok, true);
});

test('player may not transfer from another seat or the bank', () => {
  const foreign = authorizeCommand(ME, transferPath, 'POST', {
    from: { type: 'player', id: OTHER },
    to: { type: 'bank', id: 'BANK' },
    amount: 100,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.status, 403);

  const fromBank = authorizeCommand(ME, transferPath, 'POST', {
    from: { type: 'bank', id: 'BANK' },
    to: { type: 'player', id: OTHER },
    amount: 100,
  });
  assert.equal(fromBank.ok, false);
});

test('banker-only mutations are rejected for players', () => {
  const commands: [string, string][] = [
    [`/games/${GID}/transfers/txn-1/void`, 'POST'],
    [`/games/${GID}/rounds`, 'POST'],
    [`/games/${GID}/players/${ME}/bankrupt`, 'POST'],
    [`/games/${GID}/start`, 'POST'],
    [`/games/${GID}/finish`, 'POST'],
    [`/games/${GID}`, 'PATCH'],
    [`/games/${GID}/players`, 'POST'],
    [`/games/${GID}/players/${ME}`, 'DELETE'],
  ];
  for (const [path, method] of commands) {
    const result = authorizeCommand(ME, path, method, { from: { type: 'player', id: ME } });
    assert.equal(result.ok, false, `${method} ${path} should be rejected`);
    assert.equal(result.status, 403);
  }
});

test('unjoined sessions and reads are rejected', () => {
  assert.equal(authorizeCommand(null, transferPath, 'POST', ownTransfer).ok, false);
  assert.equal(authorizeCommand(ME, `/games/${GID}`, 'GET', null).ok, false);
});
