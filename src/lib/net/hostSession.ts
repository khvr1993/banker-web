// Host session: owns the PeerJS peer, approves players, authorizes commands,
// and broadcasts committed journal deltas. The host is the only writer.
import { Dump, Journal, SerializedJournal, journalToSerialized, loadGame } from '../db';
import { localApi } from '../api';
import { validName } from '../service';
import { ChunkAssembler, sendMessage } from './codec';
import { createTransport } from './peerFactory';
import { Transport, TransportConnection } from './transportTypes';
import { authorizeCommand, gameIdFromPath } from './authz';
import {
  ClientMessage,
  CmdMessage,
  HostMessage,
  RemoteEvent,
  PROTOCOL_VERSION,
  hostPeerId,
  isClientMessage,
  parseIncoming,
  sanitizeRoom,
} from './protocol';

const MAX_COMMANDS_PER_SECOND = 10;
const MAX_SEATS = 12;

export interface RemotePeerInfo {
  sessionId: string;
  name: string;
  playerId: string | null;
  status: 'pending' | 'connected';
  connected: boolean;
}

export interface HostSessionOptions {
  room: string;
  gameId: string;
  onPeersChanged?: (peers: RemotePeerInfo[]) => void;
  onJoinRequest?: (peer: RemotePeerInfo) => void;
  onError?: (message: string) => void;
  onLog?: (message: string) => void;
}

interface PeerRecord {
  sessionId: string;
  conn: TransportConnection;
  name: string;
  playerId: string | null;
  accepted: boolean;
  accepting: boolean;
  helloDone: boolean;
  cmdTimes: number[];
  assembler: ChunkAssembler;
  closed: boolean;
}

export function buildJoinUrl(room: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}?join=${encodeURIComponent(sanitizeRoom(room))}`;
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
  if (j.rounds.length > 0) {
    return [{ kind: 'round', round: j.rounds[0].round_no }];
  }
  const events: RemoteEvent[] = [];
  const seen = new Set<string>();
  for (const t of j.txns) {
    const kind: RemoteEvent['kind'] =
      t.txn_type === 'VOID' ? 'void' : t.account_category === 'ROUND_COMPLETE' ? 'round' : 'transfer';
    const key = `${kind}:${t.account_category}:${t.amount}:${t.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      kind,
      amount: t.amount,
      category: t.account_category,
      description: t.description,
      round: t.round,
    });
    if (events.length >= 5) break;
  }
  return events;
}

function tokenStoreKey(gameId: string): string {
  return `banker_tokens_${gameId}`;
}

