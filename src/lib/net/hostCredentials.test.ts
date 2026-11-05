import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { JoinReservation, createHostCredentialStore } from './hostCredentials';
import { configureStorage, listDump } from '../db';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
});

let caseNo = 0;
function unique(prefix: string): string {
  caseNo += 1;
  return `${prefix}-${Date.now().toString(36)}-${caseNo}`;
}

function reservation(joinKey: string, playerId: string, gameId: string): JoinReservation {
  return {
    joinKey,
    playerId,
    playerToken: `pt-${playerId}`,
    name: 'Alice',
    gameId,
    status: 'seated',
    createdAt: 1,
  };
}

test('host credentials round-trip through IndexedDB', async () => {
  const gameId = unique('creds');
  const store = createHostCredentialStore();
  const res = reservation('jk-' + 'a'.repeat(32), 'pl-a', gameId);
  await store.save(gameId, { reservations: [res], tokens: { 'pl-a': 'pt-pl-a' } });

  // A fresh store instance simulates a host page reload.
  const reloaded = await createHostCredentialStore().load(gameId);
  assert.ok(reloaded);
  assert.deepEqual(reloaded!.tokens, { 'pl-a': 'pt-pl-a' });
  assert.equal(reloaded!.reservations.length, 1);
  assert.equal(reloaded!.reservations[0].joinKey, res.joinKey);
  assert.equal(reloaded!.reservations[0].playerId, 'pl-a');
  assert.equal(reloaded!.reservations[0].status, 'seated');
});

test('legacy token maps migrate to seated reservations', async () => {
  const gameId = unique('legacy');
  localStorage.setItem(`banker_tokens_${gameId}`, JSON.stringify({ 'pl-legacy': 'pt-legacy' }));

  const snapshot = await createHostCredentialStore().load(gameId);
  assert.ok(snapshot);
  assert.equal(snapshot!.tokens['pl-legacy'], 'pt-legacy');
  const migrated = snapshot!.reservations.find((r) => r.playerId === 'pl-legacy');
  assert.ok(migrated);
  assert.equal(migrated!.status, 'seated');
  assert.equal(migrated!.joinKey, 'legacy:pl-legacy');
  assert.equal(migrated!.playerToken, 'pt-legacy');
});

test('localStorage fallback keeps credentials when IndexedDB is unavailable', async () => {
  const gameId = unique('fallback');
  const res = reservation('jk-' + 'b'.repeat(32), 'pl-b', gameId);
  await createHostCredentialStore().save(gameId, {
    reservations: [res],
    tokens: { 'pl-b': 'pt-pl-b' },
  });

  const original = (globalThis as any).indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
  try {
    const snapshot = await createHostCredentialStore().load(gameId);
    assert.ok(snapshot);
    assert.equal(snapshot!.tokens['pl-b'], 'pt-pl-b');
    assert.equal(snapshot!.reservations[0].joinKey, res.joinKey);
  } finally {
    Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true });
  }
});

test('seat credentials never leak into the game backup dump', async () => {
  const gameId = unique('backup');
  const secret = 'super-secret-player-token';
  await createHostCredentialStore().save(gameId, {
    reservations: [reservation('jk-' + 'c'.repeat(32), 'pl-c', gameId)],
    tokens: { 'pl-c': secret },
  });

  configureStorage({ dbName: `banker_creds_${gameId}` });
  const dump = await listDump();
  assert.equal(JSON.stringify(dump).includes(secret), false);
  assert.equal(JSON.stringify(dump).includes('jk-'), false);
});
