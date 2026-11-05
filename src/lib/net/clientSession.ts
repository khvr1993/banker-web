// Client session: connects to the host, joins a seat, applies snapshots/deltas,
// and relays player commands with ack/nack + retry. Never writes authoritatively.
import { Dump, SerializedJournal } from '../db';
import type { LocalApiOptions } from '../api';
import { ChunkAssembler, sendMessage } from './codec';
import { createTransport } from './peerFactory';
import { Transport, TransportConnection } from './transportTypes';
import { newJoinKey, sanitizeJoinKey } from './joinKey';
import { withTimeout } from './timeout';
import {
  ClientMessage,
  CmdMessage,
  HostByeCode,
  HostMessage,
  RemoteEvent,
  PROTOCOL_VERSION,
  MAX_MESSAGE_CHARS,
  hostPeerId,
  isHostMessage,
  newClientPeerId,
  newMessageId,
  normalizeRoom,
  parseIncoming,
} from './protocol';

export type ClientConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ClientSessionHandlers {
  onSnapshot: (snapshot: Dump, gameId: string) => Promise<void> | void;
  onDelta: (journal: SerializedJournal, rev: number) => Promise<void> | void;
  onStatus: (state: ClientConnectionState) => void;
  onJoined: (info: { playerId: string; gameId: string }) => void;
  onPending: () => void;
  onRejected: (reason: string) => void;
  /** The banker kicked this device. A fresh join request can be sent. */
  onKicked?: (reason: string) => void;
  onEvent: (event: RemoteEvent) => void;
  onError: (message: string) => void;
  onLatency?: (ms: number) => void;
}

export interface JoinedInfo {
  playerId: string;
  gameId: string;
}

export interface ClientSessionOptions {
  handshakeTimeoutMs?: number;
  pendingAckTimeoutMs?: number;
  snapshotTimeoutMs?: number;
}

const COMMAND_TIMEOUT_MS = 7000;
const MAX_COMMAND_ATTEMPTS = 3;
const HEARTBEAT_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 45000;
// IndexedDB writes are normally instant. A private window or a blocked
// database can leave the transaction pending forever, which used to strand the
// join screen on "Connecting…" because the handshake timers were already clear.
const SNAPSHOT_TIMEOUT_MS = 20_000;

const TERMINAL_BYE_CODES = new Set<HostByeCode>([
  'host-stopped',
  'game-switched',
  'removed',
  'seat-replaced',
]);

export class RemoteCommandError extends Error {
  status: number;
  type: string;

  constructor(status: number, type: string, message: string) {
    super(message);
    this.name = 'RemoteCommandError';
    this.status = status;
    this.type = type;
  }
}

interface PendingCommand {
  message: CmdMessage;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface StoredCredentials {
  joinKey: string;
  playerId?: string;
  playerToken?: string;
  gameId?: string;
}

function credentialsKey(room: string): string {
  return `banker_session_${room}`;
}

function readCredentials(room: string): StoredCredentials | null {
  try {
    const raw = localStorage.getItem(credentialsKey(room));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    // Legacy v1 records have no joinKey; adopt one so the seat stays reachable.
    const joinKey = sanitizeJoinKey(parsed.joinKey) || newJoinKey();
    return {
      joinKey,
      playerId: typeof parsed.playerId === 'string' ? parsed.playerId : undefined,
      playerToken: typeof parsed.playerToken === 'string' ? parsed.playerToken : undefined,
      gameId: typeof parsed.gameId === 'string' ? parsed.gameId : undefined,
    };
  } catch {
    return null;
  }
}

function writeCredentials(room: string, creds: StoredCredentials): void {
  try {
    localStorage.setItem(credentialsKey(room), JSON.stringify(creds));
  } catch {
    // localStorage can be unavailable; reconnect then needs banker approval.
  }
}

export class ClientSession {
  readonly room: string;

