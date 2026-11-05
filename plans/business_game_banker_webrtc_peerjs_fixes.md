# Fix Plan — WebRTC Multiplayer (banker-web)

Status: proposed  
Companion to: [`business_game_banker_webrtc_peerjs_plan.md`](./business_game_banker_webrtc_peerjs_plan.md)  
Scope: the uncommitted host-authoritative multiplayer implementation in `src/lib/net/*`, `src/lib/gameApi.ts`, `src/lib/remoteDb.ts`, and the multiplayer UI/context changes.

Baseline at time of writing:

- `npm test` → 14/14 pass
- `npx tsc --noEmit` → clean
- `npm run build` → clean
- `git diff --check` → clean

This plan does **not** change the local/offline mode. It hardens the multiplayer path and keeps the host as the single authoritative writer.

---

## 1. Guiding constraints

1. **Money safety before availability.** Any fix that can duplicate, skip, or misattribute a ledger posting lands in P0.
2. **One wire version.** All protocol-shape changes ship together as protocol v2. Do not ship a partially-updated wire format.
3. **No new infrastructure.** PeerJS Cloud remains the only signaling dependency.
4. **Host is the only writer.** Players continue to relay commands; they never write authoritatively.
5. **Reuse the `Journal` delta.** Do not introduce an operation log, CRDT, or mesh topology.
6. **Every fix has a regression test.** If a behavior cannot be tested in Node, it gets an explicit manual verification step.
7. **No silent failure.** A rejected join, oversized snapshot, or terminal host event must surface a UI state with a next action.

---

## 2. Release strategy and protocol v2

Several P0/P1 fixes change message shapes:

- `welcome` must stop carrying a snapshot (P0-2).
- `hello` / `join-request` need a stable `joinKey` (P0-6).
- `host-bye` needs a machine-readable terminal/non-terminal code (P1-1).

Ship them as **protocol v2** in one change set:

```ts
// src/lib/net/protocol.ts
export const PROTOCOL_VERSION = 2;
export const PEER_ID_PREFIX = `bgb-v${PROTOCOL_VERSION}-`;
```

Why bump the peer-ID prefix too: a v1 host and a v2 client should not connect at all. Bumping the prefix makes that fail fast at signaling instead of leaking into a half-handshake. `normalizeRoom` still accepts a raw room code, so existing join links remain valid.

Rules:

- All wire-affecting changes (`P0-2`, `P0-6`, `P1-1`, `P1-7`) merge together. Do not deploy a branch that only contains some of them.
- README must say: after an update, reload both host and player tabs. A stale tab shows the existing “different app versions” rejection, not corrupt data.
- If the absolute worst happens and v2 must be rolled back, roll back the host and clients together. A v1 client against a v2 host is intentionally rejected.

---

## 3. Phase overview

| Phase | Fixes | Wire change | Risk | Suggested commit boundary |
|---|---|---|---|---|
| 1 | P0-1, P0-4 | No | Medium | “fix: namespace player idempotency keys and prevent double submit” |
| 2 | P0-3, P0-5 | No | Low | “fix: bound chunk reassembly and add connect/handshake timeouts” |
| 3 | P0-2, P0-6, P1-7, P1-1 | **Yes, v2** | High | One PR, internally split into 4 commits |
| 4 | P1-3, P1-4, P1-5, P1-6, P1-8, P1-9, P1-10 | Mostly no | Medium | “fix: multiplayer lifecycle and reliability” |
| 5 | P1-2, P2-1..P2-6 | No | Low | “chore: multiplayer polish, tests, docs” |

Do not start Phase 3 until Phase 1 and Phase 2 are merged and the full suite is green. Phase 3 is the only phase that can strand a live game night if partially deployed.

---

## 4. P0 fixes

### P0-1 — Player-supplied idempotency keys can poison round payouts

**Problem**

`HostSession.handleCommand` copies the client header into the local API:

```ts
// src/lib/net/hostSession.ts:519-522
const headers = { ...(msg.headers || {}) };
if (!headers['Idempotency-Key'] && !headers['idempotency-key']) {
  headers['Idempotency-Key'] = msg.id;
}
```

`post()` treats any existing transaction with that key as a replay without checking the posting:

```ts
// src/lib/ledger.ts:73-77
if (p.idemKey) {
  const existing = findByIdemKey(bundle, p.gameId || game.id, p.idemKey);
  if (existing) return { txn: existing, replay: true };
}
```

A player can send a transfer with `Idempotency-Key: round:<gameId>:<nextRound>:<victimPlayerId>`. When the banker starts that round, `startRound` uses exactly that key (`src/lib/service.ts:317`). `post()` returns the player's transfer instead of paying the salary. The salary is skipped and the wrong transaction is attached to the round.

**Design**

Two independent barriers:

1. The host never trusts a player key verbatim. It namespaces every player command as `player:<playerId>:<clientKey>`.
2. `post()` rejects a key reuse when the posting differs. Identical reuse still replays.

`clientKey` is the client header if present, otherwise the stable `CmdMessage.id` (automatic retries reuse the same message object and id). The namespace makes every player key disjoint from all host-generated keys (`round:`, `start:`, `bankfloat:`).

**Exact changes**

New file `src/lib/net/idempotency.ts`:

```ts
export const MAX_CLIENT_IDEM_KEY_CHARS = 128;

/** Stable key chosen by the client for one logical command. */
export function clientIdempotencyKey(
  headers: Record<string, string> | undefined,
  messageId: string
): string {
  const raw = headers?.['Idempotency-Key'] ?? headers?.['idempotency-key'] ?? messageId;
  const clean = String(raw || '').trim().slice(0, MAX_CLIENT_IDEM_KEY_CHARS);
  return clean || messageId;
}

/** Host-side namespace. No player key can collide with a server key. */
export function playerIdempotencyKey(playerId: string, clientKey: string): string {
  return `player:${playerId}:${clientKey}`;
}
```

`src/lib/net/hostSession.ts` in `handleCommand`:

```ts
// whitelist: the local API only understands Idempotency-Key
const clientKey = clientIdempotencyKey(msg.headers, msg.id);
const headers: Record<string, string> = {
  'Idempotency-Key': playerIdempotencyKey(record.playerId, clientKey),
};
```

Do not forward any other client header. Register the key for event suppression (P1-6) at the same point.

`src/lib/ledger.ts` in `post()`:

```ts
const game = bundle.game;
if (!game) throw fail('NOT_FOUND', 'game not found');

// Replay/conflict check before the status check: a retry may arrive after the
// game finished, and returning the original txn is still correct.
if (p.idemKey) {
  const existing = findByIdemKey(bundle, p.gameId || game.id, p.idemKey);
  if (existing) {
    if (!samePosting(existing, p, game.id)) {
      throw fail(
        'IDEMPOTENT_CONFLICT',
        `idempotency key ${p.idemKey} was already used for a different posting`
      );
    }
    return { txn: existing, replay: true };
  }
}

if (game.status !== 'active') { /* existing error */ }
```

Add a private comparator in `ledger.ts`:

```ts
function samePosting(t: Transaction, p: PostParams, gameId: string): boolean {
  if (t.game_id !== gameId) return false;
  if (t.txn_type !== p.txnType) return false;
  if (t.account_category !== p.category) return false;
  if (t.amount !== p.amount) return false;
  if ((t.ref_txn_id || '') !== (p.refTxnId || '')) return false;
  if (p.round !== undefined && t.round !== (p.round || 0)) return false;

  const dr = t.entries.find((e) => e.direction === Dr);
  const cr = t.entries.find((e) => e.direction === Cr);
  return (
    !!dr &&
    !!cr &&
    dr.account_type === p.from.type &&
    dr.account_ref === accountKey(p.from) &&
    cr.account_type === p.to.type &&
    cr.account_ref === accountKey(p.to)
  );
}
```

`src/lib/domain.ts` in `errorStatus`:

```ts
case 'IDEMPOTENT_CONFLICT': return 409;
```

**Tests**

New `src/lib/idempotency.test.ts`:

- Posting twice with the same key and identical params returns the same `txn.id` and leaves the txn count unchanged.
- Reusing the key with a different amount, payer, payee, category, or `txnType` throws `IDEMPOTENT_CONFLICT`.
- Reusing the key after the game is finished still replays (does not throw `INVALID_STATE`).
- Two `localApi` transfers with the same key produce one transaction.

Extend `src/lib/net/session.test.ts` with the attack:

```ts
const poisonKey = `round:${gameId}:1:${info.playerId}`;
await client.command(`/games/${gameId}/transfers`, {
  method: 'POST',
  headers: { 'Idempotency-Key': poisonKey },
  body: {
    from: { type: 'player', id: info.playerId },
    to: { type: 'bank', id: 'BANK' },
    amount: 50,
    account_category: 'RENT',
    description: 'poison attempt',
  },
});
await localApi(`/games/${gameId}/rounds`, { method: 'POST' });

const bundle = await loadGame(gameId);
const salary = bundle.txns.find(
  (t) =>
    t.account_category === 'ROUND_COMPLETE' &&
    t.entries.some((e) => e.account_type === 'player' && e.account_ref === info.playerId)
);
assert.ok(salary, 'round salary must still be posted');
assert.equal(salary!.amount, 200);
assert.ok(!salary!.idempotency_key.startsWith('round:'));
assert.ok(
  bundle.txns.find((t) => t.description === 'poison attempt')!.idempotency_key.startsWith(
    `player:${info.playerId}:`
  )
);
```

Also assert that a retry of the same `CmdMessage.id` produces one transaction and returns the same `txn.id`.

**Acceptance**

- No player-supplied key can collide with `round:`, `start:`, or `bankfloat:` keys.
- A conflicting reuse returns HTTP-equivalent 409 `IDEMPOTENT_CONFLICT` and commits nothing.
- An identical retry returns the original transaction and commits nothing.
- Round salary is paid for every active player even after a poison attempt.

---

### P0-2 — Full ledger is sent before the banker approves

**Problem**

`welcomeMessage()` embeds a full snapshot (`src/lib/net/hostSession.ts:255-264`) and is sent to any peer that completes `hello` (`:392`). The client applies it immediately (`src/lib/net/clientSession.ts:243-248`). Anyone with the room code can read every player, transaction, round, and audit row before the banker taps **Allow**.

**Design**

Make `welcome` a capability probe only:

```ts
export interface WelcomeMessage {
  t: 'welcome';
  protocol: number;
  room: string;
}
```

The ledger snapshot is sent only inside `join-accepted`, which is only produced by `accept()` after either a valid rejoin token or explicit banker approval.

**Exact changes**

- `src/lib/net/protocol.ts`: remove `gameId`, `rev`, and `snapshot` from `WelcomeMessage`.
- `src/lib/net/hostSession.ts`:
  - `welcomeMessage()` becomes synchronous and returns `{ t: 'welcome', protocol: PROTOCOL_VERSION, room: this.room }`.
  - `handleHello` sends it without `await`.
- `src/lib/net/clientSession.ts` in `dispatch`:

```ts
case 'welcome':
  this.welcomed = true;
  if (this.joinName) this.sendJoinRequest();
  break;
```

No `gameId` assignment, no `rev` assignment, no `onSnapshot` call.

**Tests**

In `src/lib/net/session.test.ts`:

- After the host receives the join request and before `host.approve`, assert `snapshots.length === 0` and `events.length === 0`.
- Assert the raw `welcome` payload (if observed) has no `snapshot` property.
- After approval, assert exactly one snapshot arrived and its game/player counts are correct.
- Add a negative test: a client that sends `hello` but never `join-request` receives no ledger data and is eventually dropped by the hello timeout (P1-10).

**Acceptance**

- No `snapshot`, `delta`, `event`, player, or transaction data reaches an unapproved peer.
- A pending player sees “waiting for the banker” without any ledger content.
- Approved players receive exactly one snapshot from `join-accepted`.

---

### P0-3 — Chunk assembler is an unbounded DoS

**Problem**

`src/lib/net/codec.ts`:

```ts
entry = { total: chunk.total, parts: new Array(chunk.total), ... }; // :99
const part = fromBase64(String(chunk.data || ''));                 // :106
```

A malicious peer can send `total = 2^31` (huge allocation) or invalid base64 (`atob` throws) before the join handshake. The host creates an assembler for every connection (`hostSession.ts:304`), and the client creates one too.

**Design**

Bound every dimension:

| Limit | Value | Reason |
|---|---|---|
| `MAX_CHUNKS_PER_MESSAGE` | 512 | 512 × 8 KB = 4 MB |
| `MAX_CHUNK_BYTES` | 8 KB | matches `CHUNK_PAYLOAD_BYTES` |
| `MAX_CHUNK_BASE64_CHARS` | 11264 | base64 envelope for 8 KB |
| `MAX_ASSEMBLER_BYTES` | 4 MB total | across all pending ids per connection |
| `MAX_ASSEMBLIES` | 8 | concurrent message ids per connection |
| `MAX_CHUNK_ID_CHARS` | 64 | prevents map-key memory abuse |

When at `MAX_ASSEMBLIES`, evict the oldest pending assembly so a legitimate retry can still complete; the cap is about memory, not fairness.

**Exact changes**

`src/lib/net/codec.ts`:

```ts
export const MAX_CHUNKS_PER_MESSAGE = 512;
export const MAX_CHUNK_BYTES = 8 * 1024;
export const MAX_CHUNK_BASE64_CHARS = 11 * 1024;
export const MAX_ASSEMBLER_BYTES = 4 * 1024 * 1024;
export const MAX_ASSEMBLIES = 8;

interface PendingChunks {
  total: number;
  parts: Uint8Array[];
  bytes: number;
  expiresAt: number;
}
```

In `push()`:

1. Validate `id` is a non-empty string ≤ 64 chars, `total` and `seq` are integers, `total <= MAX_CHUNKS_PER_MESSAGE`, `seq < total`.
2. Validate `data` is a string and `data.length <= MAX_CHUNK_BASE64_CHARS`.
3. Decode inside `try/catch`; on failure delete the assembly and return `null`.
4. Reject `part.length > MAX_CHUNK_BYTES`.
5. If the assembly is new and `pending.size >= MAX_ASSEMBLIES`, delete the oldest entry (first key in insertion order).
6. If `entry.parts[seq]` already exists, reject the duplicate (also keeps byte accounting simple).
7. Before storing, check `this.totalBytes + part.length <= MAX_ASSEMBLER_BYTES`; otherwise delete the assembly and return `null`.
8. Update `entry.bytes` and `this.totalBytes` when storing; decrement on completion, prune, overflow, and reset.

Also:

- `splitMessage()` throws `RangeError('message exceeds MAX_CHUNKS_PER_MESSAGE')` if `total > MAX_CHUNKS_PER_MESSAGE`. `sendMessage()` catches and logs; callers that send snapshots (`HostSession.accept`) pre-check and reject with a human-readable reason.
- Replace the literal `512 * 1024` in `hostSession.handleRaw` with `MAX_MESSAGE_CHARS`.
- Add the same raw-length cap to `clientSession.handleRaw` before `parseIncoming`.
- Do not call `atob` on an unbounded string; the char cap happens first.

**Tests**

Extend `src/lib/net/codec.test.ts`:

- `total = MAX_CHUNKS_PER_MESSAGE + 1` → `null`, `size === 0`.
- Invalid base64 (`"!!!!"`) → `null`, no pending entry.
- Chunk `data` longer than `MAX_CHUNK_BASE64_CHARS` → `null`.
- Cumulative bytes across assemblies > `MAX_ASSEMBLER_BYTES` → rejected, `totalBytes` returns to 0 after prune/reset.
- More than `MAX_ASSEMBLIES` distinct ids → `size <= MAX_ASSEMBLIES`.
- Duplicate `seq` → rejected.
- Deterministic fuzz loop (e.g. 500 malformed `ChunkMessage` shapes) never throws and never exceeds the caps.
- Existing round-trip and expiry tests stay green.

**Acceptance**

- Malformed chunk input cannot allocate an unbounded array or throw out of `push`.
- Per-connection reassembly memory is bounded by 4 MB.
- A legitimate 4 MB snapshot still reassembles.
- A snapshot above 4 MB fails with a clear “game history too large to sync” rejection, not a hang.
---

### P0-4 — Double-click or lost ack can double-pay

**Problem**

`TransferCard` has no submit lock (`src/components/TransferCard.tsx:123-153`, `:325-332`). A double-click creates two different idempotency keys. Worse, after `ClientSession` exhausts its automatic retries (`COMMAND_TIMEOUT_MS = 7000`, `MAX_COMMAND_ATTEMPTS = 3`), the user sees an error and clicks again; the component generates a fresh key, so a first command that committed but lost its ack is applied twice.

**Design**

Three layers:

1. **UI lock:** a `submitting` state disables the button and ignores re-entry.
2. **Stable logical intent:** while the money fields (payer, payee, amount, category) are unchanged, a manual retry reuses the same client key. Editing a money field creates a new key. The memo/description is deliberately excluded from the fingerprint: changing only the memo must not turn a retry into a second payment.
3. **Server replay:** P0-1 makes any retry with the same key idempotent, whether the first attempt committed or not.

If the user edits the amount after a timeout, that is a new logical payment and a new key; the first payment may still have committed. The UI should prompt “check the ledger before sending a different amount” after a timeout.

**Exact changes**

New file `src/lib/transferIntent.ts` (pure, testable):

```ts
export interface TransferIntent {
  key: string;
  fingerprint: string;
}

export function transferFingerprint(input: {
  from: string; // `${type}:${id}`
  to: string;
  amount: number;
  category: string;
}): string {
  return JSON.stringify([input.from, input.to, input.amount, input.category]);
}

export function resolveTransferIntent(
  previous: TransferIntent | null,
  fingerprint: string,
  makeKey: () => string
): TransferIntent {
  if (previous && previous.fingerprint === fingerprint) return previous;
  return { key: makeKey(), fingerprint };
}
```

`src/components/TransferCard.tsx`:

```tsx
const [submitting, setSubmitting] = useState(false);
const intentRef = useRef<TransferIntent | null>(null);
const offline = sessionRole === 'client' && connectionState !== 'connected';

const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  if (!isValid || !game || submitting || offline) return;

  const fingerprint = transferFingerprint({
    from: `${fromAcc.type}:${fromAcc.id}`,
    to: `${toAcc.type}:${toAcc.id}`,
    amount: numAmount,
    category,
  });
  const intent = resolveTransferIntent(intentRef.current, fingerprint, () =>
    generateIdemKey('transfer')
  );
  intentRef.current = intent;

  setSubmitting(true);
  try {
    await gameApi(`/games/${game.id}/transfers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': intent.key },
      body: { /* fromAcc, toAcc, amount, category, desc */ },
    });
    intentRef.current = null; // success: next payment gets a new key
    // existing sound/toast/clear/refresh
  } catch (err: any) {
    if (err?.type === 'IDEMPOTENT_CONFLICT' || err?.type === 'INVALID') {
      intentRef.current = null;
    }
    // timeout / OFFLINE / TIMEOUT: keep the intent so a manual retry reuses it
    showToast(err.message || 'Transfer failed', 'error');
  } finally {
    setSubmitting(false);
  }
};
```

Button:

```tsx
<button
  type="submit"
  disabled={!isValid || submitting || offline}
  aria-busy={submitting}
>
  {submitting ? 'Posting…' : offline ? 'Reconnecting…' : 'Post Transfer'}
</button>
```

Use the same disabled/label treatment for the banker path (there is only one form).

**Tests**

`src/lib/transferIntent.test.ts`:

- Same fingerprint returns the same key object.
- Changed payer/payee/amount/category generates a new key.
- Changed description (not part of the fingerprint) reuses the key.
- `makeKey` is not called on a cache hit.

Server side is covered by P0-1. Add a manual UI check: double-click during a 3-second latency injection produces one transaction.

**Acceptance**

- Double-click produces one command.
- A retry after `TIMEOUT` reuses the key and cannot double-pay.
- Editing the amount after a timeout creates a new logical payment, as intended.
- Submitting while the client is reconnecting is disabled with a visible reason.

---

### P0-5 — No connect / join timeout; UI can hang on “Connecting…”

**Problem**

- `peerTransport.openOnce` never times out registration (`src/lib/net/peerTransport.ts:74-143`).
- `ClientSession.join()` waits forever for `welcome` (`src/lib/net/clientSession.ts:201-210`).
- `createPeerTransport` retries transient failures with backoff, so a dead signaling server can hold the UI for tens of seconds.

**Design**

Bound three phases:

| Phase | Timeout | Behavior |
|---|---|---|
| PeerJS registration | 12 s per attempt, 25 s total | destroy the peer, retry transient errors, then reject |
| Connection open + welcome | 15 s from `join()` | reject with `JOIN_TIMEOUT`, status `error`, dispose |
| Join request acknowledged | 10 s from `sendJoinRequest()` to `join-pending` / `join-accepted` | reject with `JOIN_TIMEOUT`, status `error`, dispose |

Once `join-pending` arrives, the banker may take as long as they need to approve. The UI already displays “Request sent — waiting for the banker.” Do not put a timeout on human approval.

**Exact changes**

New `src/lib/net/timeout.ts`:

```ts
export function withTimeout<T>(promise: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
```

`src/lib/net/transportTypes.ts` add:

```ts
openTimeoutMs?: number;
totalTimeoutMs?: number;
```

`src/lib/net/peerTransport.ts`:

- In `openOnce`, arm `openTimeoutMs` (default 12 s). On expiry: `peer.destroy()`, reject with `Object.assign(new Error('Timed out contacting the signaling server'), { type: 'timeout' })`. Clear the timer on open, error, and destroy.
- In `createPeerTransport`, compute `const deadline = Date.now() + (options.totalTimeoutMs ?? 25_000)` before the loop. Before each attempt and before each retry sleep, if `Date.now() >= deadline`, throw the last timeout error. This prevents a 5-retry × 8 s tail.
- Keep `browser-incompatible`, `invalid-id`, and `invalid-key` fatal.

`src/lib/net/hostSession.ts` `HostSession.start` passes `{ openTimeoutMs: 12_000, totalTimeoutMs: 25_000 }` to `createTransport` so starting a room cannot hang forever either.

`src/lib/net/clientSession.ts`:

```ts
export interface ClientSessionOptions {
  handshakeTimeoutMs?: number;
  pendingAckTimeoutMs?: number;
}

static async create(room: string, handlers: ClientSessionHandlers, options: ClientSessionOptions = {})
```

- `join()` arms `handshakeTimeoutMs` (default 15 s). On expiry: `failJoin(new RemoteCommandError(504, 'JOIN_TIMEOUT', 'The banker did not answer. Check the room code and try again.'))`, call `onError`, set status `error`, dispose so the reconnect loop cannot keep the screen in “Connecting…”.
- `sendJoinRequest()` arms `pendingAckTimeoutMs` (default 10 s) unless already `accepted`. Clear it on `join-pending`, `join-accepted`, `join-rejected`, `leave`, and `handleHostBye`.
- `welcome` clears the handshake timer but arms the pending-ack timer when the request is sent.
- Add a `failJoin(error)` helper that rejects and clears `joinPromise`, calls `handlers.onError`, sets status `error`, and disposes. Use it from all terminal join paths, including `join-rejected` after a resync.

**Tests**

- `src/lib/net/timeout.test.ts`: resolves before the deadline; rejects at the deadline; clears the timer.
- New session test with a fake transport whose `connect()` never opens: `client.join()` rejects with `JOIN_TIMEOUT` within the configured short timeout, status ends at `error`, and no reconnect is scheduled after dispose.
- Session test where the host sends `welcome` but never acknowledges `join-request`: the pending-ack timer rejects.
- PeerJS registration timeout is manual-verified (see §9) because `Peer` is not injectable; `withTimeout` covers the primitive.

**Acceptance**

- A dead signaling server surfaces a retryable error in ≤ 25 s.
- A host that never answers surfaces a retryable error in ≤ 15 s after Connect.
- A banker who is slow to approve does not trigger a timeout.
- The Join screen always ends in a state with a Retry or Leave action.

---

### P0-6 — First-join token race can duplicate a seat or lock a player out

**Problem**

The host generates the seat token only when approving (`hostSession.ts:170-189`), and the client persists it only after receiving `join-accepted` (`clientSession.ts:300-311`). If that message is lost:

- Pending game: the host has seated the player, but the client has no credential. On reconnect the host sees no valid rejoin and seats a duplicate.
- Active game: the same reconnect is rejected (“only existing seats can reconnect”), locking the player out.

**Design**

Use a **client-generated, persisted join key** as the stable identity before approval:

```ts
interface JoinReservation {
  joinKey: string;          // 128-bit random, generated once per device+room
  playerId: string | null;  // null until the banker approves
  playerToken: string;      // host-issued, for compatibility/diagnostics
  name: string;
  gameId: string;
  status: 'pending' | 'seated';
  createdAt: number;
}
```

- The client stores `joinKey` in localStorage **before** sending `hello`. It is not the room code and is never placed in the URL.
- The host keeps `joinKey -> JoinReservation` and persists it. `playerId -> playerToken` remains for migration and for clients that only have a token.
- `hello` and `join-request` carry `joinKey`.
- A reconnect with a `seated` reservation is accepted immediately, with or without `playerToken`. This is what recovers a lost `join-accepted`.
- A reconnect with a `pending` reservation is not auto-seated; it just re-sends the pending state.
- `kick` deletes the reservation, so a kicked seat can no longer auto-rejoin.
- Two connections with the same `joinKey` map to the same seat; the newer one wins and the older receives a `seat-replaced` bye (P1-1).

Why `joinKey` alone is enough: it is a 128-bit secret stored only on that device and sent only over the encrypted data channel. The room code remains the public share token; the join key is the private seat credential.

**Exact changes**

`src/lib/net/joinKey.ts` (new):

```ts
export function newJoinKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `jk-${hex}`;
}

