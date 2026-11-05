import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkAssembler, splitMessage } from './codec';

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
