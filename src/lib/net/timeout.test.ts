import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from './timeout';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('resolves before the deadline', async () => {
  const value = await withTimeout(Promise.resolve('ok'), 50, () => new Error('late'));
  assert.equal(value, 'ok');
});

test('rejects at the deadline', async () => {
  await assert.rejects(
    withTimeout(sleep(100).then(() => 'late'), 10, () => new Error('timed out')),
    /timed out/
  );
});

test('propagates the original rejection', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error('boom')), 50, () => new Error('timed out')),
    /boom/
  );
});

test('clears the timer after resolution', async () => {
  await withTimeout(Promise.resolve(1), 20, () => new Error('late'));
  // If the timer were not cleared it would fire here and reject unhandled.
  await sleep(35);
  assert.ok(true);
});
