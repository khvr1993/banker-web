import test from 'node:test';
import assert from 'node:assert/strict';

import { randomHex, randomId } from './random';
import { newJoinKey, sanitizeJoinKey } from './net/joinKey';

test('randomHex returns the requested number of hex characters', () => {
  assert.equal(randomHex(16).length, 32);
  assert.equal(randomHex(6).length, 12);
  assert.match(randomHex(8), /^[a-f0-9]{16}$/);
});

test('randomIds are prefixed and unique', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) ids.add(randomId('pl', 8));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^pl-[a-f0-9]{16}$/);
});

test('join keys are 128-bit and strictly validated', () => {
  const key = newJoinKey();
  assert.match(key, /^jk-[a-f0-9]{32}$/);
  assert.equal(sanitizeJoinKey(key), key);
  assert.equal(sanitizeJoinKey(` ${key} `), key);
  assert.equal(sanitizeJoinKey('jk-xyz'), '');
  assert.equal(sanitizeJoinKey(''), '');
  assert.equal(sanitizeJoinKey(undefined), '');

  const keys = new Set<string>();
  for (let i = 0; i < 100; i++) keys.add(newJoinKey());
  assert.equal(keys.size, 100);
});
