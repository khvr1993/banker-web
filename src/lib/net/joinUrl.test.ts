import test from 'node:test';
import assert from 'node:assert/strict';

import { buildJoinUrl, isLoopbackOrigin } from './joinUrl';

Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost:3000', pathname: '/app/' } },
  configurable: true,
});

test('loopback origins are detected', () => {
  assert.equal(isLoopbackOrigin('http://localhost:3000'), true);
  assert.equal(isLoopbackOrigin('https://localhost'), true);
  assert.equal(isLoopbackOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isLoopbackOrigin('http://[::1]:8080'), true);
  assert.equal(isLoopbackOrigin('file:///Users/me/index.html'), true);
  assert.equal(isLoopbackOrigin('https://banker.example.com'), false);
  assert.equal(isLoopbackOrigin('http://192.168.1.20:3000'), false);
  assert.equal(isLoopbackOrigin('not a url'), false);
});

test('join URLs use the current origin or a configured public base', () => {
  assert.equal(buildJoinUrl('room-1'), 'http://localhost:3000/app/?join=room-1');
  assert.equal(
    buildJoinUrl('room-1', 'https://example.com/banker/'),
    'https://example.com/banker/?join=room-1'
  );
  assert.equal(
    buildJoinUrl('bad room!', 'https://example.com'),
    'https://example.com/?join=badroom'
  );
});
