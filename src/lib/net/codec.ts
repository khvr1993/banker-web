// JSON serialization plus app-level chunking for large data-channel payloads.
import { ChunkMessage, MAX_MESSAGE_BYTES } from './protocol';

export const CHUNK_PAYLOAD_BYTES = 8 * 1024;
export const REASSEMBLY_TIMEOUT_MS = 15_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeMessage(msg: unknown): string {
  return JSON.stringify(msg);
}

export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Returns the chunk envelopes for a message that is too large for one data
 * channel frame, or `[]` when the message fits.
 */
export function splitMessage(msg: unknown, maxBytes: number = MAX_MESSAGE_BYTES): ChunkMessage[] {
  const json = encodeMessage(msg);
  const bytes = encoder.encode(json);
  if (bytes.length <= maxBytes) return [];

  const chunkSize = Math.max(256, Math.min(CHUNK_PAYLOAD_BYTES, maxBytes - 256));
  const total = Math.ceil(bytes.length / chunkSize);
  const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const chunks: ChunkMessage[] = [];
  for (let seq = 0; seq < total; seq++) {
    const slice = bytes.subarray(seq * chunkSize, (seq + 1) * chunkSize);
    chunks.push({ t: 'chunk', id, seq, total, data: toBase64(slice) });
  }
  return chunks;
}

/**
 * Sends a message over a connection, splitting it into chunk envelopes when
 * it exceeds the safe data-channel frame size.
 */
export function sendMessage(conn: { send: (data: unknown) => void }, msg: unknown): void {
  const chunks = splitMessage(msg);
  if (chunks.length === 0) {
    conn.send(msg);
    return;
  }
  for (const chunk of chunks) conn.send(chunk);
}

interface PendingChunks {
  total: number;
  parts: Uint8Array[];
  expiresAt: number;
}

/** Reassembles chunked messages per connection. Not safe to share across peers. */
export class ChunkAssembler {
  private pending = new Map<string, PendingChunks>();
  private timeoutMs: number;

  constructor(timeoutMs: number = REASSEMBLY_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /** Returns the decoded message when the last chunk arrives, otherwise null. */
  push(chunk: ChunkMessage, now: number = Date.now()): unknown | null {
    this.prune(now);
    if (
      !chunk ||
      typeof chunk.id !== 'string' ||
      !Number.isInteger(chunk.seq) ||
      !Number.isInteger(chunk.total) ||
      chunk.total <= 0 ||
      chunk.seq < 0 ||
      chunk.seq >= chunk.total
    ) {
      return null;
    }

    let entry = this.pending.get(chunk.id);
    if (!entry) {
      entry = { total: chunk.total, parts: new Array(chunk.total), expiresAt: now + this.timeoutMs };
      this.pending.set(chunk.id, entry);
    }
    if (entry.total !== chunk.total) {
      this.pending.delete(chunk.id);
      return null;
    }
    const part = fromBase64(String(chunk.data || ''));
    entry.parts[chunk.seq] = part;

    for (let i = 0; i < entry.total; i++) {
      if (!entry.parts[i]) return null;
    }
    this.pending.delete(chunk.id);

    const size = entry.parts.reduce((sum, p) => sum + p.length, 0);
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const p of entry.parts) {
      joined.set(p, offset);
      offset += p.length;
    }
    try {
      return JSON.parse(decoder.decode(joined));
    } catch {
      return null;
    }
  }

  prune(now: number = Date.now()): void {
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(id);
    }
  }

  reset(): void {
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
