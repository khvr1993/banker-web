// Wire protocol for the host-authoritative multiplayer session (protocol v1).
import type { Dump, SerializedJournal } from '../db';

export const PROTOCOL_VERSION = 1;
export const PEER_ID_PREFIX = 'bgb-v1-';
export const MAX_MESSAGE_BYTES = 12 * 1024;
export const MAX_MESSAGE_CHARS = 512 * 1024;

export type RemoteEventKind = 'transfer' | 'round' | 'void';

export interface RemoteEvent {
  kind: RemoteEventKind;
  amount?: number;
  category?: string;
  description?: string;
  playerId?: string;
  round?: number;
}

export interface ChunkMessage {
  t: 'chunk';
  id: string;
  seq: number;
  total: number;
  data: string;
}

// ---------- client -> host ----------

export interface HelloMessage {
  t: 'hello';
  protocol: number;
  room: string;
  playerToken?: string;
  playerId?: string;
}

export interface JoinRequestMessage {
  t: 'join-request';
  name: string;
  playerToken?: string;
  playerId?: string;
}

export interface CmdMessage {
  t: 'cmd';
  id: string;
  path: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface PingMessage {
  t: 'ping';
  ts: number;
}

export interface ByeMessage {
  t: 'bye';
}

export type ClientMessage =
  | HelloMessage
  | JoinRequestMessage
  | CmdMessage
  | PingMessage
  | ByeMessage
  | ChunkMessage;

// ---------- host -> client ----------

export interface WelcomeMessage {
  t: 'welcome';
  protocol: number;
  room: string;
  gameId: string;
  rev: number;
  snapshot: Dump;
}

export interface JoinPendingMessage {
  t: 'join-pending';
}

export interface JoinRejectedMessage {
  t: 'join-rejected';
  reason: string;
}

export interface JoinAcceptedMessage {
  t: 'join-accepted';
  playerId: string;
  playerToken: string;
  gameId: string;
  rev: number;
  snapshot: Dump;
}

export interface SnapshotMessage {
  t: 'snapshot';
  rev: number;
  data: Dump;
}

export interface DeltaMessage {
  t: 'delta';
  rev: number;
  journal: SerializedJournal;
}

export interface AckMessage {
  t: 'ack';
  id: string;
  result: unknown;
}

export interface NackMessage {
  t: 'nack';
  id: string;
  error: { status: number; type: string; message: string };
}

export interface EventMessage {
  t: 'event';
  event: RemoteEvent;
}

export interface PongMessage {
  t: 'pong';
  ts: number;
}

export interface HostByeMessage {
  t: 'host-bye';
  reason: string;
}

export type HostMessage =
  | WelcomeMessage
  | JoinPendingMessage
  | JoinRejectedMessage
  | JoinAcceptedMessage
  | SnapshotMessage
  | DeltaMessage
  | AckMessage
  | NackMessage
  | EventMessage
  | PongMessage
  | HostByeMessage
  | ChunkMessage;

const CLIENT_TYPES = new Set(['hello', 'join-request', 'cmd', 'ping', 'bye', 'chunk']);
const HOST_TYPES = new Set([
  'welcome',
  'join-pending',
  'join-rejected',
  'join-accepted',
  'snapshot',
  'delta',
  'ack',
  'nack',
  'event',
  'pong',
  'host-bye',
  'chunk',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasType(value: unknown, types: Set<string>): boolean {
  return isObject(value) && typeof value.t === 'string' && types.has(value.t);
}

export function isClientMessage(value: unknown): value is ClientMessage {
  return hasType(value, CLIENT_TYPES);
}

export function isHostMessage(value: unknown): value is HostMessage {
  return hasType(value, HOST_TYPES);
}

/** Parses a raw data-channel payload (object or JSON string) into an object. */
export function parseIncoming(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------- room / peer IDs ----------

/** Keeps only characters PeerJS accepts in a peer id. */
export function sanitizeRoom(room: string): string {
  return String(room || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64);
}

export function hostPeerId(room: string): string {
  const clean = sanitizeRoom(room);
  return clean ? PEER_ID_PREFIX + clean : '';
}

/**
 * Accepts a raw token, `bgb-v1-<token>`, a `?join=<token>` URL, or a full URL
 * and returns the sanitized join token.
 */
export function normalizeRoom(input: string): string {
  let value = String(input || '').trim();
  if (!value) return '';
  if (value.includes('?') || value.includes('#')) {
    try {
      const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
      const url = new URL(value, base);
      const fromQuery = url.searchParams.get('join');
      if (fromQuery) value = fromQuery;
    } catch {
      const match = value.match(/[?&]join=([^&#]+)/);
      if (match) value = decodeURIComponent(match[1]);
    }
  }
  if (value.startsWith(PEER_ID_PREFIX)) value = value.slice(PEER_ID_PREFIX.length);
  const parts = value.split('/').filter(Boolean);
  if (parts.length > 0) value = parts[parts.length - 1];
  return sanitizeRoom(value);
}

export function roomPeerIdFor(room: string): string {
  return hostPeerId(room);
}

export function newClientPeerId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const stamp = Date.now().toString(36);
  return `pl-${stamp}${rand}`;
}

export function newMessageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