export function sanitizeJoinKey(value: unknown): string {
  const clean = String(value || '').trim();
  return /^jk-[a-f0-9]{32}$/.test(clean) ? clean : '';
}
```

`src/lib/net/clientSession.ts`:

- Extend `StoredCredentials` with `joinKey: string`.
- In the constructor, read credentials, use the stored `joinKey` or generate one, and persist it immediately, even before `playerId`/`playerToken` exist.
- `readCredentials` tolerates missing `playerId`/`playerToken` (only `joinKey` required); add a separate `hasSeatedCredentials` if needed.
- `hasStoredSession(room)` returns true when a `joinKey` exists, so a lost-ack reload auto-reconnects and is auto-accepted.
- Include `joinKey` in `sendHello()` and `sendJoinRequest()`.

`src/lib/net/protocol.ts`:

```ts
export interface HelloMessage {
  t: 'hello';
  protocol: number;
  room: string;
  joinKey?: string;
  playerToken?: string;
  playerId?: string;
}

export interface JoinRequestMessage {
  t: 'join-request';
  name: string;
  joinKey?: string;
  playerToken?: string;
  playerId?: string;
}
```

`joinKey` stays optional at the type level so the host can give a clear rejection for a malformed client; a v2 client always sends it.

`src/lib/net/hostSession.ts`:

- Add `private reservations = new Map<string, JoinReservation>()`.
- `PeerRecord` gains `joinKey: string`.
- `handleHello`:
  1. Accept `joinKey` and sanitize it.
  2. `if (await verifyRejoin(msg.playerId, msg.playerToken, record.joinKey))` → `accept`.
  3. Else, if `reservations.get(joinKey)?.status === 'seated'` → `accept` with the reserved `playerId`/`playerToken`.
  4. Else send `welcome`.
- `handleJoinRequest`:
  1. Sanitize `joinKey`; if absent, reject with “Reload the app to reconnect.”
  2. If `verifyRejoin` succeeds → bind the joinKey to the reservation and accept.
  3. If a seated reservation exists → accept (lost-ack replay).
  4. Run the existing pending-game, seat-count, and name checks **only for a brand-new reservation**.
  5. Create or update a `pending` reservation, persist it, send `join-pending`, and notify the banker only once per `joinKey`.
- `approve(sessionId)`:
  1. Guard with a host-level `approvingJoinKeys: Set<string>` in addition to `record.accepting`.
  2. If the reservation is already `seated`, call `accept` with the existing player; do not call `addPlayer`.
  3. Otherwise `addPlayer`, create the reservation with `status: 'seated'`, and **persist before sending `join-accepted`**.
  4. If `accept` fails, the reservation remains, so the next reconnect recovers.
- `verifyRejoin(playerId, token, joinKey?)` searches reservations by `playerId + playerToken`, binds `joinKey` when present (migration from v1 clients with only a token), and verifies the player still exists.
- `peers` deduplicates pending records by `joinKey`, so two tabs from the same device do not render two Allow buttons.
- `kick` deletes the reservation by playerId and persists.

**Credential persistence (feeds P1-5)**

Do not keep the new reservation map in a second localStorage key ad hoc. Introduce `src/lib/net/hostCredentials.ts` now:

```ts
export interface HostCredentialSnapshot {
  reservations: JoinReservation[];
  tokens: Record<string, string>; // legacy migration
}

export interface HostCredentialStore {
  load(gameId: string): Promise<HostCredentialSnapshot | null>;
  save(gameId: string, snapshot: HostCredentialSnapshot): Promise<void>;
}
```

- Primary: IndexedDB `banker_session_store`, object store `credentials`, keyPath `id`.
- Fallback/write-through: `banker_tokens_<gameId>` and `banker_reservations_<gameId>` in localStorage.
- `HostSession.start` awaits `loadCredentials()` before opening the transport.
- `approve` awaits a durable save before sending `join-accepted`.
- `kick`/`stop` schedule a save; ignore storage failures but log them.

This lands the storage abstraction in the P0 phase so P1-5 is only a swap/verification, not another rewrite.

**Tests**

Extend `src/lib/net/session.test.ts` with test-hub support for dropping one outbound message:

```ts
hub.dropNext = (from, to, data) => (data as any)?.t === 'join-accepted';
```

Scenarios:

1. **Lost `join-accepted` in a pending game:** join, approve while dropping the ack, `client.leave()`, create a new `ClientSession` against the same localStorage, join again. Assert the same `playerId`, `host.peers` count unchanged, and `bundle.players.length === 1`.
2. **Lost ack in an active game:** approve, start the game, drop the next `join-accepted`, reconnect. Assert the same seat and no rejection.
3. **Double approve:** call `host.approve(sessionId)` twice; assert one player.
4. **Two connections, same joinKey:** open a second client transport with the same stored credentials; assert both resolve to the same `playerId` and the first receives `seat-replaced`.
5. **Kick revokes auto-rejoin:** kick, reconnect with the same joinKey; assert `join-pending` (pending game) or rejection (active game), not auto-seat.
6. **Legacy token migration:** seed only `playerId + playerToken` in localStorage; connect; assert the host binds a new joinKey and the next reconnect works without approval.

**Acceptance**

- A lost `join-accepted` never creates a duplicate player.
- A seated player can rejoin an active game without banker action.
- A kicked player cannot rejoin by replaying the old joinKey.
- Approval is idempotent across repeated clicks and multiple connections.
- The reservation survives a host reload (via the credential store).

---

### P1-7 (executed with P0-6) — `accept()` reads `rev` before awaiting the snapshot

This is listed under P1 in the review but is tightly coupled to the join handshake, so implement it in the same protocol-v2 change set.

**Problem**

`accept()` sets `record.accepted = true` and captures `this.rev`, then awaits `snapshot()` (`hostSession.ts:456-466`). A commit during the snapshot is broadcast to the newly accepted peer, so a `delta` can arrive before `join-accepted`; the client then regresses its `rev` and triggers a spurious resync. Worse, depending on timing, the snapshot and delta can be inconsistent.

**Design**

Buffer outbound messages for a record while its snapshot is being built:

```ts
interface PeerRecord {
  // ...
  joining: boolean;
  joinBuffer: HostMessage[];
}
```

- `broadcastJournal`: if `record.accepted`, send immediately. Else if `record.joining`, push the delta and its event messages onto `record.joinBuffer`. Else drop.
- `accept`:
  1. Set `record.joining = true`, clear the buffer.
  2. Capture `const revAt = this.rev` synchronously.
  3. `await loadGame()` once; use the bundle for both the player check and the snapshot (avoids a second read).
  4. Build `join-accepted` with `rev: revAt` and that snapshot.
  5. Synchronously: set `record.accepted = true`, `record.joining = false`, take the buffered array, `send(join-accepted)`, then send each buffered message in order.
  6. On any error, reset `joining`/`joinBuffer` and reject the record.
- Because the block from “set accepted” through “send join-accepted” has no `await`, no commit can interleave and overtake it.
- A commit during the snapshot may be both in the snapshot and in the buffer. The client applies the delta idempotently after the snapshot; `applyDelta` upserts, so this is safe.

Client-side complement:

- `handleDelta` applies the journal **before** advancing `rev`:

```ts
private async handleDelta(msg) {
  if (msg.rev <= this.rev) return;
  if (this.rev > 0 && msg.rev > this.rev + 1) { this.requestResync(); return; }
  try {
    await this.handlers.onDelta(msg.journal, msg.rev);
    this.rev = msg.rev;
  } catch (err) {
    this.requestResync();
    throw err;
  }
}
```

- `handleAccepted` should not call `onJoined` again on a resync. Capture `wasAccepted` and only fire `onJoined` on the first acceptance.

**Tests**

- Add a test-only `HostSessionOptions.hooks.beforeAcceptSnapshot?: () => Promise<void>` seam. In the test, the hook performs one `localApi` transfer (commit) before the snapshot read.
- Assert the client receives no rev gap, ends with the transfer in its mirror, and the final mirror equals the host bundle.
- Assert `onDelta` revs are contiguous after the `join-accepted` rev.
- Assert a resync (`hello` after a gap) re-sends a snapshot and does not duplicate money.

**Acceptance**

- No `delta` can arrive before the `join-accepted` that establishes its baseline.
- A commit during snapshot preparation is applied exactly once (idempotent upsert allowed).
- A rev gap triggers one resync, not a loop.
---

## 5. P1 fixes

### P1-1 — Explicit “Stop hosting” causes endless reconnect

**Problem**

`HostSession.stop()` sends `host-bye` with the reason “Host ended the session” (`hostSession.ts:209-224`). The client only treats “another device” and “removed by the banker” as terminal (`clientSession.ts:404-419`), so an intentional stop leaves every player in `reconnecting` forever. Conversely, a page reload currently sends the same reason; making all byes terminal would break the intended host-reload resume.

**Design**

Give `host-bye` a machine-readable code:

```ts
export type HostByeCode =
  | 'host-stopped'    // terminal: banker pressed Stop
  | 'game-switched'   // terminal: banker opened another game
  | 'removed'         // terminal: kicked
  | 'seat-replaced';  // terminal: same seat opened on another device