  private handlers: ClientSessionHandlers;
  private options: ClientSessionOptions;
  private transport: Transport | null = null;
  private connection: TransportConnection | null = null;
  private assembler = new ChunkAssembler();
  private pending = new Map<string, PendingCommand>();

  private joinKey: string;
  private playerId: string | null = null;
  private playerToken: string | null = null;
  private gameId: string | null = null;
  private rev = 0;
  private accepted = false;
  private welcomed = false;
  private disposed = false;

  private joinName = '';
  private joinPromise: { resolve: (value: JoinedInfo) => void; reject: (reason: Error) => void } | null = null;
  private pendingApproval = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAckTimer: ReturnType<typeof setTimeout> | null = null;
  private deltaFailures = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private latency = 0;
  private lastResyncAt = 0;
  private messageQueue: Promise<void> = Promise.resolve();

  private constructor(
    room: string,
    handlers: ClientSessionHandlers,
    options: ClientSessionOptions = {}
  ) {
    this.room = normalizeRoom(room);
    this.handlers = handlers;
    this.options = options;
    const stored = readCredentials(this.room);
    this.joinKey = stored?.joinKey || newJoinKey();
    this.playerId = stored?.playerId || null;
    this.playerToken = stored?.playerToken || null;
    this.gameId = stored?.gameId || null;
    this.persistCredentials();
  }

  static async create(
    room: string,
    handlers: ClientSessionHandlers,
    options: ClientSessionOptions = {}
  ): Promise<ClientSession> {
    const session = new ClientSession(room, handlers, options);
    await session.openTransport();
    return session;
  }

  get latencyMs(): number {
    return this.latency;
  }

  get isAccepted(): boolean {
    return this.accepted;
  }

  get currentGameId(): string | null {
    return this.gameId;
  }

  private persistCredentials(): void {
    writeCredentials(this.room, {
      joinKey: this.joinKey,
      playerId: this.playerId || undefined,
      playerToken: this.playerToken || undefined,
      gameId: this.gameId || undefined,
    });
  }

  private async openTransport(): Promise<void> {
    this.handlers.onStatus(this.accepted ? 'reconnecting' : 'connecting');
    this.transport = await createTransport(newClientPeerId(), {
      onError: (err) => this.handleTransportError(err),
      onDisconnected: () => this.handleDisconnect('Signaling disconnected'),
    });
    this.openConnection();
  }

  private openConnection(): void {
    if (!this.transport || this.disposed) return;
    this.assembler.reset();
    this.welcomed = false;
    const connection = this.transport.connect(hostPeerId(this.room));
    this.connection = connection;
    connection.onData((raw) => {
      if (this.connection !== connection) return;
      this.handleRaw(raw);
    });
    connection.onClose(() => {
      // Ignore events from a connection that was already replaced during reconnect.
      if (this.connection !== connection) return;
      this.handleDisconnect('Connection closed');
    });
    connection.onOpen(() => this.sendHello());
  }

  private send(message: ClientMessage): void {
    if (!this.connection || this.disposed) return;
    sendMessage(this.connection, message);
  }

  private sendHello(): void {
    if (this.disposed) return;
    this.welcomed = false;
    this.send({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      room: this.room,
      joinKey: this.joinKey,
      playerId: this.playerId || undefined,
      playerToken: this.playerToken || undefined,
    });
  }

  // ---------- join ----------

  join(name: string): Promise<JoinedInfo> {
    this.joinName = String(name || '').trim() || 'Player';
    if (this.accepted && this.playerId && this.gameId) {
      return Promise.resolve({ playerId: this.playerId, gameId: this.gameId });
    }
    return new Promise<JoinedInfo>((resolve, reject) => {
      this.joinPromise = { resolve, reject };
      this.armHandshakeTimer();
      if (this.welcomed) this.sendJoinRequest();
    });
  }