function newPlayerToken(): string {
  return `pt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class HostSession {
  readonly room: string;
  readonly gameId: string;

  private options: HostSessionOptions;
  private transport: Transport | null = null;
  private connections = new Map<string, PeerRecord>();
  private tokens = new Map<string, string>();
  private rev = 0;
  private counter = 0;
  private stopped = false;
  private suppressEventsFor: string | null = null;

  private constructor(room: string, gameId: string, options: HostSessionOptions) {
    this.room = sanitizeRoom(room);
    this.gameId = gameId;
    this.options = options;
  }

  static async start(options: HostSessionOptions): Promise<HostSession> {
    const session = new HostSession(options.room, options.gameId, options);
    session.loadTokens();
    session.transport = await createTransport(hostPeerId(session.room), {
      onConnection: (conn) => session.handleConnection(conn),
      onError: (err) => session.options.onError?.(`Signaling error: ${err.message}`),
      onDisconnected: () => session.options.onLog?.('Signaling disconnected, retrying…'),
    });
    return session;
  }

  get joinUrl(): string {
    return buildJoinUrl(this.room);
  }

  get hostRev(): number {
    return this.rev;
  }

  get peers(): RemotePeerInfo[] {
    return [...this.connections.values()]
      .filter((r) => r.helloDone && !r.closed)
      .map((r) => ({
        sessionId: r.sessionId,
        name: r.name || 'Guest',
        playerId: r.playerId,
        status: r.accepted ? 'connected' : 'pending',
        connected: r.accepted,
      }));
  }

  get acceptedPeerCount(): number {
    return [...this.connections.values()].filter((r) => r.accepted && !r.closed).length;
  }

  /** Approves a pending join request by seating the player on the host. */
  async approve(sessionId: string): Promise<void> {
    const record = this.connections.get(sessionId);
    if (!record || record.accepted || record.accepting) return;
    record.accepting = true;
    try {
      const name = record.name || 'Player';
      const seated = await localApi(`/games/${this.gameId}/players`, {
        method: 'POST',
        body: { name },
      });
      const playerId = seated?.id;
      if (!playerId) throw new Error('Could not seat the player on the host');
      const token = newPlayerToken();
      this.tokens.set(playerId, token);
      this.persistTokens();
      await this.accept(record, playerId, token);
    } finally {
      record.accepting = false;
    }
  }

  deny(sessionId: string, reason = 'Join request denied by the banker'): void {
    const record = this.connections.get(sessionId);
    if (!record) return;
    this.send(record, { t: 'join-rejected', reason });
    this.closeSoon(record);
  }

  kick(sessionId: string): void {
    const record = this.connections.get(sessionId);
    if (!record) return;
    if (record.playerId) {
      this.tokens.delete(record.playerId);
      this.persistTokens();
    }
    this.send(record, { t: 'host-bye', reason: 'Removed by the banker' });
    this.closeSoon(record);
  }

  stop(reason = 'Host ended the session'): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const record of this.connections.values()) {
      this.send(record, { t: 'host-bye', reason });
      record.conn.close();
    }
    this.connections.clear();
    try {
      this.transport?.destroy();
    } catch {
      // ignore
    }
    this.transport = null;
    this.emitPeers();
  }

  /** Called by the host commit listener; returns the delta revision sent. */
  broadcastJournal(j: Journal): void {
    if (this.stopped || !this.transport) return;
    const filtered = filterJournalForGame(journalToSerialized(j), this.gameId);
    if (isEmptySerializedJournal(filtered)) return;
    this.rev += 1;
    const delta: HostMessage = { t: 'delta', rev: this.rev, journal: filtered };
    for (const record of this.connections.values()) {
      if (!record.accepted || record.closed) continue;
      this.send(record, delta);
      if (this.suppressEventsFor !== record.sessionId) {
        for (const event of eventsForJournal(filtered)) {
          this.send(record, { t: 'event', event });
        }
      }
    }
  }

  private async snapshot(): Promise<Dump> {
    const bundle = await loadGame(this.gameId);
    return {
      games: bundle.game ? [bundle.game] : [],
      players: bundle.players,
      txns: bundle.txns,
      rounds: bundle.rounds,
      audit: bundle.audit,
    };
  }

  private async welcomeMessage(): Promise<HostMessage> {
    return {
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      room: this.room,
      gameId: this.gameId,
      rev: this.rev,
      snapshot: await this.snapshot(),
    };
  }

  private loadTokens(): void {
    try {
      const raw = localStorage.getItem(tokenStoreKey(this.gameId));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [pid, token] of Object.entries(parsed)) {
          if (typeof pid === 'string' && typeof token === 'string') this.tokens.set(pid, token);
        }
      }
    } catch {
      // Corrupt token map is not fatal; players can rejoin via approval.
    }
  }

  private persistTokens(): void {
    try {
      const data: Record<string, string> = {};
      for (const [pid, token] of this.tokens) data[pid] = token;
      localStorage.setItem(tokenStoreKey(this.gameId), JSON.stringify(data));
    } catch {
      // localStorage may be unavailable in private browsing.
    }
  }

  // ---------- connection lifecycle ----------

  private handleConnection(conn: TransportConnection): void {
    const sessionId = `peer-${++this.counter}-${Math.random().toString(36).slice(2, 6)}`;
    const record: PeerRecord = {
      sessionId,
      conn,
      name: '',
      playerId: null,
      accepted: false,
      accepting: false,
      helloDone: false,
      cmdTimes: [],
      assembler: new ChunkAssembler(),
      closed: false,
    };
    this.connections.set(sessionId, record);
    conn.onData((raw) => this.handleRaw(record, raw));
    conn.onClose(() => this.dropRecord(record));
  }

  private dropRecord(record: PeerRecord): void {
    record.closed = true;
    record.assembler.reset();
    this.connections.delete(record.sessionId);
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

  private closeSoon(record: PeerRecord): void {
    setTimeout(() => record.conn.close(), 150);
  }

  private handleRaw(record: PeerRecord, raw: unknown): void {
    if (typeof raw === 'string' && raw.length > 512 * 1024) {
      record.conn.close();
      return;
    }
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
        void this.handleHello(record, msg);
        break;
      case 'join-request':
        void this.handleJoinRequest(record, msg);
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
    record.helloDone = true;
    if (await this.verifyRejoin(msg.playerId, msg.playerToken)) {
      await this.accept(record, msg.playerId as string, msg.playerToken as string);
      return;
    }
    this.send(record, await this.welcomeMessage());
  }

  private async handleJoinRequest(
    record: PeerRecord,
    msg: Extract<ClientMessage, { t: 'join-request' }>
  ): Promise<void> {
    if (record.accepted) return;
    const name = String(msg.name || '').trim();
    if (!validName(name)) {
      this.reject(record, 'Please choose a name between 1 and 64 characters');
      return;
    }
    record.name = name;

    if (await this.verifyRejoin(msg.playerId, msg.playerToken)) {
      await this.accept(record, msg.playerId as string, msg.playerToken as string);
      return;
    }

    const bundle = await loadGame(this.gameId);
    if (!bundle.game) {
      this.reject(record, 'Game not found on the host');
      return;
    }
    if (bundle.game.status !== 'pending') {
      this.reject(record, 'This game has already started. Only existing seats can reconnect.');
      return;
    }
    if (bundle.players.length >= MAX_SEATS) {
      this.reject(record, 'This table is full');
      return;
    }

    record.helloDone = true;
    this.send(record, { t: 'join-pending' });
    this.emitPeers();
    const info = this.peers.find((p) => p.sessionId === record.sessionId);
    if (info) this.options.onJoinRequest?.(info);
  }

  private async verifyRejoin(playerId?: string, token?: string): Promise<boolean> {
    if (!playerId || !token) return false;
    if (this.tokens.get(playerId) !== token) return false;
    const bundle = await loadGame(this.gameId);
    return bundle.players.some((p) => p.id === playerId);
  }

  private async accept(record: PeerRecord, playerId: string, token: string): Promise<void> {
    for (const other of this.connections.values()) {
      if (other.sessionId === record.sessionId || !other.accepted) continue;
      if (other.playerId === playerId) {
        this.send(other, { t: 'host-bye', reason: 'This seat opened on another device' });
        other.conn.close();
      }
    }

    const bundle = await loadGame(this.gameId);
    const player = bundle.players.find((p) => p.id === playerId);
    if (!player) {
      this.reject(record, 'Seat not found on this game');
      return;
    }

    record.accepted = true;
    record.playerId = playerId;
    record.name = player.name;
    this.send(record, {
      t: 'join-accepted',
      playerId,
      playerToken: token,
      gameId: this.gameId,
      rev: this.rev,
      snapshot: await this.snapshot(),
    });
    this.emitPeers();
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

    const headers: Record<string, string> = { ...(msg.headers || {}) };
    if (!headers['Idempotency-Key'] && !headers['idempotency-key']) {
      headers['Idempotency-Key'] = msg.id;
    }

    // The sender already shows its own toast/sound on ack.
    this.suppressEventsFor = record.sessionId;
    try {
      const result = await localApi(path, { method, body: msg.body, headers });
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
      this.suppressEventsFor = null;
    }
  }
}
