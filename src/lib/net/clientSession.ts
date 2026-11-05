// Client session: connects to the host, joins a seat, applies snapshots/deltas,
// and relays player commands with ack/nack + retry. Never writes authoritatively.
import { Dump, SerializedJournal } from '../db';
import type { LocalApiOptions } from '../api';
import { ChunkAssembler, sendMessage } from './codec';
import { createTransport } from './peerFactory';
import { Transport, TransportConnection } from './transportTypes';
import {
  ClientMessage,
  CmdMessage,
  HostMessage,
  RemoteEvent,
  PROTOCOL_VERSION,
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
  onEvent: (event: RemoteEvent) => void;
  onError: (message: string) => void;
}

export interface JoinedInfo {
  playerId: string;
  gameId: string;
}

const COMMAND_TIMEOUT_MS = 7000;
const MAX_COMMAND_ATTEMPTS = 3;
const HEARTBEAT_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 45000;

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
  playerId: string;
  playerToken: string;
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
    if (parsed && typeof parsed.playerId === 'string' && typeof parsed.playerToken === 'string') {
      return parsed as StoredCredentials;
    }
  } catch {
    // ignore malformed credentials
  }
  return null;
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
  private transport: Transport | null = null;
  private connection: TransportConnection | null = null;
  private assembler = new ChunkAssembler();
  private pending = new Map<string, PendingCommand>();

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

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private latency = 0;
  private lastResyncAt = 0;
  private messageQueue: Promise<void> = Promise.resolve();

  private constructor(room: string, handlers: ClientSessionHandlers) {
    this.room = normalizeRoom(room);
    this.handlers = handlers;
    const stored = readCredentials(this.room);
    if (stored) {
      this.playerId = stored.playerId;
      this.playerToken = stored.playerToken;
      this.gameId = stored.gameId || null;
    }
  }

  static async create(room: string, handlers: ClientSessionHandlers): Promise<ClientSession> {
    const session = new ClientSession(room, handlers);
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
      if (this.welcomed) this.sendJoinRequest();
    });
  }

  private sendJoinRequest(): void {
    if (this.disposed) return;
    this.pendingApproval = true;
    this.send({
      t: 'join-request',
      name: this.joinName || 'Player',
      playerId: this.playerId || undefined,
      playerToken: this.playerToken || undefined,
    });
  }

  // ---------- inbound messages ----------

  private handleRaw(raw: unknown): void {
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
          this.welcomed = true;
          this.gameId = msg.gameId;
          this.rev = msg.rev;
          await this.handlers.onSnapshot(msg.snapshot, msg.gameId);
          if (this.joinName) this.sendJoinRequest();
          break;
        case 'join-pending':
          this.pendingApproval = true;
          this.handlers.onPending();
          break;
        case 'join-rejected':
          this.pendingApproval = false;
          this.handlers.onRejected(msg.reason);
          if (this.joinPromise) {
            const pending = this.joinPromise;
            this.joinPromise = null;
            pending.reject(new Error(msg.reason));
          }
          break;
        case 'join-accepted':
          await this.handleAccepted(msg);
          break;
        case 'snapshot':
          this.rev = msg.rev;
          await this.handlers.onSnapshot(msg.data, this.gameId || '');
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
        case 'pong':
          this.lastPongAt = Date.now();
          this.latency = Math.max(0, Date.now() - Number(msg.ts || 0));
          break;
        case 'host-bye':
          this.handleHostBye(msg.reason);
          break;
        default:
          break;
      }
    } catch (err: any) {
      console.error('Client message handling failed:', err);
    }
  }

  private async handleAccepted(
    msg: Extract<HostMessage, { t: 'join-accepted' }>
  ): Promise<void> {
    this.playerId = msg.playerId;
    this.playerToken = msg.playerToken;
    this.gameId = msg.gameId;
    writeCredentials(this.room, {
      playerId: msg.playerId,
      playerToken: msg.playerToken,
      gameId: msg.gameId,
    });
    this.rev = msg.rev;
    await this.handlers.onSnapshot(msg.snapshot, msg.gameId);

    this.accepted = true;
    this.pendingApproval = false;
    this.reconnectAttempt = 0;
    this.lastPongAt = Date.now();
    this.handlers.onJoined({ playerId: msg.playerId, gameId: msg.gameId });
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
    this.rev = msg.rev;
    await this.handlers.onDelta(msg.journal, msg.rev);
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

  private handleHostBye(reason: string): void {
    this.accepted = false;
    this.pendingApproval = false;
    this.stopHeartbeat();
    const terminal = /another device|removed by the banker/i.test(reason);
    if (terminal) {
      this.disposed = true;
      this.failPending(reason);
      this.handlers.onRejected(reason);
      this.handlers.onStatus('error');
      this.closeResources();
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
      this.disposed = true;
      this.failPending('This browser does not support the WebRTC features required to join');
      this.handlers.onError('This browser does not support WebRTC multiplayer');
      this.handlers.onStatus('error');
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

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.accepted || this.disposed) return;
      this.send({ t: 'ping', ts: Date.now() });
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