export interface HostByeMessage {
  t: 'host-bye';
  code: HostByeCode;
  reason: string;
}
```

- A **page reload/unmount** sends no bye at all. It closes the data channel; the client sees `handleDisconnect` and reconnects, which is the correct behavior for “the host is coming back.”
- An **explicit stop** sends the bye and closes after a short flush delay (reuse the 150 ms `closeSoon` pattern) so the reliable data channel has a chance to deliver it.
- `GameProvider` unmount calls `host.stop({ notify: false })`; `stopHosting` calls `host.stop({ code: 'host-stopped', reason: 'The banker ended the session' })`; `loadGame` switching games calls `stop({ code: 'game-switched', ... })`.

**Exact changes**

`src/lib/net/protocol.ts`: add `HostByeCode` and the required `code` field.

`src/lib/net/hostSession.ts`:

```ts
interface StopOptions {
  reason?: string;
  code?: HostByeCode;
  notify?: boolean;   // default true
}

stop(options: StopOptions = {}): void {
  if (this.stopped) return;
  this.stopped = true;
  const { notify = true, code = 'host-stopped', reason = 'The banker ended the session' } = options;

  for (const record of this.connections.values()) {
    if (notify) this.send(record, { t: 'host-bye', code, reason });
    if (!notify) record.conn.close();
  }
  const finish = () => {
    for (const record of this.connections.values()) record.conn.close();
    this.connections.clear();
    try { this.transport?.destroy(); } catch { /* ignore */ }
    this.transport = null;
    this.emitPeers();
  };
  if (notify) setTimeout(finish, 150);
  else finish();
}
```

`kick()` uses `code: 'removed'`. The `accept()` replacement path uses `code: 'seat-replaced'`.

`src/lib/net/clientSession.ts`:

```ts
const TERMINAL_BYE_CODES = new Set(['host-stopped', 'game-switched', 'removed', 'seat-replaced']);

private handleHostBye(msg: Extract<HostMessage, { t: 'host-bye' }>): void {
  this.accepted = false;
  this.pendingApproval = false;
  this.stopHeartbeat();
  const terminal = TERMINAL_BYE_CODES.has(msg.code);
  if (terminal) {
    this.disposed = true;
    this.failPending(msg.reason);
    this.failJoin(new Error(msg.reason)); // rejects joinPromise too
    this.handlers.onRejected(msg.reason);
    this.handlers.onStatus('error');
    this.closeResources();
    return;
  }
  this.handlers.onStatus('reconnecting');
  this.scheduleReconnect();
}
```

`GameContext`:

- `startHosting`/`stopHosting` pass the options.
- `onRejected` already sets `sessionError` and `sessionReady=false`, which brings the Join screen back with the terminal message.
- On terminal host stop, show “The banker ended the session” and offer “Leave and open local mode.”

**Tests**

- `host.stop({ code: 'host-stopped' })` → client `onRejected` called, status `error`, no `reconnecting` status after 200 ms.
- `host.stop({ notify: false })` → client status becomes `reconnecting` (simulated reload).
- `kick()` → client receives `code: 'removed'` and is terminal.
- The bye is actually delivered before the channel closes (this is why the 150 ms flush delay exists).

**Acceptance**

- Stop hosting is terminal and clear.
- Reloading the host does not permanently kick players.
- Kicked/replaced seats are terminal and do not retry forever.

---

### P1-2 — No “Leave session” after joining

**Problem**

`leaveSession()` exists but is only exposed on `JoinSessionView` (`clientRef` UI). Once a player is accepted and `sessionReady` is true, there is no way to leave except closing the tab.

**Design**

Add a client-only control in the header, next to `ConnectionPill`:

```tsx
{sessionRole === 'client' && (
  <button
    id="btn-leave-session"
    className="btn btn-ghost btn-sm"
    title="Leave the hosted table and return to local mode"
    onClick={() => {
      if (window.confirm('Leave the hosted table? The banker can re-admit you later.')) leaveSession();
    }}
  >
    Leave
  </button>
)}
```

`leaveSession()` should:

1. Call `clientRef.current?.leave()`.
2. `setClientSession(null)`.
3. Clear `join` from the URL (the current `window.location.assign(pathname)` does this by reloading; keep the reload as the simplest safe reset, but first set state to `idle` so the UI does not flash an error).
4. If the player has a stored `joinKey`, keep it. Leaving must not revoke the seat; reconnecting should auto-rejoin (banker approval is only needed for a new joinKey).

**Tests**

- Manual: join, press Leave, confirm; app returns to local mode; reopening `?join=` auto-rejoins the same seat.
- Unit: `ClientSession.leave()` rejects a pending join and clears timers (already partly covered by P0-5; extend).

**Acceptance**

- A player can leave without closing the tab.
- Leaving does not delete the join key or seat reservation.
- Rejoining the same room restores the same seat without banker action.

---

### P1-3 — `dispatch()` exceptions can leave `joinPromise` pending forever

**Problem**

`dispatch` catches every error and only logs it (`clientSession.ts:240-298`). If `handleAccepted` throws while applying the snapshot, the client never sets `accepted = true`, never resolves `joinPromise`, and the Join screen stays in “Connecting…” forever. A failed delta apply also advances `rev` before the write, permanently losing the delta.

**Design**

- `dispatch`’s catch becomes a terminal join failure: reject `joinPromise`, call `onError`, set status `error`.
- `handleAccepted` applies the snapshot before flipping `accepted`; on failure it reports a device-storage error and rethrows.
- `handleDelta` applies before advancing `rev` (already specified in P1-7) and requests a resync on failure.
- `join-rejected` during an already-accepted resync is terminal, not a silent no-op.

**Exact changes**

`src/lib/net/clientSession.ts`:

```ts
private async dispatch(msg: HostMessage): Promise<void> {
  try {
    switch (msg.t) { /* ... */ }
  } catch (err: any) {
    console.error('Client message handling failed:', err);
    this.failJoin(err instanceof Error ? err : new Error(String(err)));
    this.handlers.onError(err?.message || 'Could not apply the banker’s update on this device');
    this.handlers.onStatus('error');
  }
}

private failJoin(error: Error): void {
  const pending = this.joinPromise;
  this.joinPromise = null;
  if (pending) pending.reject(error);
}
```

In `handleAccepted`, wrap the snapshot apply:

```ts
try {
  await this.handlers.onSnapshot(msg.snapshot, msg.gameId);
} catch (err) {
  this.handlers.onError('Could not load the game into local storage. Free up space and retry.');
  this.handlers.onStatus('error');
  throw err;
}
```

Do not set `accepted = true`, `sessionReady`, or resolve `joinPromise` until after the snapshot succeeds.

`join-rejected`:

```ts
case 'join-rejected':
  this.pendingApproval = false;
  this.handlers.onRejected(msg.reason);
  if (this.accepted) {
    // A resync was rejected (seat revoked or host lost credentials).
    this.accepted = false;
    this.disposed = true;
    this.failPending(msg.reason);
    this.handlers.onStatus('error');
    this.closeResources();
  }
  this.failJoin(new Error(msg.reason));
  break;
