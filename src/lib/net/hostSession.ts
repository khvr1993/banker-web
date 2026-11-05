// Host session: owns the PeerJS peer, approves players, authorizes commands,
// and broadcasts committed journal deltas. The host is the only writer.
import { Dump, GameBundle, Journal, SerializedJournal, journalToSerialized, loadGame } from '../db';
import { localApi } from '../api';
import { validName } from '../service';
import {
  ChunkAssembler,
  MAX_ASSEMBLER_BYTES,
  byteLength,
  encodeMessage,
  sendMessage,
} from './codec';
import { createTransport } from './peerFactory';
import { Transport, TransportConnection } from './transportTypes';
import { authorizeCommand, gameIdFromPath } from './authz';
import { clientIdempotencyKey, playerIdempotencyKey } from './idempotency';
import { sanitizeJoinKey } from './joinKey';
import {
  HostCredentialStore,
  JoinReservation,
  createHostCredentialStore,
} from './hostCredentials';
import { buildJoinUrl } from './joinUrl';
import { randomId } from '../random';
import {
  ClientMessage,
  CmdMessage,
  HostByeCode,
  HostMessage,
  RemoteEvent,
  PROTOCOL_VERSION,
  MAX_MESSAGE_CHARS,
  hostPeerId,
  isClientMessage,
  parseIncoming,
  sanitizeRoom,
} from './protocol';

const MAX_COMMANDS_PER_SECOND = 10;
const MAX_SEATS = 12;
const MAX_CONNECTIONS = 32;
const MAX_PENDING_CONNECTIONS = 8;
const HELLO_TIMEOUT_MS = 15_000;
const MAX_INBOUND_MESSAGES_PER_SECOND = 50;
// Pending join requests are cheap but persisted; expire and cap them so an
// abandoning or hostile peer cannot grow the credential store without bound.
const PENDING_RESERVATION_TTL_MS = 10 * 60_000;
const MAX_PENDING_RESERVATIONS = 16;

export interface RemotePeerInfo {
  sessionId: string;
  name: string;
  playerId: string | null;
  status: 'pending' | 'connected';
  connected: boolean;
  /** A device asking to reclaim an existing seat after the game started. */
  reclaiming?: boolean;
}

export interface HostSessionHooks {
  /** Test seam: runs before the join snapshot is read. */
  beforeAcceptSnapshot?: () => Promise<void>;
}

export interface HostSessionOptions {
  room: string;
  gameId: string;
  onPeersChanged?: (peers: RemotePeerInfo[]) => void;
  onJoinRequest?: (peer: RemotePeerInfo) => void;
  onError?: (message: string) => void;
  onLog?: (message: string) => void;
  publicBaseUrl?: string;
  helloTimeoutMs?: number;
  credentialStore?: HostCredentialStore;
  hooks?: HostSessionHooks;
}

