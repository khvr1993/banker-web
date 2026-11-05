import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChunkAssembler,
  MAX_ASSEMBLER_BYTES,
  MAX_ASSEMBLIES,
  MAX_CHUNKS_PER_MESSAGE,
  MAX_CHUNK_BASE64_CHARS,
  splitMessage,
} from './codec';
import type { ChunkMessage } from './protocol';

function b64(bytes: number): string {
  return Buffer.alloc(bytes, 1).toString('base64');
}

const payload = {
  t: 'delta',
  rev: 7,
  journal: {
    note: '₹ — rent 🎲 '.repeat(400),
    rows: Array.from({ length: 60 }, (_, i) => ({ i, label: `row-${i}` })),
  },
};

test('messages that fit are not chunked', () => {
  assert.deepEqual(splitMessage({ t: 'ping', ts: 1 }), []);
});

test('chunked payload round-trips with unicode and out-of-order arrival', () => {
  const chunks = splitMessage(payload, 1024);
  assert.ok(chunks.length > 1, 'expected several chunks');

  const assembler = new ChunkAssembler(10_000);
  let rebuilt: unknown = null;
  for (const chunk of [...chunks].reverse()) {
    const result = assembler.push(chunk, 1000);
    if (result) rebuilt = result;
  }
  assert.deepEqual(rebuilt, payload);
  assert.equal(assembler.size, 0);
});

test('missing chunks never complete', () => {
  const chunks = splitMessage(payload, 1024);
  const assembler = new ChunkAssembler(10_000);
  for (const chunk of chunks.slice(1)) {
    assert.equal(assembler.push(chunk, 1000), null);
  }
  assert.equal(assembler.size, 1);
});

test('incomplete assemblies expire', () => {
  const chunks = splitMessage(payload, 1024);
  const assembler = new ChunkAssembler(500);
  assembler.push(chunks[0], 1000);
  assembler.prune(2000);
  assert.equal(assembler.size, 0);
});

test('mismatched total is rejected', () => {
  const chunks = splitMessage(payload, 1024);
  const assembler = new ChunkAssembler(10_000);
  assembler.push(chunks[0], 1000);
  const bad = { ...chunks[1], total: chunks[1].total + 1 };
  assert.equal(assembler.push(bad, 1000), null);
  assert.equal(assembler.size, 0);
});

test('oversized chunk total is rejected without allocating', () => {
  const assembler = new ChunkAssembler(10_000);
  const bad = {
    t: 'chunk',
    id: 'huge',
    seq: 0,
    total: MAX_CHUNKS_PER_MESSAGE + 1,
    data: b64(16),
  } as ChunkMessage;
  assert.equal(assembler.push(bad, 1000), null);
  assert.equal(assembler.size, 0);
  assert.equal(assembler.totalBytes, 0);
});

test('invalid base64 is rejected and pruned', () => {
  const assembler = new ChunkAssembler(10_000);
  const bad = { t: 'chunk', id: 'bad-b64', seq: 0, total: 2, data: '!!!!' } as ChunkMessage;
  assert.equal(assembler.push(bad, 1000), null);
  assert.equal(assembler.size, 0);
});

test('oversized chunk data is rejected', () => {
  const assembler = new ChunkAssembler(10_000);
  const bad = {
    t: 'chunk',
    id: 'big',
    seq: 0,
    total: 2,
    data: 'A'.repeat(MAX_CHUNK_BASE64_CHARS + 1),
  } as ChunkMessage;
  assert.equal(assembler.push(bad, 1000), null);
  assert.equal(assembler.size, 0);
});

test('duplicate sequence numbers are rejected', () => {
  const assembler = new ChunkAssembler(10_000);
  const chunk = { t: 'chunk', id: 'dup', seq: 0, total: 2, data: b64(16) } as ChunkMessage;
  assert.equal(assembler.push(chunk, 1000), null);
  assert.equal(assembler.push(chunk, 1000), null);
  assert.equal(assembler.totalBytes, 16);
});

test('concurrent assemblies are capped', () => {
  const assembler = new ChunkAssembler(10_000);
  for (let i = 0; i < MAX_ASSEMBLIES + 3; i++) {
    assembler.push({ t: 'chunk', id: `a-${i}`, seq: 0, total: 4, data: b64(8) } as ChunkMessage, 1000);
  }
  assert.ok(assembler.size <= MAX_ASSEMBLIES);
});

test('total reassembly memory is bounded and resets', () => {
  const assembler = new ChunkAssembler(10_000);
  const big = b64(8 * 1024);
  let pushed = 0;
  outer: for (let id = 0; id < MAX_ASSEMBLIES; id++) {
    for (let seq = 0; seq < MAX_CHUNKS_PER_MESSAGE; seq++) {
      assembler.push({ t: 'chunk', id: `mem-${id}`, seq, total: MAX_CHUNKS_PER_MESSAGE, data: big } as ChunkMessage, 1000);
      pushed += 1;
      if (assembler.totalBytes >= MAX_ASSEMBLER_BYTES) break outer;
    }
  }
  assert.ok(pushed > 0);
  assert.ok(assembler.totalBytes <= MAX_ASSEMBLER_BYTES);
  assert.ok(assembler.size <= MAX_ASSEMBLIES);
  assembler.reset();
  assert.equal(assembler.totalBytes, 0);
  assert.equal(assembler.size, 0);
});

test('a near-4 MB snapshot reassembles but a larger one is rejected', () => {
  const nearLimit = {
    t: 'snapshot',
    rev: 1,
    data: 'x'.repeat(MAX_ASSEMBLER_BYTES - 4096),
  };
  const chunks = splitMessage(nearLimit);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.length <= MAX_CHUNKS_PER_MESSAGE);

  const assembler = new ChunkAssembler(60_000);
  let rebuilt: any = null;
  for (const chunk of chunks) {
    const result = assembler.push(chunk, 1000);
    if (result) rebuilt = result;
  }
  assert.equal(rebuilt?.data.length, nearLimit.data.length);
  assert.equal(assembler.size, 0);
  assert.equal(assembler.totalBytes, 0);

  const tooLarge = {
    t: 'snapshot',
    rev: 1,
    data: 'x'.repeat(MAX_ASSEMBLER_BYTES + 4096),
  };
  assert.throws(() => splitMessage(tooLarge), /MAX_CHUNKS_PER_MESSAGE/);
});

test('malformed chunk fuzz never throws or exceeds caps', () => {
  const assembler = new ChunkAssembler(10_000);
  const weird: unknown[] = [
    null,
    undefined,
    0,
    'chunk',
    [],
    { t: 'chunk' },
    { t: 'chunk', id: '', seq: 0, total: 1, data: '' },
    { t: 'chunk', id: 'x'.repeat(1000), seq: 0, total: 1, data: '' },
    { t: 'chunk', id: 'a', seq: -1, total: 2, data: b64(4) },
    { t: 'chunk', id: 'a', seq: 5, total: 2, data: b64(4) },
    { t: 'chunk', id: 'a', seq: 1.5, total: 2, data: b64(4) },
    { t: 'chunk', id: 'a', seq: 0, total: -2, data: b64(4) },
    { t: 'chunk', id: 'a', seq: 0, total: 2, data: 42 },
  ];
  for (let i = 0; i < 500; i++) {
    const item = weird[i % weird.length];
    assert.doesNotThrow(() => assembler.push(item as ChunkMessage, 1000));
    assert.ok(assembler.size <= MAX_ASSEMBLIES);
    assert.ok(assembler.totalBytes <= MAX_ASSEMBLER_BYTES);
  }
});