  private armHandshakeTimer(): void {
    this.clearHandshakeTimer();
    const timeoutMs = this.options.handshakeTimeoutMs ?? 15_000;
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      this.failJoin(
        new RemoteCommandError(
          504,
          'JOIN_TIMEOUT',
          'The banker did not answer. Check the room code and try again.'
        )
      );
    }, timeoutMs);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private armPendingAckTimer(): void {
    if (this.accepted) return;
    this.clearPendingAckTimer();
    const timeoutMs = this.options.pendingAckTimeoutMs ?? 10_000;
    this.pendingAckTimer = setTimeout(() => {
      this.pendingAckTimer = null;
      this.failJoin(
        new RemoteCommandError(
          504,
          'JOIN_TIMEOUT',
          'The banker did not answer. Check the room code and try again.'
        )
      );
    }, timeoutMs);
  }

  private clearPendingAckTimer(): void {
    if (this.pendingAckTimer) clearTimeout(this.pendingAckTimer);
    this.pendingAckTimer = null;
  }

  private failJoin(error: Error): void {
    const pending = this.joinPromise;
    this.joinPromise = null;
    this.clearHandshakeTimer();
    this.clearPendingAckTimer();
    if (pending) pending.reject(error);
    this.accepted = false;
    this.disposed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failPending(error.message);
    this.handlers.onError(error.message || 'Could not join the session');
    this.handlers.onStatus('error');
    this.closeResources();
  }

  private sendJoinRequest(): void {
    if (this.disposed) return;
    this.pendingApproval = true;
    this.clearHandshakeTimer();
    this.armPendingAckTimer();
    this.send({
      t: 'join-request',
      name: this.joinName || 'Player',
      joinKey: this.joinKey,
      playerId: this.playerId || undefined,
      playerToken: this.playerToken || undefined,
    });
  }

  // ---------- inbound messages ----------

  private handleRaw(raw: unknown): void {
    if (typeof raw === 'string' && raw.length > MAX_MESSAGE_CHARS) return;
    let msg = parseIncoming(raw);
    if (!msg || typeof msg !== 'object') return;
    if ((msg as any).t === 'chunk') {
      const assembled = this.assembler.push((msg as any));
      if (!assembled) return;
      msg = assembled;
    }
    if (!isHostMessage(msg)) return;
    // Serialize handling so a delta can never overtake an in-flight snapshot.
    this.messageQueue = this.messageQueue
      .then(() => this.dispatch(msg))
      .catch((err) => console.error('Client message handling failed:', err));
  }