interface PeerRecord {
  sessionId: string;
  conn: TransportConnection;
  name: string;
  playerId: string | null;
  joinKey: string;
  /** Existing seat this pending device may reclaim (lost local credentials). */
  reclaimPlayerId: string | null;
  accepted: boolean;
  accepting: boolean;
  joining: boolean;
  joinBuffer: HostMessage[];
  helloDone: boolean;
  cmdTimes: number[];
  inboundTimes: number[];
  assembler: ChunkAssembler;
  helloTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

interface StopOptions {
  reason?: string;
  code?: HostByeCode;
  notify?: boolean;
}

export function filterJournalForGame(j: SerializedJournal, gameId: string): SerializedJournal {
  return {
    games: j.games.filter((g) => g.id === gameId),
    players: j.players.filter((p) => p.game_id === gameId),
    txns: j.txns.filter((t) => t.game_id === gameId),
    rounds: j.rounds.filter((r) => r.game_id === gameId),
    audit: j.audit.filter((a) => a.game_id === gameId),
    deletedPlayers: j.deletedPlayers.filter((d) => d.game_id === gameId),
  };
}

export function isEmptySerializedJournal(j: SerializedJournal): boolean {
  return (
    j.games.length === 0 &&
    j.players.length === 0 &&
    j.txns.length === 0 &&
    j.rounds.length === 0 &&
    j.audit.length === 0 &&
    j.deletedPlayers.length === 0
  );
}

/** Builds toast/sound events from the transactions in one delta. */
export function eventsForJournal(j: SerializedJournal): RemoteEvent[] {
  return eventsWithOrigins(j, new Map()).map((item) => item.event);
}

export interface OriginatedEvent {
  event: RemoteEvent;
  origin: string | undefined;
}

/** Attributes each event to the session whose command produced it. */
export function eventsWithOrigins(
  j: SerializedJournal,
  origins: Map<string, string>
): OriginatedEvent[] {
  if (j.rounds.length > 0) {
    let origin: string | undefined;
    for (const t of j.txns) {
      if (!t.idempotency_key) continue;
      const found = origins.get(t.idempotency_key);
      if (found) {
        origin = found;
        break;
      }
    }
    return [{ event: { kind: 'round', round: j.rounds[0].round_no }, origin }];
  }

  const events: OriginatedEvent[] = [];
  const seen = new Set<string>();
  for (const t of j.txns) {
    const origin = t.idempotency_key ? origins.get(t.idempotency_key) : undefined;
    const kind: RemoteEvent['kind'] =
      t.txn_type === 'VOID' ? 'void' : t.account_category === 'ROUND_COMPLETE' ? 'round' : 'transfer';
    const key = `${origin ?? ''}:${kind}:${t.account_category}:${t.amount}:${t.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      event: {
        kind,
        amount: t.amount,
        category: t.account_category,
        description: t.description,
        round: t.round,
      },
      origin,
    });
    if (events.length >= 5) break;
  }
  return events;
}

function newPlayerToken(): string {
  return randomId('pt', 16);
}

function normalizedName(name: string): string {
  return String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Finds the one existing seat a device may reclaim by its display name.
 * Used after the game starts, when a device lost its local joinKey (for
 * example a private window was closed) but the banker wants to re-admit it.
 */
export function findReclaimablePlayer<T extends { id: string; name: string }>(
  players: T[],
  name: string,
  preferredId?: string | null
): T | null {
  const target = normalizedName(name);
  if (!target) return null;
  const matches = players.filter((p) => normalizedName(p.name) === target);
  if (preferredId) {
    const preferred = matches.find((p) => p.id === preferredId);
    if (preferred) return preferred;
  }
  return matches.length === 1 ? matches[0] : null;
}

export class HostSession {
  readonly room: string;
  readonly gameId: string;

  private options: HostSessionOptions;
  private transport: Transport | null = null;
  private connections = new Map<string, PeerRecord>();
  private tokens = new Map<string, string>();
  private reservations = new Map<string, JoinReservation>();
  private credentialStore: HostCredentialStore;
  private approvingJoinKeys = new Set<string>();
  private notifiedJoinKeys = new Set<string>();
  private commandOrigins = new Map<string, string>();
  private rev = 0;
  private stopped = false;

  private constructor(room: string, gameId: string, options: HostSessionOptions) {
    this.room = sanitizeRoom(room);
    this.gameId = gameId;
    this.options = options;
    this.credentialStore = options.credentialStore || createHostCredentialStore();
  }

  static async start(options: HostSessionOptions): Promise<HostSession> {
    const session = new HostSession(options.room, options.gameId, options);
    await session.loadCredentials();
    session.transport = await createTransport(
      hostPeerId(session.room),
      {
        onConnection: (conn) => session.handleConnection(conn),
        onError: (err) => session.options.onError?.(`Signaling error: ${err.message}`),
        onDisconnected: () => session.options.onLog?.('Signaling disconnected, retrying…'),
      },
      { openTimeoutMs: 12_000, totalTimeoutMs: 25_000 }
    );
    return session;
  }

  get joinUrl(): string {
    return buildJoinUrl(this.room, this.options.publicBaseUrl);
  }

  get hostRev(): number {
    return this.rev;
  }

  get peers(): RemotePeerInfo[] {
    const out: RemotePeerInfo[] = [];
    const seenJoinKeys = new Set<string>();
    for (const r of this.connections.values()) {
      if (!r.helloDone || r.closed) continue;
      if (!r.accepted && r.joinKey) {
        if (seenJoinKeys.has(r.joinKey)) continue;
        seenJoinKeys.add(r.joinKey);
      }
      out.push({
        sessionId: r.sessionId,
        name: r.name || 'Guest',
        playerId: r.playerId,
        status: r.accepted ? 'connected' : 'pending',
        connected: r.accepted,
        reclaiming: !r.accepted && Boolean(r.reclaimPlayerId),
      });
    }
    return out;
  }

  get acceptedPeerCount(): number {
    return [...this.connections.values()].filter((r) => r.accepted && !r.closed).length;
  }

  /** Approves a pending join request by seating the player on the host. */
  async approve(sessionId: string): Promise<void> {
    const record = this.connections.get(sessionId);
    if (!record || record.accepted || record.accepting) return;
    const joinKey = record.joinKey;
    if (!joinKey) {
      this.reject(record, 'Reload the app to reconnect.');
      return;
    }
    if (this.approvingJoinKeys.has(joinKey)) return;
    record.accepting = true;
    this.approvingJoinKeys.add(joinKey);
    try {
      const existing = this.reservations.get(joinKey);
      if (existing?.status === 'seated' && existing.playerId) {
        await this.accept(record, existing.playerId, existing.playerToken);
        return;
      }

      const bundle = await loadGame(this.gameId);
      if (!bundle.game) {
        this.reject(record, 'Game not found on the host');
        return;
      }

      // After the game starts no new seats can be created. The banker may
      // still explicitly re-admit an existing seat when a device lost its
      // local join key (private window, cleared storage, new browser).
      if (bundle.game.status !== 'pending') {
        const player = findReclaimablePlayer(
          bundle.players,
          record.name,
          record.reclaimPlayerId
        );
        if (!player) {
          this.reject(
            record,
            'This game has already started and that seat no longer exists. Ask the banker to check your name.'
          );
          return;
        }
        const token = newPlayerToken();
        this.tokens.set(player.id, token);
        // Rebind the durable seat to this device. The old key is revoked so a
        // stale copy of the credentials cannot keep claiming the same seat.
        for (const [key, res] of [...this.reservations.entries()]) {
          if (res.playerId === player.id && key !== joinKey) {
            this.reservations.delete(key);
            this.notifiedJoinKeys.delete(key);
          }
        }
        this.reservations.set(joinKey, {
          joinKey,
          playerId: player.id,
          playerToken: token,
          name: player.name,
          gameId: this.gameId,
          status: 'seated',
          createdAt: Date.now(),
        });
        await this.saveCredentials();
        await this.accept(record, player.id, token);
        return;
      }

      const name = record.name || 'Player';
      const seated = await localApi(`/games/${this.gameId}/players`, {
        method: 'POST',
        body: { name },
      });
      const playerId = seated?.id;
      if (!playerId) throw new Error('Could not seat the player on the host');
      const token = newPlayerToken();
      this.tokens.set(playerId, token);
      this.reservations.set(joinKey, {
        joinKey,
        playerId,
        playerToken: token,
        name,
        gameId: this.gameId,
        status: 'seated',
        createdAt: Date.now(),
      });
      // Durable before the ack: a lost join-accepted must still recover the seat.
      await this.saveCredentials();
      await this.accept(record, playerId, token);
    } finally {
      this.approvingJoinKeys.delete(joinKey);
      record.accepting = false;
    }
  }

  deny(sessionId: string, reason = 'Join request denied by the banker'): void {
    const record = this.connections.get(sessionId);
    if (!record) return;
    if (record.joinKey) {
      const reservation = this.reservations.get(record.joinKey);
      if (reservation?.status === 'pending') {
        this.reservations.delete(record.joinKey);
        void this.saveCredentials();
      }
      // Let a future rejoin notify the banker again.
      this.notifiedJoinKeys.delete(record.joinKey);
    }
    this.send(record, { t: 'join-rejected', reason });
    this.closeSoon(record);
  }

  kick(sessionId: string): void {
    const record = this.connections.get(sessionId);
    if (!record) return;
    if (record.playerId) {
      this.tokens.delete(record.playerId);
      for (const [key, res] of this.reservations) {
        if (res.playerId === record.playerId) {
          this.reservations.delete(key);
          this.notifiedJoinKeys.delete(key);
        }
      }
      void this.saveCredentials();
    }
    if (record.joinKey) this.notifiedJoinKeys.delete(record.joinKey);
    this.send(record, { t: 'host-bye', code: 'removed', reason: 'Removed by the banker' });
    this.closeSoon(record);
  }

  stop(options: StopOptions = {}): void {
    if (this.stopped) return;
    this.stopped = true;
    const {
      notify = true,
      code = 'host-stopped',
      reason = 'The banker ended the session',
    } = options;

    void this.saveCredentials();

    for (const record of this.connections.values()) {
      if (notify) this.send(record, { t: 'host-bye', code, reason });
      else record.conn.close();
    }
    const finish = () => {
      for (const record of this.connections.values()) record.conn.close();
      this.connections.clear();
      try {
        this.transport?.destroy();
      } catch {
        // ignore
      }
      this.transport = null;
      this.emitPeers();
    };
    if (notify) setTimeout(finish, 150);
    else finish();
  }

  /** Called by the host commit listener; returns the delta revision sent. */
  broadcastJournal(j: Journal): void {
    if (this.stopped || !this.transport) return;
    const filtered = filterJournalForGame(journalToSerialized(j), this.gameId);
    if (isEmptySerializedJournal(filtered)) return;
    this.rev += 1;
    const delta: HostMessage = { t: 'delta', rev: this.rev, journal: filtered };
    const originated = eventsWithOrigins(filtered, this.commandOrigins);

    for (const record of this.connections.values()) {
      if (record.closed) continue;
      const messages: HostMessage[] = [delta];
      for (const item of originated) {
        if (item.origin !== record.sessionId) {
          messages.push({ t: 'event', event: item.event });
        }
      }
      if (record.joining) {
        // A joining or resyncing peer must receive its baseline before deltas.
        record.joinBuffer.push(...messages);
      } else if (record.accepted) {
        for (const message of messages) this.send(record, message);
      }
    }
  }

  private snapshotFromBundle(bundle: GameBundle): Dump {
    return {
      games: bundle.game ? [bundle.game] : [],
      players: bundle.players,
      txns: bundle.txns,
      rounds: bundle.rounds,
      audit: bundle.audit,
    };
  }

  private welcomeMessage(): HostMessage {
    return { t: 'welcome', protocol: PROTOCOL_VERSION, room: this.room };
  }

  // ---------- credential persistence ----------

  private async loadCredentials(): Promise<void> {
    try {
      const snapshot = await this.credentialStore.load(this.gameId);
      if (!snapshot) return;
      for (const [pid, token] of Object.entries(snapshot.tokens)) {
        this.tokens.set(pid, token);
      }
      for (const res of snapshot.reservations) {
        this.reservations.set(res.joinKey, res);
      }
      this.pruneReservations();
    } catch (err) {
      this.options.onLog?.(`Could not load seat credentials: ${String(err)}`);
    }
  }

  private async saveCredentials(): Promise<void> {
    this.pruneReservations();
    const tokens: Record<string, string> = {};
    for (const [pid, token] of this.tokens) tokens[pid] = token;
    try {
      await this.credentialStore.save(this.gameId, {
        reservations: [...this.reservations.values()],
        tokens,
      });
    } catch (err) {
      this.options.onLog?.(`Could not save seat credentials: ${String(err)}`);
    }
  }

  /**
   * Drops expired pending reservations and caps how many can be persisted.
   * Seated reservations never expire: they are the durable rejoin credential.
   */
  private pruneReservations(now = Date.now()): void {
    for (const [key, res] of [...this.reservations.entries()]) {
      if (res.status !== 'pending') continue;
      if (now - (Number(res.createdAt) || 0) <= PENDING_RESERVATION_TTL_MS) continue;
      this.reservations.delete(key);
      this.notifiedJoinKeys.delete(key);
    }

    const pending = [...this.reservations.entries()]
      .filter(([, res]) => res.status === 'pending')
      .sort((a, b) => (Number(a[1].createdAt) || 0) - (Number(b[1].createdAt) || 0));
    while (pending.length > MAX_PENDING_RESERVATIONS) {
      const [key] = pending.shift()!;
      this.reservations.delete(key);
      this.notifiedJoinKeys.delete(key);
    }
  }

  // ---------- connection lifecycle ----------

  private handleConnection(conn: TransportConnection): void {
    if (this.stopped) {
      conn.close();
      return;
    }

    const pending = [...this.connections.values()].filter((r) => !r.accepted && !r.closed).length;
    if (this.connections.size >= MAX_CONNECTIONS || pending >= MAX_PENDING_CONNECTIONS) {
      sendMessage(conn, {
        t: 'join-rejected',
        reason: 'The table is busy. Wait a moment and try again.',
      });
      setTimeout(() => conn.close(), 150);
      return;
    }

    const record: PeerRecord = {
      sessionId: randomId('peer', 6),
      conn,
      name: '',
      playerId: null,
      joinKey: '',
      reclaimPlayerId: null,
      accepted: false,
      accepting: false,
      joining: false,
      joinBuffer: [],
      helloDone: false,
      cmdTimes: [],
      inboundTimes: [],
      assembler: new ChunkAssembler(),
      helloTimer: null,
      closed: false,
    };
    record.helloTimer = setTimeout(() => {
      record.helloTimer = null;
      record.conn.close();
    }, this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    this.connections.set(record.sessionId, record);
    conn.onData((raw) => this.handleRaw(record, raw));
    conn.onClose(() => this.dropRecord(record));
  }

  private dropRecord(record: PeerRecord): void {
    if (record.closed) return;
    record.closed = true;
    this.clearHelloTimer(record);
    record.assembler.reset();
    this.connections.delete(record.sessionId);

    const joinKey = record.joinKey;
    if (joinKey) {
      const stillConnected = [...this.connections.values()].some(
        (r) => !r.closed && r.joinKey === joinKey
      );
      if (!stillConnected) {
        // A dropped pending request must be forgotten so a rejoin notifies the
        // banker again and cannot leave a stale reservation behind.
        this.notifiedJoinKeys.delete(joinKey);
        const reservation = this.reservations.get(joinKey);
        if (reservation?.status === 'pending') {
          this.reservations.delete(joinKey);
          void this.saveCredentials();
        }
      }
    }
    this.emitPeers();
  }

  private emitPeers(): void {
    this.options.onPeersChanged?.(this.peers);
  }

  private send(record: PeerRecord, msg: HostMessage): void {
    if (record.closed) return;
    sendMessage(record.conn, msg);
  }

  private reject(record: PeerRecord, reason: string): void {
    this.send(record, { t: 'join-rejected', reason });
    this.closeSoon(record);
  }

  /**
   * A storage failure on the host must not leave a pending peer waiting for a
   * reply or surface as an unhandled rejection. Send a visible rejection.
   */
  private failPeer(record: PeerRecord, err: unknown): void {
    this.options.onLog?.(`Peer handshake failed: ${String(err)}`);
    this.reject(record, 'The banker device could not load the game. Retry in a moment.');
  }

  private closeSoon(record: PeerRecord): void {
    setTimeout(() => record.conn.close(), 150);
  }

  private allowInbound(record: PeerRecord): boolean {
    const now = Date.now();
    record.inboundTimes = record.inboundTimes.filter((t) => now - t < 1000);
    if (record.inboundTimes.length >= MAX_INBOUND_MESSAGES_PER_SECOND) {
      record.conn.close();
      return false;
    }
    record.inboundTimes.push(now);
    return true;
  }

  private handleRaw(record: PeerRecord, raw: unknown): void {
    if (typeof raw === 'string' && raw.length > MAX_MESSAGE_CHARS) {
      record.conn.close();
      return;
    }
    if (!this.allowInbound(record)) return;
    let msg = parseIncoming(raw);
    if (!msg || typeof msg !== 'object') return;
    if ((msg as any).t === 'chunk') {
      const assembled = record.assembler.push((msg as any));
      if (!assembled) return;
      msg = assembled;
    }
    if (!isClientMessage(msg)) return;
    if (!record.helloDone && msg.t !== 'hello') {
      this.reject(record, 'Complete the join handshake first');
      return;
    }
    switch (msg.t) {
      case 'hello':
        void this.handleHello(record, msg).catch((err) => this.failPeer(record, err));
        break;
      case 'join-request':
        void this.handleJoinRequest(record, msg).catch((err) => this.failPeer(record, err));
        break;
      case 'cmd':
        void this.handleCommand(record, msg);
        break;
      case 'ping':
        this.send(record, { t: 'pong', ts: msg.ts });
        break;
      case 'bye':
        record.conn.close();
        break;
      default:
        break;
    }
  }

  private clearHelloTimer(record: PeerRecord): void {
    if (record.helloTimer) clearTimeout(record.helloTimer);
    record.helloTimer = null;
  }

  private markHelloDone(record: PeerRecord): void {
    // Do not clear the timer here: a peer that sends only `hello` and never a
    // join request must still be reaped. The timer is cleared when the join
    // handshake actually completes (join-request or accept).
    record.helloDone = true;
  }

  private async handleHello(
    record: PeerRecord,
    msg: Extract<ClientMessage, { t: 'hello' }>
  ): Promise<void> {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.reject(record, 'This device and the host are running different app versions');
      return;
    }
    if (sanitizeRoom(msg.room) !== this.room) {
      this.reject(record, 'Unknown room code');
      return;
    }
    record.joinKey = sanitizeJoinKey(msg.joinKey);
    this.markHelloDone(record);

    if (await this.verifyRejoin(msg.playerId, msg.playerToken, record.joinKey)) {
      await this.accept(record, msg.playerId as string, msg.playerToken as string);
      return;
    }

    const seated = record.joinKey ? this.reservations.get(record.joinKey) : undefined;
    if (seated?.status === 'seated' && seated.playerId) {
      await this.accept(record, seated.playerId, seated.playerToken);
      return;
    }

    this.send(record, this.welcomeMessage());
  }

  private async handleJoinRequest(
    record: PeerRecord,
    msg: Extract<ClientMessage, { t: 'join-request' }>
  ): Promise<void> {
    const name = String(msg.name || '').trim();
    if (!validName(name)) {
      this.reject(record, 'Please choose a name between 1 and 64 characters');
      return;
    }
    const joinKey = sanitizeJoinKey(msg.joinKey);
    if (!joinKey) {
      this.reject(record, 'Reload the app to reconnect.');
      return;
    }

    if (record.accepted) {
      // An accepted peer reaches this path only when a resync `hello` could not
      // be verified. Revalidate, otherwise reject explicitly instead of leaving
      // the client waiting on an ack that will never arrive.
      if (await this.verifyRejoin(msg.playerId, msg.playerToken, joinKey)) {
        await this.accept(record, msg.playerId as string, msg.playerToken as string);
      } else {
        this.reject(record, 'This seat is no longer available. Ask the banker to re-admit you.');
      }
      return;
    }

    record.name = name;
    record.joinKey = joinKey;
    this.markHelloDone(record);
    // The peer has completed the handshake; the 15s reaper no longer applies.
    this.clearHelloTimer(record);

    if (await this.verifyRejoin(msg.playerId, msg.playerToken, joinKey)) {
      await this.accept(record, msg.playerId as string, msg.playerToken as string);
      return;
    }

    const seated = this.reservations.get(joinKey);
    if (seated?.status === 'seated' && seated.playerId) {
      await this.accept(record, seated.playerId, seated.playerToken);
      return;
    }

    const bundle = await loadGame(this.gameId);
    if (!bundle.game) {
      this.reject(record, 'Game not found on the host');
      return;
    }
    if (bundle.game.status !== 'pending') {
      // A cleared/private-window device has no local joinKey, so it cannot be
      // verified automatically. Surface the request to the banker instead of
      // rejecting outright; they can explicitly re-admit a matching seat.
      const player = findReclaimablePlayer(bundle.players, name);
      if (!player) {
        const ambiguous = bundle.players.some(
          (p) => normalizedName(p.name) === normalizedName(name)
        );
        this.reject(
          record,
          ambiguous
            ? 'More than one seat uses that name. Ask the banker to reconnect you.'
            : 'This game has already started. Only existing seats can reconnect.'
        );
        return;
      }
      record.reclaimPlayerId = player.id;
    } else {
      record.reclaimPlayerId = null;
      if (!seated && bundle.players.length >= MAX_SEATS) {
        this.reject(record, 'This table is full');
        return;
      }
    }

    this.reservations.set(joinKey, {
      joinKey,
      playerId: null,
      playerToken: '',
      name,
      gameId: this.gameId,
      status: 'pending',
      createdAt: Date.now(),
    });
    void this.saveCredentials();

    this.send(record, { t: 'join-pending' });
    this.emitPeers();
    if (!this.notifiedJoinKeys.has(joinKey)) {
      this.notifiedJoinKeys.add(joinKey);
      const info = this.peers.find((p) => p.sessionId === record.sessionId);
      if (info) this.options.onJoinRequest?.(info);
    }
  }

  private async verifyRejoin(
    playerId?: string,
    token?: string,
    joinKey?: string
  ): Promise<boolean> {
    if (!playerId || !token) return false;
    const known =
      this.tokens.get(playerId) === token ||
      [...this.reservations.values()].some(
        (r) => r.playerId === playerId && r.playerToken === token && r.status === 'seated'
      );
    if (!known) return false;

    const bundle = await loadGame(this.gameId);
    const player = bundle.players.find((p) => p.id === playerId);
    if (!player) return false;

    if (joinKey) {
      const bound = this.reservations.get(joinKey);
      if (bound && bound.playerId && bound.playerId !== playerId) return false;
      if (!bound) {
        this.reservations.set(joinKey, {
          joinKey,
          playerId,
          playerToken: token,
          name: player.name,
          gameId: this.gameId,
          status: 'seated',
          createdAt: Date.now(),
        });
        void this.saveCredentials();
      }
    }
    return true;
  }

  private async accept(record: PeerRecord, playerId: string, token: string): Promise<void> {
    if (record.accepted && record.playerId !== playerId) return;
    // A successful accept also completes the join handshake.
    this.clearHelloTimer(record);

    record.joining = true;
    record.joinBuffer = [];
    const revAt = this.rev;
    let completed = false;

    try {
      if (this.options.hooks?.beforeAcceptSnapshot) {
        await this.options.hooks.beforeAcceptSnapshot();
      }
      const bundle = await loadGame(this.gameId);
      const player = bundle.players.find((p) => p.id === playerId);
      if (!player) {
        this.reject(record, 'Seat not found on this game');
        return;
      }

      const accepted: HostMessage = {
        t: 'join-accepted',
        playerId,
        playerToken: token,
        gameId: this.gameId,
        rev: revAt,
        snapshot: this.snapshotFromBundle(bundle),
      };
      if (byteLength(encodeMessage(accepted)) > MAX_ASSEMBLER_BYTES) {
        this.reject(record, 'Game history too large to sync. Start a new game.');
        return;
      }

      // Displace any other device holding this seat only after the new join has
      // been fully validated, so a failed resync cannot evict a working seat.
      if (!record.accepted) {
        for (const other of this.connections.values()) {
          if (other.sessionId === record.sessionId || !other.accepted) continue;
          if (other.playerId !== playerId) continue;
          this.send(other, {
            t: 'host-bye',
            code: 'seat-replaced',
            reason: 'This seat opened on another device',
          });
          this.closeSoon(other);
        }
      }

      // No await between here and sending the ack: a concurrent commit cannot
      // overtake the join-accepted that establishes its baseline.
      record.accepted = true;
      record.playerId = playerId;
      record.name = player.name;
      record.joining = false;
      const buffered = record.joinBuffer;
      record.joinBuffer = [];
      this.send(record, accepted);
      for (const message of buffered) this.send(record, message);
      completed = true;
      this.emitPeers();
    } catch (err) {
      // Local storage can now time out instead of hanging; tell the client
      // rather than letting the rejection escape from a voided async call.
      this.options.onLog?.(`Could not accept peer: ${String(err)}`);
      this.reject(record, 'The banker device could not load the game. Retry in a moment.');
    } finally {
      if (!completed) {
        record.joining = false;
        record.joinBuffer = [];
        // A peer that failed to resync must not keep receiving deltas against a
        // stale mirror after its replacement was rejected/closed.
        record.accepted = false;
      }
    }
  }

  // ---------- commands ----------

  private allowRate(record: PeerRecord): boolean {
    const now = Date.now();
    record.cmdTimes = record.cmdTimes.filter((t) => now - t < 1000);
    if (record.cmdTimes.length >= MAX_COMMANDS_PER_SECOND) return false;
    record.cmdTimes.push(now);
    return true;
  }

  private async handleCommand(record: PeerRecord, msg: CmdMessage): Promise<void> {
    if (!record.accepted || !record.playerId) {
      this.send(record, {
        t: 'nack',
        id: msg.id,
        error: { status: 403, type: 'FORBIDDEN', message: 'Join the session before sending commands' },
      });
      return;
    }
    if (!this.allowRate(record)) {
      this.send(record, {
        t: 'nack',
        id: msg.id,
        error: { status: 429, type: 'RATE_LIMITED', message: 'Slow down — too many requests' },
      });
      return;
    }

    const path = String(msg.path || '');
    const method = String(msg.method || 'GET').toUpperCase();
    if (gameIdFromPath(path) !== this.gameId) {
      this.send(record, {
        t: 'nack',
        id: msg.id,
        error: { status: 404, type: 'NOT_FOUND', message: 'This command targets a different game' },
      });
      return;
    }

    const auth = authorizeCommand(record.playerId, path, method, msg.body);
    if (!auth.ok) {
      this.send(record, {
        t: 'nack',
        id: msg.id,
        error: { status: auth.status, type: auth.type, message: auth.message },
      });
      return;
    }

    // Whitelist: the local API only understands Idempotency-Key, and player keys
    // must never collide with host-generated keys.
    const key = playerIdempotencyKey(
      record.playerId,
      clientIdempotencyKey(msg.headers, msg.id)
    );

    // The commit listener runs synchronously before localApi resolves, so the
    // origin map is populated when the delta is broadcast.
    this.commandOrigins.set(key, record.sessionId);
    try {
      const result = await localApi(path, {
        method,
        body: msg.body,
        headers: { 'Idempotency-Key': key },
        actor: `player:${record.playerId}`,
      });
      this.send(record, { t: 'ack', id: msg.id, result: result ?? null });
    } catch (err: any) {
      this.send(record, {
        t: 'nack',
        id: msg.id,
        error: {
          status: Number(err?.status) || 500,
          type: String(err?.type || 'INTERNAL'),
          message: String(err?.message || 'Command failed'),
        },
      });
    } finally {
      this.commandOrigins.delete(key);
    }
  }
}
