// End-to-end session test over an in-memory transport: join, approval, deltas,
// seat-only player payments, and token rejoin.
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Dump,
  SerializedJournal,
  applyDelta,
  applySnapshot,
  configureStorage,
  loadGame,
  setCommitListener,
} from '../db';
import { localApi } from '../api';
import { gameView } from '../service';
import { ACCOUNT } from '../domain';
import { balance } from '../ledger';
import { ClientSession, ClientSessionHandlers } from './clientSession';
import { HostSession } from './hostSession';
import { resetPeerFactory, setPeerFactory } from './peerFactory';
import { Transport, TransportConnection, TransportHandlers } from './transportTypes';
import { RemoteEvent } from './protocol';

// ---------- browser shims (sessions run in a browser, tests run in Node) ----------

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
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost:3000', pathname: '/' } },
  configurable: true,
});

// ---------- in-memory transport ----------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

class FakeConnection implements TransportConnection {
  readonly id: string;
  peer: FakeConnection | null = null;

  private open = false;
  private closed = false;
  private openHandlers: (() => void)[] = [];
  private dataHandlers: ((data: unknown) => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  constructor(id: string) {
    this.id = id;
  }

  send(data: unknown): void {
    if (this.closed || !this.peer) return;
    const peer = this.peer;
    const payload = clone(data);
    queueMicrotask(() => {
      if (peer.closed) return;
      for (const handler of peer.dataHandlers) handler(payload);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    this.fireClose();
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.fireClose();
    }
  }

  aborted(): void {
    if (this.closed) return;
    this.closed = true;
    this.fireClose();
  }

  onOpen(handler: () => void): void {
    if (this.open) queueMicrotask(handler);
    else this.openHandlers.push(handler);
  }

  onData(handler: (data: unknown) => void): void {
    this.dataHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  isOpen(): boolean {
    return this.open && !this.closed;
  }

  markOpen(): void {
    if (this.open || this.closed) return;
    this.open = true;
    for (const handler of this.openHandlers.splice(0)) handler();
  }

  private fireClose(): void {
    for (const handler of this.closeHandlers.splice(0)) handler();
  }
}

class FakeHub {
  private transports = new Map<string, FakeTransport>();

  register(transport: FakeTransport): void {
    this.transports.set(transport.id, transport);
  }

  unregister(transport: FakeTransport): void {
    if (this.transports.get(transport.id) === transport) this.transports.delete(transport.id);
  }

  find(id: string): FakeTransport | undefined {
    return this.transports.get(id);
  }
}

class FakeTransport implements Transport {
  readonly id: string;
  handlers: TransportHandlers;

  private hub: FakeHub;
  private destroyed = false;

  constructor(id: string, hub: FakeHub, handlers: TransportHandlers) {
    this.id = id;
    this.hub = hub;
    this.handlers = handlers;
  }

  connect(peerId: string): TransportConnection {
    const connection = new FakeConnection(peerId);
    const target = this.hub.find(peerId);
    if (this.destroyed || !target) {
      queueMicrotask(() => connection.aborted());
      return connection;
    }
    const remote = new FakeConnection(this.id);
    connection.peer = remote;
    remote.peer = connection;
    queueMicrotask(() => {
      if (this.destroyed) {
        connection.aborted();
        return;
      }
      target.handlers.onConnection?.(remote);
      connection.markOpen();
      remote.markOpen();
    });
    return connection;
  }

  reconnect(): void {}

  destroy(): void {
    this.destroyed = true;
    this.hub.unregister(this);
  }
}

async function waitFor<T>(
  check: () => T | undefined | false | null,
  what: string,
  timeoutMs = 2000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('host and client sessions sync deltas and honor seat-only payments', async () => {
  const stamp = Date.now().toString(36);
  const hostDb = `banker_test_host_${stamp}`;
  const mirrorDb = `banker_test_mirror_${stamp}`;
  const room = `session-${stamp}`;

  configureStorage({ dbName: hostDb });
  const created = await localApi('/games', {
    method: 'POST',
    body: {
      name: 'Session test',
      starting_cash: 1500,
      initial_bank_balance: 100000,
      salary_per_round: 200,
    },
  });
  const gameId = created.id as string;

  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  let rejoined: ClientSession | null = null;
  setCommitListener((j) => host?.broadcastJournal(j));

  const hub = new FakeHub();
  setPeerFactory(async (id, handlers = {}) => {
    const transport = new FakeTransport(id, hub, handlers);
    hub.register(transport);
    return transport;
  });

  try {
    host = await HostSession.start({ room, gameId });

    const snapshots: { data: Dump; gameId: string }[] = [];
    const deltas: { journal: SerializedJournal; rev: number; at: number }[] = [];
    const events: RemoteEvent[] = [];
    const joined: { playerId: string; gameId: string }[] = [];
    const rejections: string[] = [];
    const statuses: string[] = [];

    const handlers: ClientSessionHandlers = {
      onSnapshot: (data, gid) => {
        snapshots.push({ data, gameId: gid });
      },
      onDelta: (journal, rev) => {
        deltas.push({ journal, rev, at: Date.now() });
      },
      onStatus: (state) => statuses.push(state),
      onJoined: (info) => joined.push(info),
      onPending: () => {},
      onRejected: (reason) => rejections.push(reason),
      onEvent: (event) => events.push(event),
      onError: (message) => rejections.push(message),
    };

    client = await ClientSession.create(room, handlers);
    const joinPromise = client.join('Alice');

    const pendingPeer = await waitFor(
      () => host?.peers.find((p) => p.status === 'pending' && p.name === 'Alice'),
      'the host to receive the join request'
    );
    assert.equal(pendingPeer.name, 'Alice');
    assert.equal(statuses.includes('connected'), false);

    await host.approve(pendingPeer.sessionId);
    const info = await joinPromise;
    assert.equal(info.gameId, gameId);
    assert.ok(joined.some((entry) => entry.playerId === info.playerId));
    assert.equal(host.acceptedPeerCount, 1);
    assert.equal(statuses[statuses.length - 1], 'connected');

    // Snapshots are filtered to the hosted game only.
    const accepted = snapshots.at(-1);
    assert.ok(accepted);
    assert.equal(accepted.gameId, gameId);
    assert.equal(accepted.data.games.length, 1);
    assert.equal(accepted.data.players.length, 1);
    assert.equal(accepted.data.players[0].name, 'Alice');
    assert.ok(snapshots.every((s) => s.data.games.every((g) => g.id === gameId)));

    // Banker commits broadcast a delta to accepted peers.
    const beforeStart = deltas.length;
    await localApi(`/games/${gameId}/start`, { method: 'POST' });
    await waitFor(() => deltas.length > beforeStart, 'the start delta');
    assert.equal(deltas.at(-1)?.journal.games[0]?.status, 'active');

    const beforeSalary = deltas.length;
    const salaryAt = Date.now();
    const hostTxn = await localApi(`/games/${gameId}/transfers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'host-salary-1' },
      body: {
        from: { type: 'bank', id: 'BANK' },
        to: { type: 'player', id: info.playerId },
        amount: 500,
        account_category: 'SALARY',
        description: 'Host salary',
      },
    });
    await waitFor(() => deltas.length > beforeSalary, 'the salary delta');
    const salaryDelta = deltas.at(-1)!;
    assert.ok(salaryDelta.at - salaryAt < 1000, 'the delta must arrive within one second');
    assert.equal(
      salaryDelta.journal.txns.find((t) => t.id === hostTxn.id)?.amount,
      500
    );
    assert.ok(events.some((e) => e.kind === 'transfer' && e.amount === 500));

    // A player may pay from their own seat; the host commits and echoes a delta.
    const beforePayment = deltas.length;
    const receipt = await client.command(`/games/${gameId}/transfers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'player-rent-1' },
      body: {
        from: { type: 'player', id: info.playerId },
        to: { type: 'bank', id: 'BANK' },
        amount: 200,
        account_category: 'RENT',
        description: 'Rent',
      },
    });
    assert.equal(receipt.amount, 200);
    await waitFor(() => deltas.length > beforePayment, 'the player payment delta');
    assert.ok(deltas.at(-1)?.journal.txns.some((t) => t.id === receipt.id));

    // Paying from another seat is rejected by the host.
    await assert.rejects(
      client.command(`/games/${gameId}/transfers`, {
        method: 'POST',
        body: {
          from: { type: 'player', id: 'not-my-seat' },
          to: { type: 'bank', id: 'BANK' },
          amount: 50,
          account_category: 'GIFT',
          description: 'Not allowed',
        },
      }),
      (err: any) => err.status === 403 && /own seat/i.test(err.message)
    );

    // Banker-only mutations are rejected.
    await assert.rejects(
      client.command(`/games/${gameId}/rounds`, { method: 'POST' }),
      (err: any) => err.status === 403 && /only available to the banker/i.test(err.message)
    );

    const afterRejects = await loadGame(gameId);
    assert.equal(afterRejects.txns.filter((t) => t.description === 'Not allowed').length, 0);

    // Refreshing reconnects the same seat without banker approval.
    client.leave();
    client = null;
    await waitFor(() => host?.acceptedPeerCount === 0, 'the host to drop the closed connection');

    rejoined = await ClientSession.create(room, handlers);
    const rejoinInfo = await rejoined.join('Alice');
    assert.equal(rejoinInfo.playerId, info.playerId);
    assert.equal(host.acceptedPeerCount, 1);
    assert.equal(host.peers.find((p) => p.playerId === info.playerId)?.status, 'connected');

    // Applying the client's snapshot + deltas reproduces the host state.
    configureStorage({ dbName: mirrorDb });
    await applySnapshot(snapshots[0].data);
    for (const delta of deltas) await applyDelta(delta.journal);
    const mirrorBundle = await loadGame(gameId);
    const mirrorView = gameView(mirrorBundle);

    configureStorage({ dbName: hostDb });
    const hostBundle = await loadGame(gameId);
    const hostView = gameView(hostBundle);

    assert.equal(mirrorView.status, 'active');
    assert.equal(mirrorView.bank_balance, hostView.bank_balance);
    assert.deepEqual(
      mirrorBundle.txns.map((t) => t.id).sort(),
      hostBundle.txns.map((t) => t.id).sort()
    );
    assert.deepEqual(
      mirrorView.players.map((p) => [p.id, p.name, balance(mirrorBundle, { type: ACCOUNT.PLAYER, id: p.id })]),
      hostView.players.map((p) => [p.id, p.name, balance(hostBundle, { type: ACCOUNT.PLAYER, id: p.id })])
    );
    assert.equal(rejections.length, 0);
  } finally {
    setCommitListener(null);
    try {
      rejoined?.leave();
    } catch {
      // ignore
    }
    try {
      client?.leave();
    } catch {
      // ignore
    }
    host?.stop('Test finished');
    resetPeerFactory();
  }
});