```

Add a consecutive delta-apply failure counter; after 3 failures, surface `onError` and status `error` instead of silently resyncing forever.

**Tests**

- Handler `onSnapshot` throws → `join()` rejects, status `error`, `sessionReady` false, no hang.
- Handler `onDelta` throws once → a resync is requested; the next `join-accepted` snapshot restores the mirror and the missing transaction is present exactly once.
- `join-rejected` after acceptance → `onRejected`, status `error`, disposed.

**Acceptance**

- No code path leaves `joinPromise` pending after a terminal error.
- A failed mirror write is visible and does not silently lose data.
- Delta apply failure resyncs instead of skipping a revision.

---

### P1-4 — Hosting continues on the old game after the host switches games

**Problem**

`loadGame()` changes `currentGameId` without stopping `HostSession` (`GameContext.tsx:189-220`). The room stays bound to the old game while the header shows the new one. Broadcasts are filtered to the old game, so the host UI and the players diverge.

**Design**

- `loadGame(gameId)` stops any active host session whose `gameId` differs, with `code: 'game-switched'`.
- An in-flight `startHosting()` is cancelled by an epoch guard if the game changes before the transport resolves.
- The auto-resume effect remains keyed by game id, so the new game does not auto-host unless it was previously flagged.
- The UI communicates the consequence: stopping hosting for the old room is intentional, not a silent failure.

**Exact changes**

`src/context/GameContext.tsx`:

- Add `const currentGameIdRef = useRef<string | null>(null);` and keep it in sync in `loadGame`/`setCurrentGameId`.
- Add `const hostEpochRef = useRef(0);`.
- Define a `teardownHost(options)` callback **before** `loadGame`, using refs + state setters, not the later `stopHosting` callback (avoids the dependency cycle). It:
  - calls `hostRef.current?.stop(options)`,
  - nulls `hostRef`,
  - `setCommitListener(null)`,
  - clears host UI state,
  - removes `banker_hosting_<oldGameId>`.
- `loadGame`:

```ts
const previous = currentGameIdRef.current;
if (hostRef.current && previous && previous !== gameId) {
  teardownHost({
    code: 'game-switched',
    reason: 'The banker opened another game',
  });
  showToast('Hosted session stopped because you opened another game', 'info');
} else if (sessionRoleRef.current === 'host' && !hostRef.current) {
  hostEpochRef.current += 1; // cancel an in-flight start
}
```

- `startHosting`:

```ts
const gameId = currentGameId;
const epoch = ++hostEpochRef.current;
const session = await HostSession.start({ ... });
if (epoch !== hostEpochRef.current || currentGameIdRef.current !== gameId) {
  session.stop({ notify: false });
  return;
}
hostRef.current = session;
```

- `stopHosting` delegates to `teardownHost({ code: 'host-stopped', reason: 'The banker ended the session' })` and shows the existing toast only for the explicit path.

`GamesListModal` needs no change because `loadGame` owns the guard. If product wants a confirmation, add it there later; the guard is the invariant.

**Tests**

- Manual: host game A, open game B, confirm the room closes with `game-switched`, `sessionRole` returns to `local`, and A's players see a terminal message.
- Manual: start hosting and immediately switch games before “Starting…” finishes; confirm the late session is stopped and never becomes `host`.
- Unit-test the helper if `teardownHost` is extracted; otherwise cover via the manual matrix.

**Acceptance**

- A host session is always bound to exactly one `gameId`.
- Switching games never leaves a room broadcasting the wrong game.
- A late `startHosting` cannot resurrect a session for the previous game.

---

### P1-5 — Host tokens live only in localStorage

**Problem**

`HostSession` persists the token map with `localStorage.setItem` (`hostSession.ts:281-289`). In private browsing or after clearing site data, a host reload loses all seat credentials; active-game players can no longer rejoin. The new `joinKey` reservations from P0-6 have the same requirement.

**Design**

Use the `HostCredentialStore` abstraction introduced in P0-6:

- Primary storage: IndexedDB `banker_session_store`, store `credentials`, key `gameId`. Value: `{ id, reservations, tokens, updatedAt }`.
- Write-through/fallback: localStorage keys `banker_tokens_<gameId>` and `banker_reservations_<gameId>`.
- On load, merge both sources. Legacy `tokens` entries become seated reservations with `joinKey: 'legacy:<playerId>'` so a token-only client can still rejoin and then bind a real joinKey.
- `HostSession.start` awaits the load before opening the transport.
- `approve` awaits a durable save before sending `join-accepted` (critical for the lost-ack recovery).
- `kick`/`stop` schedule a save and flush on a best-effort basis.
- If IndexedDB fails, the localStorage fallback keeps working; if both fail, approval still works for the current session, but a reload requires re-approval. Surface a one-time warning in that case.

**Exact changes**

New `src/lib/net/hostCredentials.ts`:

```ts
const SESSION_DB = 'banker_session_store';
const SESSION_VERSION = 1;

export interface StoredReservation {
  joinKey: string;
  playerId: string | null;
  playerToken: string;
  name: string;
  gameId: string;
  status: 'pending' | 'seated';
  createdAt: number;
}

export interface HostCredentialSnapshot {
  reservations: StoredReservation[];
  tokens: Record<string, string>;
}

export interface HostCredentialStore {
  load(gameId: string): Promise<HostCredentialSnapshot | null>;
  save(gameId: string, snapshot: HostCredentialSnapshot): Promise<void>;
}

export function createHostCredentialStore(): HostCredentialStore;
```

Implementation notes:

- `openSessionDb()` mirrors the `openDb` pattern in `src/lib/db.ts` but uses its own DB name/version.
- `load` reads IndexedDB first, then merges the legacy localStorage map. Deduplicate by `playerId`/`joinKey`.
- `save` writes IndexedDB and then localStorage; each failure is caught independently.
- Do not put session credentials in `banker_db` or in the backup/snapshot stores. They must never be replicated to players.

`src/lib/net/hostSession.ts`:

- Replace `loadTokens`/`persistTokens` with `loadCredentials`/`saveCredentials`.
- `approve`:

```ts
this.reservations.set(reservation.joinKey, reservation);
await this.saveCredentials();       // durable before the ack
await this.accept(record, playerId, token);
```

- `stop` schedules a final save before destroying the transport (fire-and-forget is acceptable; the approval save already happened).

**Tests**

New `src/lib/net/hostCredentials.test.ts` (fake-indexeddb):

- Save then load round-trips reservations and legacy tokens.
- A legacy token map loads as a seated reservation.
- IndexedDB failure falls back to localStorage without throwing.
- Host reload simulation: `HostSession.start` → approve → `stop` → new `HostSession.start` → client reconnects with the stored joinKey and is accepted without approval.
- Credentials are not included in `dumpAll`/backup payloads (add an assertion that the session DB is separate).

**Acceptance**

- A host reload preserves all seat credentials in normal browsing.
- Private browsing degrades gracefully (localStorage fallback or a clear warning), never silently corrupts seats.
- Credentials are never broadcast to players.

---

### P1-6 — `suppressEventsFor` is a single global field

**Problem**

`HostSession` stores one `suppressEventsFor: string | null` (`hostSession.ts:126`, used at `:236-240`, set at `:525-541`). Two concurrent player commands overwrite each other: the first commit may send the first player’s own event, and the second may suppress the wrong player. Money is unaffected, but toasts/sounds are misattributed and duplicate.

**Design**

Suppress by **command origin**, not by a global session field:

- Each player command has a unique effective key (`player:<playerId>:<clientKey>` from P0-1).
- The host records `commandOrigins: Map<effectiveKey, sessionId>` before calling `localApi`, and removes the entry in `finally` after the commit listener has run.
- `broadcastJournal` derives each event’s origin from the transactions’ `idempotency_key` and sends an event to every peer **except** the peer that originated that transaction.
- Banker-local commands have no origin, so their events go to all remote peers.
- Remove `suppressEventsFor` entirely.

Why this is precise: `localApi` serializes mutations through its `enqueue` chain, and the commit listener runs synchronously in `tx.oncomplete` before `localApi` resolves. Therefore the origin map is populated when the delta is broadcast. Multiple queued commands still commit one at a time; each delta carries exactly its own keys.

**Exact changes**

`src/lib/net/hostSession.ts`:

```ts
private commandOrigins = new Map<string, string>(); // idempotency key -> sessionId
```

Add a pure helper (exported for tests):

```ts
export interface OriginatedEvent {
  event: RemoteEvent;
  origin: string | undefined;
}

