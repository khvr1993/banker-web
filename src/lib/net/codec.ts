// JSON serialization plus app-level chunking for large data-channel payloads.
import { ChunkMessage, MAX_MESSAGE_BYTES } from './protocol';
import { randomId } from '../random';

export const CHUNK_PAYLOAD_BYTES = 8 * 1024;
export const REASSEMBLY_TIMEOUT_MS = 15_000;

// Every reassembly dimension is bounded so a hostile peer cannot allocate an
// unbounded array or hold an unbounded amount of memory before the handshake.
export const MAX_CHUNKS_PER_MESSAGE = 512;
export const MAX_CHUNK_BYTES = 8 * 1024;
export const MAX_CHUNK_BASE64_CHARS = 11 * 1024;
export const MAX_ASSEMBLER_BYTES = 4 * 1024 * 1024;
export const MAX_ASSEMBLIES = 8;
export const MAX_CHUNK_ID_CHARS = 64;

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
  if (total > MAX_CHUNKS_PER_MESSAGE) {
    throw new RangeError('message exceeds MAX_CHUNKS_PER_MESSAGE');
  }
  const id = randomId('m', 6);
  const chunks: ChunkMessage[] = [];
  for (let seq = 0; seq < total; seq++) {
    const slice = bytes.subarray(seq * chunkSize, (seq + 1) * chunkSize);
    chunks.push({ t: 'chunk', id, seq, total, data: toBase64(slice) });
  }
  return chunks;
}

/**
 * Sends a message over a connection, splitting it into chunk envelopes when
 * it exceeds the safe data-channel frame size. Oversized messages are dropped
 * at this layer; callers that care (snapshot sends) pre-check first.
 */
export function sendMessage(conn: { send: (data: unknown) => void }, msg: unknown): void {
  let chunks: ChunkMessage[];
  try {
    chunks = splitMessage(msg);
  } catch (err) {
    console.warn('Dropping an oversized message:', err);
    return;
  }
  if (chunks.length === 0) {
    conn.send(msg);
    return;
  }
  for (const chunk of chunks) conn.send(chunk);
}

interface PendingChunks {
  total: number;
  parts: (Uint8Array | undefined)[];
  bytes: number;
  expiresAt: number;
}

/** Reassembles chunked messages per connection. Not safe to share across peers. */
export class ChunkAssembler {
  private pending = new Map<string, PendingChunks>();
  private timeoutMs: number;
  private storedBytes = 0;

  constructor(timeoutMs: number = REASSEMBLY_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /** Returns the decoded message when the last chunk arrives, otherwise null. */
  push(chunk: ChunkMessage, now: number = Date.now()): unknown | null {
    this.prune(now);
    if (
      !chunk ||
      typeof chunk.id !== 'string' ||
      chunk.id.length === 0 ||
      chunk.id.length > MAX_CHUNK_ID_CHARS ||
      typeof chunk.data !== 'string' ||
      !Number.isInteger(chunk.seq) ||
      !Number.isInteger(chunk.total) ||
      chunk.total <= 0 ||
      chunk.total > MAX_CHUNKS_PER_MESSAGE ||
      chunk.seq < 0 ||
      chunk.seq >= chunk.total ||
      chunk.data.length > MAX_CHUNK_BASE64_CHARS
    ) {
      return null;
    }

    let part: Uint8Array;
    try {
      part = fromBase64(chunk.data);
    } catch {
      this.deleteEntry(chunk.id);
      return null;
    }
    if (part.length > MAX_CHUNK_BYTES) {
      this.deleteEntry(chunk.id);
      return null;
    }

    let entry = this.pending.get(chunk.id);
    if (!entry) {
      if (this.pending.size >= MAX_ASSEMBLIES) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.deleteEntry(oldest);
      }
      entry = {
        total: chunk.total,
        parts: new Array(chunk.total),
        bytes: 0,
        expiresAt: now + this.timeoutMs,
      };
      this.pending.set(chunk.id, entry);
    }
    if (entry.total !== chunk.total) {
      this.deleteEntry(chunk.id);
      return null;
    }
    if (entry.parts[chunk.seq]) {
      // Duplicates are rejected so byte accounting stays exact.
      return null;
    }
    if (this.storedBytes + part.length > MAX_ASSEMBLER_BYTES) {
      this.deleteEntry(chunk.id);
      return null;
    }

    entry.parts[chunk.seq] = part;
    entry.bytes += part.length;
    this.storedBytes += part.length;

    for (let i = 0; i < entry.total; i++) {
      if (!entry.parts[i]) return null;
    }
    this.deleteEntry(chunk.id);

    const size = entry.parts.reduce((sum, p) => sum + (p ? p.length : 0), 0);
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const p of entry.parts) {
      if (!p) continue;
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
      if (entry.expiresAt <= now) this.deleteEntry(id);
    }
  }

  reset(): void {
    this.pending.clear();
    this.storedBytes = 0;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Total bytes currently held across pending assemblies. */
  get totalBytes(): number {
    return this.storedBytes;
  }

  private deleteEntry(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.storedBytes -= entry.bytes;
    if (this.storedBytes < 0) this.storedBytes = 0;
    this.pending.delete(id);
  }
}