  private async dispatch(msg: HostMessage): Promise<void> {
    try {
      switch (msg.t) {
        case 'welcome':
          // Capability probe only: no ledger data before banker approval.
          this.welcomed = true;
          if (this.joinName) this.sendJoinRequest();
          break;
        case 'join-pending':
          this.pendingApproval = true;
          this.clearPendingAckTimer();
          this.handlers.onPending();
          break;
        case 'join-rejected':
          this.pendingApproval = false;
          this.clearPendingAckTimer();
          this.handlers.onRejected(msg.reason);
          this.failJoin(new Error(msg.reason));
          break;
        case 'join-accepted':
          await this.handleAccepted(msg);
          break;
        case 'snapshot':
          this.rev = msg.rev;
          await this.applySnapshot(msg.data, this.gameId || '');
          break;
        case 'delta':
          await this.handleDelta(msg);
          break;
        case 'ack':
          this.settleCommand(msg.id, null, msg.result);
          break;
        case 'nack':
          this.settleCommand(
            msg.id,
            new RemoteCommandError(msg.error.status, msg.error.type, msg.error.message)
          );
          break;
        case 'event':
          this.handlers.onEvent(msg.event);
          break;
        case 'pong': {
          this.lastPongAt = Date.now();
          const ms = Math.max(0, Date.now() - Number(msg.ts || 0));
          this.latency = ms;
          this.handlers.onLatency?.(ms);
          break;
        }
        case 'host-bye':
          this.handleHostBye(msg);
          break;
        default:
          break;
      }
    } catch (err: any) {
      console.error('Client message handling failed:', err);
      this.failJoin(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Runs the local mirror write behind a deadline. Without this a blocked
   * IndexedDB transaction in a private window leaves `join()` pending forever.
   */
  private async applySnapshot(snapshot: Dump, gameId: string): Promise<void> {
    const timeoutMs = this.options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS;
    await withTimeout(
      Promise.resolve(this.handlers.onSnapshot(snapshot, gameId)),
      timeoutMs,
      () =>
        new RemoteCommandError(
          504,
          'STORAGE_TIMEOUT',
          'Could not save the game on this device. Private browsing or full storage can block it. Try a normal window or free up space.'
        )
    );
  }

  private async handleAccepted(
    msg: Extract<HostMessage, { t: 'join-accepted' }>
  ): Promise<void> {
    const wasAccepted = this.accepted;
    this.playerId = msg.playerId;
    this.playerToken = msg.playerToken;
    this.gameId = msg.gameId;
    this.persistCredentials();
    this.rev = msg.rev;

    try {
      await this.applySnapshot(msg.snapshot, msg.gameId);
    } catch (err) {
      // Keep the specific storage-timeout guidance, but fall back to the
      // generic message for ordinary write failures such as quota errors.
      const message =
        err instanceof RemoteCommandError && err.type === 'STORAGE_TIMEOUT'
          ? err.message
          : 'Could not load the game into local storage. Free up space and retry.';
      this.handlers.onError(message);
      throw err;
    }

    this.accepted = true;
    this.pendingApproval = false;
    this.clearHandshakeTimer();
    this.clearPendingAckTimer();
    this.reconnectAttempt = 0;
    this.lastPongAt = Date.now();
    this.deltaFailures = 0;
    if (!wasAccepted) {
      this.handlers.onJoined({ playerId: msg.playerId, gameId: msg.gameId });
    }
    this.handlers.onStatus('connected');
    this.startHeartbeat();
    this.flushPending();

    if (this.joinPromise) {
      const pending = this.joinPromise;
      this.joinPromise = null;
      pending.resolve({ playerId: msg.playerId, gameId: msg.gameId });
    }
  }

  private async handleDelta(msg: Extract<HostMessage, { t: 'delta' }>): Promise<void> {
    if (msg.rev <= this.rev) return;
    if (this.rev > 0 && msg.rev > this.rev + 1) {
      this.requestResync();
      return;
    }
    try {
      // Apply before advancing rev so a failed write cannot silently skip data.
      await this.handlers.onDelta(msg.journal, msg.rev);
      this.rev = msg.rev;
      this.deltaFailures = 0;
    } catch (err) {
      this.deltaFailures += 1;
      console.error('Delta apply failed:', err);
      if (this.deltaFailures >= 3) {
        this.handlers.onError(
          'Could not update the local game mirror. Free up space and reopen the session.'
        );
        this.handlers.onStatus('error');
      }
      this.requestResync();
    }
  }

  // ---------- commands ----------

  command(path: string, options: LocalApiOptions = {}): Promise<any> {
    if (!this.accepted) {
      return Promise.reject(
        new RemoteCommandError(503, 'OFFLINE', 'Not connected to the banker yet. Reconnecting…')
      );
    }
    const id = newMessageId();
    const message: CmdMessage = {
      t: 'cmd',
      id,
      path,
      method: (options.method || 'GET').toUpperCase(),
      body: options.body,
      headers: options.headers,
    };
    return new Promise((resolve, reject) => {
      const entry: PendingCommand = { message, resolve, reject, attempts: 0, timer: null };
      this.pending.set(id, entry);
      this.sendCommand(entry);
    });
  }

  private sendCommand(entry: PendingCommand): void {
    if (this.disposed) return;
    entry.attempts += 1;
    this.send(entry.message);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!this.pending.has(entry.message.id)) return;
      if (entry.attempts < MAX_COMMAND_ATTEMPTS && this.accepted) {
        this.sendCommand(entry);
        return;
      }
      this.settleCommand(
        entry.message.id,
        new RemoteCommandError(
          504,
          'TIMEOUT',
          'The banker did not acknowledge this action. Check the connection and try again.'
        )
      );
    }, COMMAND_TIMEOUT_MS);
  }