export function eventsWithOrigins(
  j: SerializedJournal,
  origins: Map<string, string>
): OriginatedEvent[] {
  // For rounds, use the round transaction(s); for transfers/voids, use the txn.
  // Deduplicate by `${origin ?? ''}:${kind}:${category}:${amount}:${description}`.
}
```

`broadcastJournal`:

```ts
this.rev += 1;
const delta = { t: 'delta', rev: this.rev, journal: filtered } as const;
const originated = eventsWithOrigins(filtered, this.commandOrigins);

for (const record of this.connections.values()) {
  if (record.closed) continue;
  const messages: HostMessage[] = [delta];
  for (const item of originated) {
    if (item.origin !== record.sessionId) {
      messages.push({ t: 'event', event: item.event });
    }
  }
  if (record.accepted) {
    for (const m of messages) this.send(record, m);
  } else if (record.joining) {
    record.joinBuffer.push(...messages);
  }
}
```

`handleCommand`:

```ts
const key = playerIdempotencyKey(record.playerId, clientIdempotencyKey(msg.headers, msg.id));
this.commandOrigins.set(key, record.sessionId);
try {
  const result = await localApi(path, { method, body: msg.body, headers: { 'Idempotency-Key': key } });
  this.send(record, { t: 'ack', id: msg.id, result: result ?? null });
} catch (err) {
  /* existing nack */
} finally {
  this.commandOrigins.delete(key);
}
```

Note: `broadcastJournal` runs during `await localApi(...)`, before `finally`. If a future refactor makes the commit listener async, switch to a short deferred delete; add a comment.

**Tests**

- Unit-test `eventsWithOrigins`:
  - One transfer keyed to session A → one event with `origin === 'A'`.
  - Round with several salary txns from the same key prefix → one round event with origin A.
  - Banker command with no map entry → `origin === undefined`.
- Session test: Alice pays; assert Alice receives no `transfer` event for her own command. With a second client (swap the localStorage shim around construction), assert Bob receives exactly one.
- Two concurrent commands from different sessions (queue them with a small artificial delay) → each sender suppresses only its own event.

**Acceptance**

- A player never receives the event for a command they initiated.
- Other players always receive it.
- Concurrent commands cannot cross-suppress.
- No global “current sender” state remains.
---

### P1-8 — Player commands are audited as `actor: 'banker'`

**Problem**

`service.audit` hardcodes `actor: 'banker'` (`src/lib/service.ts:438-449`). Every relayed player transfer and bankruptcy is indistinguishable from a banker action in the audit trail.

**Design**

Thread an actor from the API boundary, never from a client header:

- `localApi` accepts `actor?: string` in `LocalApiOptions`, defaulting to `'banker'`.
- The host passes `actor: 'player:' + record.playerId`.
- Service functions take an optional `actor` argument and forward it to `audit`.
- The actor is a normal audit field, already replicated in `Journal` deltas; no wire-shape change.

**Exact changes**

`src/lib/api.ts`:

```ts
export interface LocalApiOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  actor?: string;
}
```

`route(..., actor)` and pass it to:

- `svc.patchGame(..., actor)`
- `svc.startGame(..., actor)`
- `svc.finishGame(..., actor)`
- `svc.declareBankrupt(..., actor)`
- `svc.startRound(..., idem, actor)`
- `svc.transfer(..., idem, actor)`
- `svc.voidTxn(..., actor)`

`src/lib/service.ts`:

```ts
function audit(
  j: Journal,
  bundle: GameBundle,
  gid: string,
  action: string,
  detail: string,
  actor = 'banker'
): void {
  const row = {
    id: newId('aud'),
    game_id: gid,
    actor,
    action,
    detail: String(detail || ''),
    created_at: nowTs(),
  };
  bundle.audit.push(row);
  j.audit.push(row);
}
```

Update signatures with `actor = 'banker'` as the last parameter to avoid breaking existing callers/tests. `transfer` and `voidTxn` audit with the actor; `startGame`, `finishGame`, `patchGame`, `declareBankrupt`, and `startRound` do the same.

`src/lib/net/hostSession.ts`:

```ts
const result = await localApi(path, {
  method,
  body: msg.body,
  headers: { 'Idempotency-Key': key },
  actor: `player:${record.playerId}`,
});
```

**Tests**

- `src/lib/service.test.ts`: a transfer with `actor: 'player:pl-1'` produces an audit row with that actor.
- `src/lib/net/session.test.ts`: after Alice’s relayed payment, load the host bundle and assert the `transfer` audit row’s `actor === 'player:' + info.playerId`.
- Banker-local actions still default to `'banker'`.
- The mirror receives the audit row in a delta (existing snapshot/delta comparison covers this).

**Acceptance**

- Every audit row identifies the real actor.
- A malicious client cannot choose its own actor string; the host sets it from the verified seat.

---

### P1-9 — `ConnectionPill` latency is set once and never refreshed

**Problem**

`ClientSession` computes latency on every `pong` (`clientSession.ts:285-288`), but `GameContext` only reads `session.latencyMs` in `onStatus('connected')` and `onJoined` (`GameContext.tsx:383-395`). The pill therefore shows the initial value or “Joined · live” forever.

**Design**

Add an `onLatency` handler and call it from the `pong` branch. Keep the existing `latencyMs` getter for diagnostics/tests.

**Exact changes**

`src/lib/net/clientSession.ts`:

```ts
export interface ClientSessionHandlers {
  // ...
  onLatency?: (ms: number) => void;
}
```

```ts
case 'pong': {
  this.lastPongAt = Date.now();
  const ms = Math.max(0, Date.now() - Number(msg.ts || 0));
  this.latency = ms;
  this.handlers.onLatency?.(ms);
  break;
}
```

Also add a public `ping(): void` that sends `{ t: 'ping', ts: Date.now() }`; use it in `startHeartbeat` and tests.

`src/context/GameContext.tsx`:

```ts
onLatency: (ms) => setLatencyMs(ms),
```

Reset `setLatencyMs(0)` when the status becomes `connecting`, `reconnecting`, or `error`.

`ConnectionPill` already handles `latencyMs > 0`; no change needed beyond receiving fresh values.

**Tests**

- In a session test, call `client.ping()`; wait for `onLatency`; assert a finite non-negative value.
- Assert latency is reset to 0 on disconnect (handler behavior).
- Manual: the pill updates every heartbeat (15 s).

**Acceptance**

- The pill reflects a recent RTT, not the join-time value.
- Latency resets when offline.

---

### P1-10 — No cap on unapproved connections

**Problem**

`handleConnection` creates a `PeerRecord` and `ChunkAssembler` for every incoming connection (`hostSession.ts:293-310`). A peer with the room code can open many connections and hold assembler state before the join handshake. `MAX_SEATS` only limits approved players.

**Design**

Add three bounds:

| Limit | Value |
|---|---|
| `MAX_CONNECTIONS` | 32 total |
| `MAX_PENDING_CONNECTIONS` | 8 unaccepted |
| `HELLO_TIMEOUT_MS` | 15 s from connection to `hello` |
| `MAX_INBOUND_MESSAGES_PER_SECOND` | 50 per connection |

- When a cap is hit, send a `join-rejected` reason and close after the flush delay; do not create a record.
- A record that never completes `hello` is closed after 15 s.
- A message flood closes the connection. This is separate from the existing 10 commands/s limit, which only applies after acceptance.

**Exact changes**

`src/lib/net/hostSession.ts`:

```ts
const MAX_CONNECTIONS = 32;
const MAX_PENDING_CONNECTIONS = 8;
const HELLO_TIMEOUT_MS = 15_000;
const MAX_INBOUND_MESSAGES_PER_SECOND = 50;
```

`handleConnection(conn)`:

```ts
if (this.stopped) { conn.close(); return; }

