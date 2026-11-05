import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTransferIntent, transferFingerprint } from './transferIntent';

const base = {
  from: 'player:pl-a',
  to: 'player:pl-b',
  amount: 100,
  category: 'RENT',
};

test('the same money fields reuse the same key', () => {
  let calls = 0;
  const makeKey = () => `key-${++calls}`;
  const fingerprint = transferFingerprint(base);
  const first = resolveTransferIntent(null, fingerprint, makeKey);
  const second = resolveTransferIntent(first, transferFingerprint({ ...base }), makeKey);

  assert.equal(second, first);
  assert.equal(calls, 1);
});

test('changing payer, payee, amount or category creates a new key', () => {
  let calls = 0;
  const makeKey = () => `key-${++calls}`;
  const first = resolveTransferIntent(null, transferFingerprint(base), makeKey);

  const variants = [
    { ...base, from: 'player:pl-c' },
    { ...base, to: 'bank:BANK' },
    { ...base, amount: 101 },
    { ...base, category: 'GIFT' },
  ];
  for (const variant of variants) {
    const next = resolveTransferIntent(first, transferFingerprint(variant), makeKey);
    assert.notEqual(next.key, first.key);
    first.key = next.key;
    first.fingerprint = next.fingerprint;
  }
  assert.equal(calls, 5);
});

test('a memo-only change reuses the key', () => {
  let calls = 0;
  const makeKey = () => `key-${++calls}`;
  const first = resolveTransferIntent(null, transferFingerprint(base), makeKey);
  // Description is not part of the fingerprint input at all.
  const second = resolveTransferIntent(first, transferFingerprint(base), makeKey);
  assert.equal(second.key, first.key);
  assert.equal(calls, 1);
});