  private settleCommand(id: string, error: Error | null, result?: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(id);
    if (error) entry.reject(error);
    else entry.resolve(result);
  }

  private flushPending(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      this.sendCommand(entry);
    }
  }

  // ---------- connection recovery ----------

  private handleHostBye(msg: Extract<HostMessage, { t: 'host-bye' }>): void {
    this.accepted = false;
    this.pendingApproval = false;
    this.clearPendingAckTimer();
    this.stopHeartbeat();

    if (TERMINAL_BYE_CODES.has(msg.code)) {
      // failJoin clears the handshake/pending-ack timers, stops reconnects, and
      // rejects any in-flight join so a terminal bye cannot be followed by a
      // spurious JOIN_TIMEOUT later.
      if (msg.code === 'removed') this.handlers.onKicked?.(msg.reason);
      this.handlers.onRejected(msg.reason);
      this.failJoin(new Error(msg.reason));
      return;
    }

    this.handlers.onStatus('reconnecting');
    this.scheduleReconnect();
  }

  private handleDisconnect(_reason: string): void {
    if (this.disposed) return;
    this.accepted = false;
    this.stopHeartbeat();
    this.connection = null;
    if (!this.pendingApproval) this.handlers.onStatus('reconnecting');
    this.scheduleReconnect();
  }

  private handleTransportError(err: { type: string; message: string }): void {
    if (this.disposed) return;
    if (err.type === 'browser-incompatible') {
      // Reject a pending join and clear timers instead of leaving the caller
      // waiting for a handshake that can never complete.
      this.failJoin(new Error('This browser does not support WebRTC multiplayer'));
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    if (!this.pendingApproval) this.handlers.onStatus('reconnecting');
    const delay = Math.min(15000, 800 * 2 ** this.reconnectAttempt) + Math.floor(Math.random() * 300);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 6);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectNow();
    }, delay);
  }

  private async reconnectNow(): Promise<void> {
    if (this.disposed) return;
    this.closeResources();
    try {
      await this.openTransport();
    } catch {
      this.scheduleReconnect();
    }
  }

  private requestResync(): void {
    const now = Date.now();
    if (now - this.lastResyncAt < 4000) return;
    this.lastResyncAt = now;
    this.sendHello();
  }

  ping(): void {
    if (this.disposed) return;
    this.send({ t: 'ping', ts: Date.now() });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.accepted || this.disposed) return;
      this.ping();
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        this.handleDisconnect('Host stopped responding');
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private failPending(message: string): void {
    for (const id of [...this.pending.keys()]) {
      this.settleCommand(id, new RemoteCommandError(503, 'OFFLINE', message));
    }
  }

  private closeResources(): void {
    this.assembler.reset();
    const connection = this.connection;
    this.connection = null;
    try {
      connection?.close();
    } catch {
      // ignore
    }
    try {
      this.transport?.destroy();
    } catch {
      // ignore
    }
    this.transport = null;
  }

  leave(): void {
    if (this.disposed) return;
    this.accepted = false;
    this.clearHandshakeTimer();
    this.clearPendingAckTimer();
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.send({ t: 'bye' });
    } catch {
      // ignore
    }
    this.disposed = true;
    this.failPending('Left the session');
    this.closeResources();
    if (this.joinPromise) {
      this.joinPromise.reject(new Error('Left the session'));
      this.joinPromise = null;
    }
    this.handlers.onStatus('idle');
  }
}

export function hasStoredSession(room: string): boolean {
  return readCredentials(normalizeRoom(room)) !== null;
}
