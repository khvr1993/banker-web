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
import { HostSession, eventsWithOrigins } from './hostSession';
import { resetPeerFactory, setPeerFactory } from './peerFactory';
import { Transport, TransportConnection, TransportHandlers } from './transportTypes';
import {
  PROTOCOL_VERSION,
  RemoteEvent,
  hostPeerId,
} from './protocol';
import { HostCredentialSnapshot, HostCredentialStore } from './hostCredentials';

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

  private hub: FakeHub;
  private open = false;
  private closed = false;
  private openHandlers: (() => void)[] = [];
  private dataHandlers: ((data: unknown) => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  constructor(id: string, hub: FakeHub) {
    this.id = id;
    this.hub = hub;
  }

  send(data: unknown): void {
    if (this.closed || !this.peer) return;
    const payload = clone(data);
    this.hub.sent.push(payload);
    if (this.hub.consumeDrop(data)) return;
    const peer = this.peer;
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
  dropIf: ((data: unknown) => boolean) | null = null;
  sent: unknown[] = [];

  dropNext(predicate: (data: unknown) => boolean): void {
    this.dropIf = predicate;
  }

  consumeDrop(data: unknown): boolean {
    if (!this.dropIf) return false;
    if (!this.dropIf(data)) return false;
    this.dropIf = null;
    return true;
  }

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
    const connection = new FakeConnection(peerId, this.hub);
    const target = this.hub.find(peerId);
    if (this.destroyed || !target) {
      queueMicrotask(() => connection.aborted());
      return connection;
    }
    const remote = new FakeConnection(this.id, this.hub);
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
    joinPromise.catch(() => {});

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
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

// ---------- protocol / reliability regressions ----------

let caseNo = 0;
function unique(prefix: string): string {
  caseNo += 1;
  return `${prefix}-${Date.now().toString(36)}-${caseNo}`;
}

interface Bucket {
  snapshots: { data: Dump; gameId: string }[];
  deltas: { journal: SerializedJournal; rev: number }[];
  events: RemoteEvent[];
  joined: { playerId: string; gameId: string }[];
  pending: number;
  rejected: string[];
  statuses: string[];
  errors: string[];
  latencies: number[];
}

function makeBucket(): Bucket {
  return {
    snapshots: [],
    deltas: [],
    events: [],
    joined: [],
    pending: 0,
    rejected: [],
    statuses: [],
    errors: [],
    latencies: [],
  };
}

function makeHandlers(
  bucket: Bucket,
  overrides: Partial<ClientSessionHandlers> = {}
): ClientSessionHandlers {
  return {
    onSnapshot: (data, gameId) => {
      bucket.snapshots.push({ data, gameId });
    },
    onDelta: (journal, rev) => {
      bucket.deltas.push({ journal, rev });
    },
    onStatus: (state) => bucket.statuses.push(state),
    onJoined: (info) => bucket.joined.push(info),
    onPending: () => {
      bucket.pending += 1;
    },
    onRejected: (reason) => bucket.rejected.push(reason),
    onEvent: (event) => bucket.events.push(event),
    onError: (message) => bucket.errors.push(message),
    onLatency: (ms) => bucket.latencies.push(ms),
    ...overrides,
  };
}

async function createTestGame(stamp: string): Promise<string> {
  configureStorage({ dbName: `banker_session_${stamp}` });
  const created = await localApi('/games', {
    method: 'POST',
    body: {
      name: 'Session regression',
      starting_cash: 1500,
      initial_bank_balance: 100000,
      salary_per_round: 200,
    },
  });
  return created.id as string;
}

function installHub(): FakeHub {
  const hub = new FakeHub();
  setPeerFactory(async (id, handlers = {}) => {
    const transport = new FakeTransport(id, hub, handlers);
    hub.register(transport);
    return transport;
  });
  return hub;
}

class MemoryCredentialStore implements HostCredentialStore {
  private data = new Map<string, HostCredentialSnapshot>();
  saves = 0;

  async load(gameId: string): Promise<HostCredentialSnapshot | null> {
    const snapshot = this.data.get(gameId);
    return snapshot ? (JSON.parse(JSON.stringify(snapshot)) as HostCredentialSnapshot) : null;
  }

  async save(gameId: string, snapshot: HostCredentialSnapshot): Promise<void> {
    this.saves += 1;
    this.data.set(gameId, JSON.parse(JSON.stringify(snapshot)) as HostCredentialSnapshot);
  }

  snapshot(gameId: string): HostCredentialSnapshot | null {
    return this.data.get(gameId) || null;
  }
}

test('welcome exposes no ledger data before banker approval', async () => {
  const stamp = unique('privacy');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  const hub = installHub();
  const bucket = makeBucket();

  try {
    host = await HostSession.start({ room, gameId });
    client = await ClientSession.create(room, makeHandlers(bucket));
    const joinPromise = client.join('Alice');
    joinPromise.catch(() => {});
    joinPromise.catch(() => {});

    const pending = await waitFor(
      () => host?.peers.find((p) => p.status === 'pending' && p.name === 'Alice'),
      'the pending join request'
    );

    // Only the host sends these message types, so inspecting every frame is
    // enough to prove nothing ledger-shaped reached the unapproved peer.
    const sent = hub.sent as any[];
    assert.ok(sent.some((m) => m.t === 'welcome'));
    const welcome = sent.find((m) => m.t === 'welcome');
    assert.deepEqual(Object.keys(welcome).sort(), ['protocol', 'room', 't']);
    assert.equal(sent.some((m) => m.t === 'join-accepted'), false);
    assert.equal(sent.some((m) => m.t === 'snapshot' || m.t === 'delta' || m.t === 'event'), false);
    assert.equal(bucket.snapshots.length, 0);
    assert.equal(bucket.joined.length, 0);
    assert.equal(bucket.statuses.includes('connected'), false);
    assert.equal(client.isAccepted, false);

    await host.approve(pending.sessionId);
    const info = await joinPromise;
    assert.equal(bucket.snapshots.length, 1);
    assert.equal(bucket.snapshots[0].data.players.length, 1);
    assert.equal(bucket.joined[0].playerId, info.playerId);
  } finally {
    setCommitListener(null);
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('player idempotency keys are namespaced and stay out of host keys', async () => {
  const stamp = unique('idem');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  setCommitListener((j) => host?.broadcastJournal(j));
  installHub();
  const bucket = makeBucket();

  try {
    host = await HostSession.start({ room, gameId });
    client = await ClientSession.create(room, makeHandlers(bucket));
    const joinPromise = client.join('Alice');
    joinPromise.catch(() => {});
    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');
    await host.approve(pending.sessionId);
    const info = await joinPromise;

    await localApi(`/games/${gameId}/start`, { method: 'POST' });
    await waitFor(() => bucket.deltas.length >= 1, 'the start delta');

    // Poison key: this is exactly the key the banker will use to pay Alice's
    // round-1 salary. Namespacing must keep the two apart.
    const poison = `round:${gameId}:1:${info.playerId}`;
    const receipt = await client.command(`/games/${gameId}/transfers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': poison },
      body: {
        from: { type: 'player', id: info.playerId },
        to: { type: 'bank', id: 'BANK' },
        amount: 50,
        account_category: 'RENT',
        description: 'Poison rent',
      },
    });

    await waitFor(
      () => bucket.deltas.some((d) => d.journal.txns.some((t) => t.id === receipt.id)),
      'the player transfer delta'
    );
    // The sender must not receive its own transfer event.
    assert.equal(bucket.events.some((e) => e.description === 'Poison rent'), false);

    const round = await localApi(`/games/${gameId}/rounds`, { method: 'POST' });
    assert.equal(round.round, 1);
    assert.equal(round.transactions.length, 1);
    assert.equal(round.transactions[0].account_category, 'ROUND_COMPLETE');
    await waitFor(() => bucket.events.some((e) => e.kind === 'round'), 'the round event');

    const bundle = await loadGame(gameId);
    const salary = bundle.txns.find((t) => t.account_category === 'ROUND_COMPLETE');
    assert.equal(salary?.amount, 200);
    const playerTxn = bundle.txns.find((t) => t.id === receipt.id);
    assert.ok(playerTxn?.idempotency_key.startsWith(`player:${info.playerId}:`));
    assert.notEqual(playerTxn?.idempotency_key, poison);

    const transferAudit = bundle.audit.find((a) => a.action === 'transfer');
    assert.equal(transferAudit?.actor, `player:${info.playerId}`);
    const roundAudit = bundle.audit.find((a) => a.action === 'round.start');
    assert.equal(roundAudit?.actor, 'banker');
  } finally {
    setCommitListener(null);
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('a lost join-accepted recovers the reserved seat after reconnect', async () => {
  const stamp = unique('lost-ack');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  let reloaded: ClientSession | null = null;
  const hub = new FakeHub();
  setPeerFactory(async (id, handlers = {}) => {
    const transport = new FakeTransport(id, hub, handlers);
    hub.register(transport);
    return transport;
  });

  try {
    host = await HostSession.start({ room, gameId });
    const bucket = makeBucket();
    client = await ClientSession.create(room, makeHandlers(bucket));
    const joinPromise = client.join('Alice');
    joinPromise.catch(() => {});

    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');
    hub.dropNext((data) => (data as any)?.t === 'join-accepted');
    await host.approve(pending.sessionId);

    // The ack is lost, so the first session never learns its player id.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(client.isAccepted, false);
    assert.equal(host.acceptedPeerCount, 1);
    const before = await loadGame(gameId);
    assert.equal(before.players.length, 1);

    client.leave();
    await assert.rejects(joinPromise, /Left the session/);
    client = null;

    // A reload presents the same joinKey; the host reserved it before sending
    // the ack, so the seat is restored without banker approval.
    reloaded = await ClientSession.create(room, makeHandlers(bucket));
    const info = await reloaded.join('Alice');
    assert.equal(info.playerId, before.players[0].id);
    assert.equal(reloaded.isAccepted, true);
    const after = await loadGame(gameId);
    assert.equal(after.players.length, 1);
  } finally {
    setCommitListener(null);
    reloaded?.leave();
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('double approve seats only one player', async () => {
  const stamp = unique('double-approve');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  installHub();
  const bucket = makeBucket();

  try {
    host = await HostSession.start({ room, gameId });
    client = await ClientSession.create(room, makeHandlers(bucket));
    const joinPromise = client.join('Alice');
    joinPromise.catch(() => {});
    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');

    await Promise.all([host.approve(pending.sessionId), host.approve(pending.sessionId)]);
    await joinPromise;

    const bundle = await loadGame(gameId);
    assert.equal(bundle.players.length, 1);
    assert.equal(host.acceptedPeerCount, 1);
  } finally {
    setCommitListener(null);
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('kick revokes the seat and forces a fresh join request', async () => {
  const stamp = unique('kick');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  let retry: ClientSession | null = null;
  installHub();

  try {
    host = await HostSession.start({ room, gameId });
    const bucket = makeBucket();
    client = await ClientSession.create(room, makeHandlers(bucket));
    const joinPromise = client.join('Alice');
    joinPromise.catch(() => {});
    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');
    await host.approve(pending.sessionId);
    const info = await joinPromise;

    const connected = host.peers.find((p) => p.playerId === info.playerId);
    assert.ok(connected);
    host.kick(connected!.sessionId);

    await waitFor(() => bucket.rejected.length > 0, 'the removed bye');
    assert.match(bucket.rejected[0], /Removed by the banker/);
    assert.equal(bucket.statuses.at(-1), 'error');
    client = null;

    // The kicked credential must not auto-rejoin: the game is pending, so the
    // retry has to go through banker approval again.
    const retryBucket = makeBucket();
    retry = await ClientSession.create(room, makeHandlers(retryBucket));
    const retryJoin = retry.join('Alice');
    retryJoin.catch(() => {});
    await waitFor(() => host?.peers.some((p) => p.status === 'pending'), 'the retry pending request');
    assert.equal(retry.isAccepted, false);
    assert.equal(retryBucket.joined.length, 0);
    assert.equal((await loadGame(gameId)).players.length, 1);
    retry.leave();
  } finally {
    setCommitListener(null);
    retry?.leave();
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('host-stopped is terminal while a silent stop reconnects', async () => {
  const roomA = unique('bye-terminal');
  const gameA = await createTestGame(roomA);
  let hostA: HostSession | null = null;
  let clientA: ClientSession | null = null;
  setCommitListener(null);
  installHub();

  try {
    hostA = await HostSession.start({ room: roomA, gameId: gameA });
    const bucketA = makeBucket();
    clientA = await ClientSession.create(roomA, makeHandlers(bucketA));
    const joinA = clientA.join('Alice');
    joinA.catch(() => {});
    const pendingA = await waitFor(() => hostA?.peers.find((p) => p.status === 'pending'), 'pending A');
    await hostA.approve(pendingA.sessionId);
    await joinA;

    hostA.stop();
    await waitFor(() => bucketA.rejected.length > 0, 'the terminal bye');
    assert.match(bucketA.rejected[0], /ended the session/);
    assert.equal(bucketA.statuses.at(-1), 'error');
    assert.equal(clientA.isAccepted, false);
  } finally {
    clientA?.leave();
    hostA?.stop({ notify: false });
    resetPeerFactory();
  }

  const roomB = unique('bye-silent');
  const gameB = await createTestGame(roomB);
  let hostB: HostSession | null = null;
  let clientB: ClientSession | null = null;
  installHub();

  try {
    hostB = await HostSession.start({ room: roomB, gameId: gameB });
    const bucketB = makeBucket();
    clientB = await ClientSession.create(roomB, makeHandlers(bucketB));
    const joinB = clientB.join('Alice');
    joinB.catch(() => {});
    const pendingB = await waitFor(() => hostB?.peers.find((p) => p.status === 'pending'), 'pending B');
    await hostB.approve(pendingB.sessionId);
    await joinB;

    hostB.stop({ notify: false });
    await waitFor(() => bucketB.statuses.includes('reconnecting'), 'the reconnect status');
    assert.equal(bucketB.rejected.length, 0);
    assert.equal(clientB.isAccepted, false);
  } finally {
    clientB?.leave();
    hostB?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('join handshake and pending-ack timeouts fail visibly', async () => {
  const noHostRoom = unique('timeout-no-host');
  installHub();
  const noHostBucket = makeBucket();
  let noHost: ClientSession | null = null;
  try {
    noHost = await ClientSession.create(noHostRoom, makeHandlers(noHostBucket), {
      handshakeTimeoutMs: 60,
    });
    await assert.rejects(
      noHost.join('Alice'),
      (err: any) => err.status === 504 && err.type === 'JOIN_TIMEOUT'
    );
    assert.equal(noHostBucket.statuses.at(-1), 'error');
    assert.ok(noHostBucket.errors.some((m) => /did not answer/.test(m)));
  } finally {
    noHost?.leave();
    resetPeerFactory();
  }

  const room = unique('timeout-no-ack');
  const gameId = await createTestGame(room);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  const hub = installHub();
  try {
    host = await HostSession.start({ room, gameId });
    const bucket = makeBucket();
    client = await ClientSession.create(room, makeHandlers(bucket), {
      handshakeTimeoutMs: 1000,
      pendingAckTimeoutMs: 60,
    });
    hub.dropNext((data) => (data as any)?.t === 'join-pending');
    await assert.rejects(
      client.join('Alice'),
      (err: any) => err.status === 504 && err.type === 'JOIN_TIMEOUT'
    );
    assert.equal(bucket.statuses.at(-1), 'error');
    assert.equal(host.acceptedPeerCount, 0);
  } finally {
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('a failed snapshot apply rejects the join instead of hanging', async () => {
  const stamp = unique('snapshot-fail');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  installHub();
  const bucket = makeBucket();

  try {
    host = await HostSession.start({ room, gameId });
    client = await ClientSession.create(
      room,
      makeHandlers(bucket, {
        onSnapshot: () => {
          throw new Error('disk full');
        },
      })
    );
    const joinPromise = client.join('Alice');
    joinPromise.catch(() => {});
    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');
    await host.approve(pending.sessionId);

    await assert.rejects(joinPromise, /disk full/);
    assert.equal(client.isAccepted, false);
    assert.equal(bucket.joined.length, 0);
    assert.equal(bucket.statuses.at(-1), 'error');
    assert.ok(bucket.errors.some((m) => /local storage/i.test(m)));
  } finally {
    setCommitListener(null);
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('deltas committed during snapshot preparation are buffered after join-accepted', async () => {
  const stamp = unique('join-buffer');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  setCommitListener((j) => host?.broadcastJournal(j));
  installHub();
  const bucket = makeBucket();

  let releaseSnapshot!: () => void;
  let hookEntered!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    hookEntered = resolve;
  });

  try {
    host = await HostSession.start({
      room,
      gameId,
      hooks: {
        beforeAcceptSnapshot: () => {
          hookEntered();
          return gate;
        },
      },
    });
    client = await ClientSession.create(room, makeHandlers(bucket));
    const joinPromise = client.join('Alice');
    joinPromise.catch(() => {});
    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');

    const approval = host.approve(pending.sessionId);
    await entered;

    // Commit while the accept is blocked before its snapshot read.
    const late = await localApi(`/games/${gameId}/players`, {
      method: 'POST',
      body: { name: 'Late Host Seat' },
    });
    releaseSnapshot();
    await approval;
    await joinPromise;

    assert.equal(bucket.snapshots.length, 1);
    assert.equal(bucket.snapshots[0].data.players.length, 2);
    await waitFor(() => bucket.deltas.length >= 1, 'the buffered delta');
    assert.equal(bucket.deltas[0].rev > 0, true);
    assert.ok(bucket.deltas[0].journal.players.some((p) => p.id === late.id));

    const mirrorDb = `${stamp}-mirror`;
    configureStorage({ dbName: mirrorDb });
    await applySnapshot(bucket.snapshots[0].data);
    for (const delta of bucket.deltas) await applyDelta(delta.journal);
    const mirror = await loadGame(gameId);
    assert.equal(mirror.players.length, 2);
  } finally {
    setCommitListener(null);
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('a delta gap triggers one resync snapshot without duplicating money', async () => {
  const stamp = unique('resync');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  setCommitListener((j) => host?.broadcastJournal(j));
  const hub = installHub();
  const bucket = makeBucket();

  try {
    host = await HostSession.start({ room, gameId });
    client = await ClientSession.create(room, makeHandlers(bucket));
    const joinPromise = client.join('Alice');
    joinPromise.catch(() => {});
    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');
    await host.approve(pending.sessionId);
    const info = await joinPromise;

    await localApi(`/games/${gameId}/start`, { method: 'POST' });
    await waitFor(() => bucket.deltas.length >= 1, 'the start delta');

    hub.dropNext((data) => (data as any)?.t === 'delta');
    await localApi(`/games/${gameId}/transfers`, {
      method: 'POST',
      body: {
        from: { type: 'bank', id: 'BANK' },
        to: { type: 'player', id: info.playerId },
        amount: 100,
        account_category: 'GIFT',
        description: 'First transfer',
      },
    });

    await localApi(`/games/${gameId}/transfers`, {
      method: 'POST',
      body: {
        from: { type: 'bank', id: 'BANK' },
        to: { type: 'player', id: info.playerId },
        amount: 200,
        account_category: 'GIFT',
        description: 'Second transfer',
      },
    });

    await waitFor(() => bucket.snapshots.length >= 2, 'the resync snapshot');
    assert.equal(bucket.joined.filter((j) => j.playerId === info.playerId).length, 1);

    const snapshot = bucket.snapshots.at(-1)!.data;
    assert.equal(snapshot.txns.filter((t) => t.description === 'First transfer').length, 1);
    assert.equal(snapshot.txns.filter((t) => t.description === 'Second transfer').length, 1);

    configureStorage({ dbName: `${stamp}-mirror` });
    await applySnapshot(snapshot);
    const mirror = await loadGame(gameId);
    assert.equal(mirror.txns.filter((t) => t.description === 'First transfer').length, 1);
    assert.equal(mirror.txns.filter((t) => t.description === 'Second transfer').length, 1);
    assert.equal(mirror.players[0].id, info.playerId);
  } finally {
    setCommitListener(null);
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('a failed delta write resyncs and restores the transaction exactly once', async () => {
  const stamp = unique('delta-fail');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  setCommitListener((j) => host?.broadcastJournal(j));
  installHub();
  const bucket = makeBucket();
  let failNext = false;

  const handlers = makeHandlers(bucket, {
    onDelta: (journal, rev) => {
      bucket.deltas.push({ journal, rev });
      if (failNext) {
        failNext = false;
        throw new Error('mirror write failed');
      }
    },
  });

  try {
    host = await HostSession.start({ room, gameId });
    client = await ClientSession.create(room, handlers);
    const joinPromise = client.join('Alice');
    joinPromise.catch(() => {});
    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');
    await host.approve(pending.sessionId);
    const info = await joinPromise;

    await localApi(`/games/${gameId}/start`, { method: 'POST' });
    await waitFor(() => bucket.deltas.length >= 1, 'the start delta');

    failNext = true;
    await localApi(`/games/${gameId}/transfers`, {
      method: 'POST',
      body: {
        from: { type: 'bank', id: 'BANK' },
        to: { type: 'player', id: info.playerId },
        amount: 250,
        account_category: 'GIFT',
        description: 'Failing transfer',
      },
    });

    await waitFor(() => bucket.snapshots.length >= 2, 'the resync snapshot');
    assert.equal(bucket.joined.filter((j) => j.playerId === info.playerId).length, 1);
    const snapshot = bucket.snapshots.at(-1)!.data;
    assert.equal(snapshot.txns.filter((t) => t.description === 'Failing transfer').length, 1);

    // The failed delta was never counted as applied, so no further revisions
    // arrived and no resync loop started.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bucket.snapshots.length, 2);
  } finally {
    setCommitListener(null);
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('eventsWithOrigins attributes and dedupes per session', () => {
  const txn = (id: string, key: string, desc: string, category = 'RENT'): any => ({
    id,
    game_id: 'g1',
    txn_type: 'TRANSFER',
    account_category: category,
    round: 1,
    amount: 100,
    description: desc,
    ref_txn_id: '',
    idempotency_key: key,
    voided_by_txn: '',
    created_at: '2026-01-01T00:00:00',
    entries: [],
  });
  const journal = (txns: any[], rounds: any[] = []): SerializedJournal => ({
    games: [],
    players: [],
    txns,
    rounds,
    audit: [],
    deletedPlayers: [],
  });

  const origins = new Map([['k1', 's1'], ['k2', 's2']]);
  const transferEvents = eventsWithOrigins(
    journal([
      txn('t1', 'k1', 'Rent'),
      txn('t2', 'k2', 'Gift', 'GIFT'),
      txn('t3', 'k1', 'Rent'),
    ]),
    origins
  );
  assert.equal(transferEvents.length, 2);
  assert.equal(transferEvents[0].origin, 's1');
  assert.equal(transferEvents[0].event.kind, 'transfer');
  assert.equal(transferEvents[1].origin, 's2');

  const roundEvents = eventsWithOrigins(
    journal([txn('t4', 'k2', 'Round 2 salary', 'ROUND_COMPLETE')], [
      { key: 'g1:2', game_id: 'g1', round_no: 2, idem_key: 'k2', created_at: '2026-01-01T00:00:00' },
    ]),
    origins
  );
  assert.equal(roundEvents.length, 1);
  assert.equal(roundEvents[0].origin, 's2');
  assert.equal(roundEvents[0].event.kind, 'round');
  assert.equal(roundEvents[0].event.round, 2);

  const untagged = eventsWithOrigins(journal([txn('t5', '', 'No key', 'GIFT')]), origins);
  assert.equal(untagged.length, 1);
  assert.equal(untagged[0].origin, undefined);
});

// ---------- P1-10 / handshake hardening ----------

test('a peer that sends only hello is reaped after the handshake deadline', async () => {
  const stamp = unique('hello-only');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  const hub = installHub();

  try {
    host = await HostSession.start({ room, gameId, helloTimeoutMs: 120 });
    const transport = new FakeTransport('hello-only-peer', hub, {});
    hub.register(transport);
    const conn = transport.connect(hostPeerId(room));
    conn.onOpen(() => {
      conn.send({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        room,
        joinKey: `jk-${'a'.repeat(32)}`,
      });
    });

    await waitFor(() => host?.peers.length === 1, 'the hello-only peer');
    await waitFor(() => host?.peers.length === 0, 'the hello-only peer to be reaped', 3000);
    assert.equal(host.acceptedPeerCount, 0);
  } finally {
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('connections beyond the pending cap are rejected as busy', async () => {
  const stamp = unique('pending-cap');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  const hub = installHub();
  const raw: FakeTransport[] = [];

  try {
    host = await HostSession.start({ room, gameId });
    // Eight connections that never complete the handshake fill the pending cap.
    for (let i = 0; i < 8; i++) {
      const transport = new FakeTransport(`pending-${i}`, hub, {});
      hub.register(transport);
      raw.push(transport);
      transport.connect(hostPeerId(room));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    const ninth = new FakeTransport('pending-9', hub, {});
    hub.register(ninth);
    raw.push(ninth);
    const conn = ninth.connect(hostPeerId(room));
    const frames: any[] = [];
    conn.onData((data) => frames.push(data));

    await waitFor(
      () => frames.find((f) => f.t === 'join-rejected'),
      'the busy rejection'
    );
    assert.match(frames.find((f) => f.t === 'join-rejected').reason, /busy/i);
  } finally {
    for (const transport of raw) transport.destroy();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('a second connection for the same seat receives seat-replaced before closing', async () => {
  const stamp = unique('seat-replaced');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let first: ClientSession | null = null;
  let second: ClientSession | null = null;
  installHub();
  const bucketA = makeBucket();
  const bucketB = makeBucket();

  try {
    host = await HostSession.start({ room, gameId });
    first = await ClientSession.create(room, makeHandlers(bucketA));
    const joinA = first.join('Alice');
    joinA.catch(() => {});
    const pendingA = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');
    await host.approve(pendingA.sessionId);
    const infoA = await joinA;

    // The second tab reads the same stored joinKey and credentials.
    second = await ClientSession.create(room, makeHandlers(bucketB));
    const infoB = await second.join('Alice');
    assert.equal(infoB.playerId, infoA.playerId);

    await waitFor(
      () => bucketA.rejected.some((r) => /another device/i.test(r)),
      'the seat-replaced bye to be delivered'
    );
    assert.equal(first.isAccepted, false);
    assert.equal(bucketA.statuses.at(-1), 'error');
    assert.equal(second.isAccepted, true);
    await waitFor(() => host?.acceptedPeerCount === 1, 'the replaced connection to drop');
  } finally {
    second?.leave();
    first?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('a lost join-accepted in an active game restores the seat on reconnect', async () => {
  const stamp = unique('active-lost-ack');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let first: ClientSession | null = null;
  let dropped: ClientSession | null = null;
  let recovered: ClientSession | null = null;
  setCommitListener((j) => host?.broadcastJournal(j));
  const hub = installHub();
  const bucket = makeBucket();

  try {
    host = await HostSession.start({ room, gameId });
    first = await ClientSession.create(room, makeHandlers(bucket));
    const join = first.join('Alice');
    join.catch(() => {});
    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');
    await host.approve(pending.sessionId);
    const info = await join;

    await localApi(`/games/${gameId}/start`, { method: 'POST' });
    await waitFor(
      () => bucket.deltas.some((d) => d.journal.games[0]?.status === 'active'),
      'the active-game delta'
    );

    first.leave();
    first = null;
    await waitFor(() => host?.acceptedPeerCount === 0, 'the first connection to drop');

    // The game is active now; lose this join-accepted too.
    hub.dropNext((data) => (data as any)?.t === 'join-accepted');
    dropped = await ClientSession.create(room, makeHandlers(bucket));
    const lostJoin = dropped.join('Alice');
    lostJoin.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(dropped.isAccepted, false);
    assert.equal(host.acceptedPeerCount, 1);

    dropped.leave();
    dropped = null;
    await waitFor(() => host?.acceptedPeerCount === 0, 'the lost-ack connection to drop');

    recovered = await ClientSession.create(room, makeHandlers(makeBucket()));
    const recoveredInfo = await recovered.join('Alice');
    assert.equal(recoveredInfo.playerId, info.playerId);
    assert.equal(recovered.isAccepted, true);
    assert.equal((await loadGame(gameId)).players.length, 1);
  } finally {
    setCommitListener(null);
    recovered?.leave();
    dropped?.leave();
    first?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

// ---------- credential durability / reservation hygiene ----------

test('host reload restores seated players from the credential store without approval', async () => {
  const stamp = unique('host-reload');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  const store = new MemoryCredentialStore();
  let host: HostSession | null = null;
  let first: ClientSession | null = null;
  let reloaded: ClientSession | null = null;
  installHub();
  const bucket = makeBucket();

  try {
    host = await HostSession.start({ room, gameId, credentialStore: store });
    first = await ClientSession.create(room, makeHandlers(bucket));
    const join = first.join('Alice');
    join.catch(() => {});
    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');
    await host.approve(pending.sessionId);
    const info = await join;

    first.leave();
    first = null;
    await waitFor(() => host?.acceptedPeerCount === 0, 'the first connection to drop');

    host.stop({ notify: false });
    host = null;
    await waitFor(
      () => store.snapshot(gameId)?.reservations.some((r) => r.status === 'seated'),
      'the durable seat reservation'
    );

    host = await HostSession.start({ room, gameId, credentialStore: store });
    reloaded = await ClientSession.create(room, makeHandlers(makeBucket()));
    const info2 = await reloaded.join('Alice');
    assert.equal(info2.playerId, info.playerId);
    assert.equal(reloaded.isAccepted, true);
    assert.equal(host.acceptedPeerCount, 1);
    assert.equal((await loadGame(gameId)).players.length, 1);
  } finally {
    reloaded?.leave();
    first?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('a dropped pending request is pruned and notifies the banker again', async () => {
  const stamp = unique('pending-prune');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  const store = new MemoryCredentialStore();
  let host: HostSession | null = null;
  let first: ClientSession | null = null;
  let retry: ClientSession | null = null;
  let joinRequests = 0;
  installHub();

  try {
    host = await HostSession.start({
      room,
      gameId,
      credentialStore: store,
      onJoinRequest: () => {
        joinRequests += 1;
      },
    });
    first = await ClientSession.create(room, makeHandlers(makeBucket()));
    const join = first.join('Alice');
    join.catch(() => {});
    await waitFor(() => host?.peers.some((p) => p.status === 'pending'), 'the pending peer');
    await waitFor(
      () => store.snapshot(gameId)?.reservations.some((r) => r.status === 'pending'),
      'the pending reservation to persist'
    );
    assert.equal(joinRequests, 1);

    first.leave();
    first = null;
    await waitFor(() => host?.peers.length === 0, 'the pending peer to drop');
    await waitFor(
      () => !store.snapshot(gameId)?.reservations.some((r) => r.status === 'pending'),
      'the pending reservation to be pruned'
    );

    retry = await ClientSession.create(room, makeHandlers(makeBucket()));
    const retryJoin = retry.join('Alice');
    retryJoin.catch(() => {});
    await waitFor(() => joinRequests === 2, 'the rejoin notification');
  } finally {
    retry?.leave();
    first?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

// ---------- resync / observability ----------

test('an accepted peer whose resync cannot be verified is rejected explicitly', async () => {
  const stamp = unique('resync-reject');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  installHub();
  const bucket = makeBucket();

  try {
    host = await HostSession.start({ room, gameId });
    client = await ClientSession.create(room, makeHandlers(bucket));
    const join = client.join('Alice');
    join.catch(() => {});
    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');
    await host.approve(pending.sessionId);
    await join;

    // Simulate a resync whose credentials no longer match the host.
    (client as any).joinKey = `jk-${'f'.repeat(32)}`;
    (client as any).playerId = 'pl-stale';
    (client as any).playerToken = 'pt-stale';
    (client as any).sendHello();

    await waitFor(
      () => bucket.rejected.some((r) => /no longer available/i.test(r)),
      'the explicit resync rejection'
    );
    assert.equal(client.isAccepted, false);
    assert.equal(bucket.statuses.at(-1), 'error');
  } finally {
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('ping refreshes latency and reports it to the handler', async () => {
  const stamp = unique('latency');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let client: ClientSession | null = null;
  installHub();
  const bucket = makeBucket();

  try {
    host = await HostSession.start({ room, gameId });
    client = await ClientSession.create(room, makeHandlers(bucket));
    const join = client.join('Alice');
    join.catch(() => {});
    const pending = await waitFor(() => host?.peers.find((p) => p.status === 'pending'), 'pending');
    await host.approve(pending.sessionId);
    await join;

    client.ping();
    await waitFor(() => bucket.latencies.length > 0, 'the latency report');
    assert.ok(bucket.latencies.at(-1)! >= 0);
    assert.equal(client.latencyMs, bucket.latencies.at(-1));
  } finally {
    client?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});

test('a player event is delivered to peers but suppressed for its origin session', async () => {
  const stamp = unique('event-origin');
  const room = stamp;
  const gameId = await createTestGame(stamp);
  let host: HostSession | null = null;
  let alice: ClientSession | null = null;
  let bob: ClientSession | null = null;
  setCommitListener((j) => host?.broadcastJournal(j));
  installHub();
  const aliceBucket = makeBucket();
  const bobBucket = makeBucket();

  try {
    host = await HostSession.start({ room, gameId });
    alice = await ClientSession.create(room, makeHandlers(aliceBucket));
    const aliceJoin = alice.join('Alice');
    aliceJoin.catch(() => {});
    const alicePending = await waitFor(
      () => host?.peers.find((p) => p.status === 'pending' && p.name === 'Alice'),
      'Alice pending'
    );
    await host.approve(alicePending.sessionId);
    const aliceInfo = await aliceJoin;

    // Force a distinct joinKey for the second seat in the same room.
    localStorage.removeItem(`banker_session_${room}`);
    bob = await ClientSession.create(room, makeHandlers(bobBucket));
    const bobJoin = bob.join('Bob');
    bobJoin.catch(() => {});
    const bobPending = await waitFor(
      () => host?.peers.find((p) => p.status === 'pending' && p.name === 'Bob'),
      'Bob pending'
    );
    await host.approve(bobPending.sessionId);
    const bobInfo = await bobJoin;
    await waitFor(() => host?.acceptedPeerCount === 2, 'both seats accepted');

    await localApi(`/games/${gameId}/start`, { method: 'POST' });
    await waitFor(
      () => aliceBucket.deltas.some((d) => d.journal.games[0]?.status === 'active'),
      'the start delta'
    );

    aliceBucket.events.length = 0;
    bobBucket.events.length = 0;
    await alice.command(`/games/${gameId}/transfers`, {
      method: 'POST',
      body: {
        from: { type: 'player', id: aliceInfo.playerId },
        to: { type: 'player', id: bobInfo.playerId },
        amount: 25,
        account_category: 'GIFT',
        description: 'Origin-scoped event',
      },
    });

    await waitFor(
      () => bobBucket.events.some((e) => e.description === 'Origin-scoped event'),
      'Bob to receive the event'
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      aliceBucket.events.some((e) => e.description === 'Origin-scoped event'),
      false
    );
  } finally {
    setCommitListener(null);
    bob?.leave();
    alice?.leave();
    host?.stop({ notify: false });
    resetPeerFactory();
  }
});