const pending = [...this.connections.values()].filter((r) => !r.accepted && !r.closed).length;
if (this.connections.size >= MAX_CONNECTIONS || pending >= MAX_PENDING_CONNECTIONS) {
  sendMessage(conn, {
    t: 'join-rejected',
    reason: 'The table is busy. Wait a moment and try again.',
  });
  setTimeout(() => conn.close(), 150);
  return;
}
```

Add `inboundTimes: number[]` to `PeerRecord` and an `allowInbound()` check at the top of `handleRaw`; on failure close the connection and return.

Add a hello timer:

```ts
const helloTimer = setTimeout(() => {
  if (!record.helloDone) record.conn.close();
}, HELLO_TIMEOUT_MS);
```

Clear it in `handleHello`/`handleJoinRequest` when `helloDone` flips, and in `dropRecord`.

**Tests**

- Open `MAX_PENDING_CONNECTIONS + 1` raw connections without `hello`; assert the extra one receives `join-rejected` and the host’s `connections` size stays bounded.
- Open a connection and never send `hello`; assert it is closed after the timeout (use a short injected timeout via a new `HostSessionOptions.helloTimeoutMs` test seam, or fake timers).
- Flood 60 messages in one second; assert the connection closes and memory does not grow.
- Existing join/sync tests remain green.

**Acceptance**

- Unapproved connections cannot grow without bound.
- Idle half-open connections are reaped.
- A legitimate join is never blocked by stale pending records beyond the 15 s reap window.

---

## 6. P2 fixes and polish

### P2-1 — `localhost` join links do not work from phones

**Problem**

`buildJoinUrl` uses `window.location.origin` (`hostSession.ts:55-58`). If the host opens the dev app at `http://localhost:3000`, the copied link is unreachable from a phone. `npm run dev` already binds `0.0.0.0`, but the host must open the app via a LAN IP for the link to be useful.

**Design**

- Detect loopback origins (`localhost`, `127.0.0.1`, `[::1]`, `file:`).
- Show a clear warning in `HostSessionPanel` when the generated link is loopback.
- Allow an optional public base URL stored in `localStorage.banker_public_url`. `buildJoinUrl` uses it when present. This covers static hosting behind a Pages URL and dev tunnels.
- Keep the room code path unchanged; users can always type the room code.

**Exact changes**

Extract to `src/lib/net/joinUrl.ts` for testability:

```ts
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    return (
      protocol === 'file:' ||
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

export function buildJoinUrl(room: string, publicBaseUrl?: string): string {
  const clean = sanitizeRoom(room);
  const base = (publicBaseUrl || window.location.origin).replace(/\/$/, '');
  const path = publicBaseUrl ? '/' : window.location.pathname;
  return `${base}${path}?join=${encodeURIComponent(clean)}`;
}
```

- `HostSessionOptions` gains `publicBaseUrl?: string`; `HostSession.joinUrl` uses it.
- `GameContext.startHosting` reads `localStorage.getItem('banker_public_url') || undefined`.
- `HostSessionPanel`: if `isLoopbackOrigin(joinUrl)`, render a warning and an input + Save button for the public URL. Recompute the link on save (restart hosting or pass the value into a new `joinUrl` state).
- README: “For phone testing, open the app on your computer via its LAN IP or set a public base URL.”

**Tests**

- `src/lib/net/joinUrl.test.ts` with a window shim:
  - default origin produces the current URL + `?join=`.
  - loopback detection for `localhost`, `127.0.0.1`, `[::1]`, `file:`.
  - an explicit public base URL wins and does not duplicate the path.
- Manual: set a LAN URL, copy the link, open it on a phone.

**Acceptance**

- The host is warned before sharing an unreachable link.
- A configured public URL produces a shareable link.
- Room-code joining still works without any configuration.

---

### P2-2 — `downloadGameCsv` / backup reachable from a client console

**Problem**

`downloadGameCsv`, `exportBackup`, and `importBackup` are not gated by `gameApi`; only the UI hides them. A client can call them from the console. The mirror contains only the current game, so this is not a ledger confidentiality issue, but backup/restore semantics are banker-only.

**Decision**

Guard at the UI/API facade boundary without creating an `api.ts` ↔ `gameApi.ts` import cycle:

- Keep `downloadGameCsv`/`exportBackup`/`importBackup` as pure local helpers.
- In `BankerConsoleView`/`Header`, the existing `sessionRole === 'client'` checks already hide them; add `aria-disabled`/titles for clarity.
- Add a `assertBankerAction()` helper in `gameApi.ts` and use it in the components that expose these actions, or move the buttons behind `canUseBankerTools` (already done).
- Do **not** import `gameApi` from `api.ts`; the current dependency direction is intentional.

This is a documentation/testing item, not a security boundary. If a true boundary is required later, put it in a role-aware facade module.

**Acceptance**

- No client-visible UI exposes backup/restore/CSV.
- The behavior is documented as “UI-level guard; mirror data is current-game-only.”

---

### P2-3 — Remove unused exports and constants

Confirmed unused by `grep` at plan time:

- `src/lib/net/authz.ts`: `hasCommandHeaderSentinel`
- `src/lib/net/protocol.ts`: `roomPeerIdFor`
- `src/lib/db.ts`: `dumpAll` (use `listDump` for backups) and `activeDbNameValue`
- `src/lib/gameApi.ts`: `getClientSession`, `isClientMode`
- `src/lib/remoteDb.ts`: `resetMirror`

`MAX_MESSAGE_CHARS` is no longer unused: P0-3 uses it for the raw-frame cap.

Actions:

- Delete the dead exports, or use them where appropriate.
- Keep `isClientWritable` (used by `gameApi`).
- Run `npx tsc --noEmit` and a repo-wide `grep` after removal.
- Consider enabling `noUnusedLocals` in `tsconfig` as a follow-up; do not bundle that with this fix because it may surface unrelated warnings.

**Acceptance**

- No dead multiplayer exports remain.
- `tsc`/build stay clean.

---

### P2-4 — Player tokens use `Math.random`

**Problem**

`newPlayerToken` (`hostSession.ts:111-113`), `newClientPeerId`, `newMessageId`, `generateIdemKey`, and the per-connection session id use `Math.random`. Seat credentials should be cryptographically random.

**Design**

Add `src/lib/random.ts`:

```ts
export function randomHex(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}

export function randomId(prefix: string, bytes = 12): string {
  return `${prefix}-${randomHex(bytes)}`;
}
```

Use it for:

- `newPlayerToken()` → `randomId('pt', 16)`
- `newClientPeerId()` → `randomId('pl', 8)` (keep PeerJS-safe characters)
- `newMessageId()` → `randomId('m', 8)`
- host `sessionId` → `randomId('peer', 6)`
- `generateIdemKey(prefix)` → `${prefix}-${Date.now()}-${randomHex(6)}`

`newJoinKey` already uses `crypto.getRandomValues`.

**Tests**

- `src/lib/random.test.ts`: format, length, distinct across 1000 calls, only URL/PeerJS-safe characters.
- No use of `Math.random` remains in `src/lib/net` credential/id paths (grep gate).

**Acceptance**

- Seat credentials are 128-bit random.
- Existing tests that only require uniqueness still pass.

---

### P2-5 — Missing regression tests

Add or extend:

| Test file | Coverage |
|---|---|
| `src/lib/idempotency.test.ts` | replay, conflict, status-after-finish replay |
| `src/lib/transferIntent.test.ts` | stable key, fingerprint boundaries |
| `src/lib/net/codec.test.ts` | chunk caps, invalid base64, fuzz |
| `src/lib/net/timeout.test.ts` | timeout primitive |
| `src/lib/net/session.test.ts` | pre-approval privacy, lost join-accepted, active-game rejoin, double approve, kick revocation, host-bye terminal/silent, player leave, join timeout, snapshot failure, delta resync, event origin, audit actor |
| `src/lib/net/hostCredentials.test.ts` | IndexedDB round-trip, legacy migration, fallback |
| `src/lib/net/joinUrl.test.ts` | loopback detection, public base override |
| `src/lib/random.test.ts` | randomness format |

Consider a small `src/lib/net/testHub.ts` extracted from `session.test.ts` if the fake transport is reused by the new tests; otherwise keep the helpers local to avoid changing production code for tests.

**Acceptance**

- Every P0/P1 acceptance criterion above maps to at least one automated test or a named manual step.
- `npm test` remains the single command; the existing glob picks up all new `src/lib/**/*.test.ts` files.

---

### P2-6 — README host-reload claim needs real PeerJS verification

**Problem**

README says reloading the banker page resumes hosting with the same room code. PeerJS Cloud may hold the previous peer id briefly (`unavailable-id`), and the retry window is the risky part. This has not been verified against the real service.

**Actions**

1. Run the manual matrix in §9 on real PeerJS Cloud (not the fake transport).
2. If reload reclaims the room within the retry window, keep the claim and add “give it a few seconds.”
3. If it is flaky, change the README to “retry/reopen hosting if the room is still held,” and add a visible “Reclaiming room…” state in `HostSessionPanel` while `createPeerTransport` retries `unavailable-id`.
4. Document the protocol v2 reload requirement.
5. Add a troubleshooting section: signaling offline, mixed app versions, localhost join links, host tab asleep.

**Acceptance**

- README statements match observed behavior.
- The host UI never looks frozen while PeerJS retries.
<!-- PART-END -->
