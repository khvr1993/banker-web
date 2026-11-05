# Business Game Banker — WebRTC Multiplayer Plan (PeerJS)

## 1. Goal

Let multiple devices share one live game session:

- One player is the **host / banker** and owns the authoritative game state.
- Other players join from their phones via a room link/code.
- Every banking action (salary, rent, transfer, void, bankruptcy, round advance) is visible on all connected devices within ~1 second.
- Phones can rejoin after refresh or a dropped connection without losing their seat.
- The existing offline/local mode keeps working unchanged.

Example flows:

- Bank pays Player A 2,500 → all devices show the new balance.
- Player A pays rent to Player B → all devices show the transfer and updated balances.
- Banker voids a transaction → all passbooks show it as voided.

## 2. Chosen Approach

**Host-authoritative star topology over WebRTC data channels, signaled by PeerJS Cloud.**

```
Player A ──DataChannel──┐
Player B ──DataChannel──┼── Host (banker) ── IndexedDB (source of truth)
Player C ──DataChannel──┘
        commands ↑        deltas ↓
```

Decisions:

- The host is the **only writer**. Players never write their own IndexedDB as truth.
- Players keep a disposable **mirror database** so existing read code keeps working.
- Host broadcasts the existing `Journal` shape as a delta after each successful commit.
- New/reconnecting clients receive a full snapshot.
- PeerJS Cloud handles SDP/ICE exchange only. Ledger data stays peer-to-peer.
- No CRDT/Yjs, no mesh, no peer-to-peer database sync.

### Why this fits the repo

| Existing building block | How it is reused |
|---|---|
| `localApi()` in `src/lib/api.ts` | Single mutation seam; host uses it unchanged |
| `Journal` in `src/lib/db.ts` | Already a replication delta (`games/players/txns/rounds/audit/deletedPlayers`) |
| `commit()` in `src/lib/db.ts` | Add a post-commit listener to broadcast |
| `Game.join_token` in `src/types/index.ts` | Room code (already generated, currently unused) |
| Ledger idempotency keys in `src/lib/ledger.ts` | Safe retries over an unreliable channel |
| Immutable transactions | Deltas are append/upsert-only; simple to apply |
| `statement()` / `gameView()` / `bankInfo()` | Work unchanged against the mirror |

`src/lib/ledger.ts`, `src/lib/domain.ts`, and the money model **do not change**.

## 3. PeerJS Configuration

- Dependency: `peerjs` (latest 1.x).
- Host peer ID: `bgb-v1-<join_token sanitized>` (e.g. `bgb-v1-join-a1b2c3`). Allow only `[A-Za-z0-9_-]`.
- Player peer IDs: random (`pl-<random>`), created per connection attempt.
- `serialization: 'json'` for debuggable messages.
- Reliable, ordered data channel (PeerJS default).
- Call `peer.reconnect()` on `disconnected`; recreate the peer on fatal errors.
- Handle PeerJS error types explicitly:
  - `peer-unavailable` → host not online yet; keep retrying.
  - `unavailable-id` → stale host registration after reload; retry same ID with backoff.
  - `network` / `server-error` → reconnect with exponential backoff.
  - `browser-incompatible` → show a clear message.
- ICE: PeerJS/Google STUN by default. Document that guest Wi-Fi with AP isolation will fail; allow an optional TURN server via config.
- No app-level server is required. Deploy stays on GitHub Pages.
- Feature-flag/fallback: keep local mode default; networking only activates via Host/Join UI.

## 4. Protocol

Versioned at `protocol: 1`. All messages are JSON objects with a `t` discriminator.

### Client → Host

```ts
{ t: 'hello'; protocol: 1; room: string; playerToken?: string; playerId?: string }
{ t: 'join-request'; name: string; playerToken?: string; playerId?: string }
{ t: 'cmd'; id: string; path: string; method: string; body?: unknown; headers?: Record<string,string> }
{ t: 'ping'; ts: number }
{ t: 'bye' }
```

### Host → Client

```ts
{ t: 'welcome'; protocol: 1; room: string; snapshot: Dump }          // pre-join state
{ t: 'join-pending' }                                                 // awaiting host approval
{ t: 'join-rejected'; reason: string }
{ t: 'join-accepted'; playerId: string; playerToken: string; snapshot: Dump }
{ t: 'snapshot'; rev: number; data: Dump }                            // full resync / gap
{ t: 'delta'; rev: number; journal: SerializedJournal }               // incremental
{ t: 'ack'; id: string; result: unknown }
{ t: 'nack'; id: string; error: { status: number; type: string; message: string } }
{ t: 'event'; event: { kind: 'transfer' | 'round' | 'void'; ... } }   // toasts/sounds
{ t: 'pong'; ts: number }
{ t: 'host-bye'; reason: string }
```

- `rev` is an in-memory monotonically increasing integer on the host. It does **not** need persistence.
- On any join/reconnect the host sends a full snapshot. No persistent delta log or DB schema change is required.
- Every command carries a client-generated `id`; host acks/nacks it. Retries reuse the same id and ledger idempotency key.
- Large payloads (snapshot) are chunked at the app layer (~12 KB per chunk) with a reassembly timeout. Deltas are normally far below the limit, but the chunker is shared.

### Command → existing API mapping

Commands use the **existing REST-like paths** so no service-layer changes are needed:

| UI action | Command |
|---|---|
| Banker transfer | `POST /games/:gid/transfers` |
| Start round | `POST /games/:gid/rounds` |
| Void | `POST /games/:gid/transfers/:tid/void` |
| Bankruptcy | `POST /games/:gid/players/:pid/bankrupt` |
| Patch salary | `PATCH /games/:gid` |
| Start/finish game | `POST /games/:gid/start` / `finish` |
| Seat player | `POST /games/:gid/players` |
| Player rent payment | `POST /games/:gid/transfers` with `from.id === actor.playerId` |

## 5. Host Session

### 5.1 Identity and join flow

1. Host opens **Host Session** in the lobby; `join_token` is reused or regenerated.
2. Host creates a Peer with the derived ID and shows:
   - room code,
   - join URL `https://<pages-url>/?join=<token>`,
   - optional QR of that URL (share-link QR only, not SDP).
3. Player opens the URL, enters a name, sends `join-request`.
4. Host shows an **Allow / Deny** prompt with the player name and device info.
5. On approval:
   - Pending game: host seats the player (`addPlayer`) and replies `join-accepted { playerId, playerToken, snapshot }`.
   - Active game: accept only if `playerId` + `playerToken` match an existing player (rejoin). Otherwise reject with "game already started".
6. Player stores `playerToken`/`playerId` in `localStorage` keyed by room.
7. Host enforces **one live connection per player**. A newer connection replaces the old one (old one gets `host-bye`).

Host-side token map: `banker_tokens_<gameId>` in host `localStorage` (playerId → token). This is not security-critical, just reconnect convenience.

### 5.2 Authorization matrix

| Command | Banker session | Player session |
|---|---|---|
| Transfer | any from/to | only `from.type === 'player' && from.id === myPlayerId` |
| Start round / round payout | yes | no |
| Void | yes | no |
| Bankruptcy | yes | no |
| Patch salary | yes | no |
| Start/finish game | yes | no |
| Seat/remove player | yes | no |
| Reads (`GET`) | local mirror/DB | local mirror |

Additional host checks:

- `gid` must equal the active hosted game.
- Every command is validated by the existing service/domain layer on the host. Clients never compute authoritative balances.
- Rate-limit commands per connection (e.g. 10/s) and cap message size.
- Reject commands from a connection that has not completed the join handshake.

### 5.3 Post-commit broadcast

Add a listener hook to `src/lib/db.ts`:

```ts
type CommitListener = (j: Journal) => void;
let commitListener: CommitListener | null = null;
export function setCommitListener(fn: CommitListener | null) { commitListener = fn; }

// inside commit(), after tx.oncomplete succeeds:
commitListener?.(j);
```

- The host sets the listener only while hosting.
- On each callback: `rev++`, serialize `j`, broadcast `{ t: 'delta', rev, journal }` to all accepted clients.
- The listener must fire **after** the IndexedDB transaction succeeds, never before.
- Clients never set this listener; they only apply incoming deltas.

## 6. Client Mirror

### 6.1 Storage

- New DB name: `banker_mirror_db`, same five stores and indexes as `banker_db`.
- Refactor `src/lib/db.ts` minimally:
  - `openDb(name = DB_NAME)`, with a cached per-name promise.
  - `configureStorage({ dbName })` used at boot before any read.
  - `applySnapshot(dump)`: clear + write all stores (reuse the `restoreFromDump` mechanics).
  - `applyDelta(j)`: upsert `games/players/txns/rounds/audit`, apply `deletedPlayers`.
  - Both operations run in one readwrite transaction and are idempotent.
- On client boot with `?join=`, configure the mirror DB **before** `GameContext` loads the game.
- The mirror is disposable: cleared on join and on full resync.
- The host keeps using `banker_db`; local mode is untouched.

### 6.2 Read path

- After applying a delta/snapshot, the client calls the existing `refreshActiveGame()`.
- `refreshActiveGame()` reads via `localApi` from the mirror and updates React state. No view changes required.
- Keep a slow fallback poll (10 s) on clients to repair any missed delta.

## 7. API Facade

Add `src/lib/gameApi.ts` with the same signature as `localApi`:

```ts
export async function gameApi(path: string, options: LocalApiOptions = {}): Promise<any>
```

Behavior:

- Local/host mode → delegate to `localApi`.
- Client mode:
  - `GET` → delegate to `localApi` (mirror).
  - write → `clientSession.command(path, options)`, which sends `cmd`, waits for `ack`, and rejects on `nack`.
- Client mode guards:
  - reject/disable game creation, backup/restore, CSV export, and games list switching (host-only).
  - hide/disable banker-only UI.

Replace imports of `localApi` with `gameApi` in call sites:

- `src/components/LobbyView.tsx` (add/remove/start)
- `src/components/TransferCard.tsx` (transfer)
- `src/components/BankerConsoleView.tsx` (finish, CSV)
- `src/components/PlayerView.tsx` (statement read)
- `src/components/modals/NewGameModal.tsx`
- `src/components/modals/GamesListModal.tsx`
- `src/components/modals/PatchSalaryModal.tsx`
- `src/components/modals/ConfirmBankruptModal.tsx`
- `src/components/modals/ConfirmVoidModal.tsx`
- `src/components/modals/PlayerStatementModal.tsx`
- `src/components/modals/BankInfoModal.tsx`
- `src/context/GameContext.tsx` (reads/load)

## 8. Context and State

Extend `src/context/GameContext.tsx`:

```ts
type SessionRole = 'local' | 'host' | 'client';
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

sessionRole: SessionRole;
connectionState: ConnectionState;
roomCode: string | null;
joinUrl: string | null;
hostRev: number;
remotePeers: RemotePeerInfo[];   // name, playerId, connected
hostOnline: boolean;

startHosting(): Promise<void>;
stopHosting(): void;
joinSession(roomCode: string, name: string): Promise<void>;
leaveSession(): void;
approveJoin(sessionId: string): Promise<void>;
denyJoin(sessionId: string): void;
kickPeer(sessionId: string): void;
```

Boot logic:

- Parse `?join=<token>` **before** the existing "load last game" logic.
  - If present: enter client mode, initialize mirror DB, connect, show `JoinSessionView`.
  - If absent: keep existing local boot behavior.
- `setAppMode` in client mode is forced to `player`; hide the Banker/Player switch.
- `myPlayerId` comes from `join-accepted`, not the seat picker.
- Remove the "Switch Player" button in networked player mode.
- Keep the 2.5 s poll for local/host; on clients, replace with delta-driven refresh + 10 s fallback.

## 9. UI Changes

### New components

- `src/components/HostSessionPanel.tsx`
  - Start hosting, show room code + copy link + optional QR.
  - Pending join requests with Allow/Deny.
  - Connected peers with connection status and Kick.
- `src/components/JoinSessionView.tsx`
  - Room code, name input, Connect/Retry, status messages, host-offline banner.

### Existing components

- `LobbyView.tsx`: "Host Online Session" button; show join requests alongside seated players; seat players on approval.
- `Header.tsx`: connection pill (`Hosting · 3`, `Joined · live`, `Reconnecting…`); hide mode switch for clients; hide Games/New for clients.
- `PlayerView.tsx`: remove seat switching in networked mode; connection/latency indicator; statement still works from mirror.
- `TransferCard.tsx`: in client mode force `from` to the current player and hide the payer selector.
- `BankerConsoleView.tsx`: hide on client sessions (clients always render `PlayerView`).
- `style.css`: connection pill, join screen, QR panel, reconnecting/host-offline banners. Reuse existing card/banner styles.

### Optional

- `qrcode` package for a scan-to-join QR of the room URL. Code + copy-link is sufficient for v1.
- Wake Lock API + "keep this tab open" warning on the host.
- Toast/sound events on remote transfers (`event` messages).

## 10. File Map

### New files

| File | Purpose | Est. LOC |
|---|---|---|
| `src/lib/net/protocol.ts` | Message types, chunking, validation, version constants | ~170 |
| `src/lib/net/peerTransport.ts` | PeerJS wrapper, peer creation, retry/backoff, heartbeat, event emitters | ~220 |
| `src/lib/net/codec.ts` | JSON serialize, chunk/reassemble, size guards | ~90 |
| `src/lib/net/hostSession.ts` | Join approval, peer registry, command auth, broadcast, rev | ~280 |
| `src/lib/net/clientSession.ts` | Connect, join, command ack/retry, delta apply, reconnect | ~230 |
| `src/lib/net/peerFactory.ts` | Injectable factory so tests can use a fake transport | ~40 |
| `src/lib/gameApi.ts` | `localApi`-compatible facade (local vs client) | ~80 |
| `src/lib/remoteDb.ts` | Mirror DB open/applySnapshot/applyDelta (or extend `db.ts`) | ~140 |
| `src/components/HostSessionPanel.tsx` | Host UI | ~180 |
| `src/components/JoinSessionView.tsx` | Join UI | ~150 |
| `src/components/ConnectionPill.tsx` | Header status | ~50 |

### Modified files

| File | Change |
|---|---|
| `src/lib/db.ts` | Commit listener; DB name parameterization; mirror apply helpers |
| `src/context/GameContext.tsx` | Session state, boot branch, delta subscription, host/join actions |
| `src/App.tsx` | Render `JoinSessionView` when in client-join state |
| `src/components/LobbyView.tsx` | Host panel, approval flow, hide manual seating for clients |
| `src/components/Header.tsx` | Connection pill, role-based actions |
| `src/components/PlayerView.tsx` | Bound identity, reconnecting banner |
| `src/components/TransferCard.tsx` | Forced payer in client mode |
| `src/components/modals/*.tsx` | `gameApi` facade; hide host-only modals on clients |
| `src/style.css` | Session/connection UI |
| `package.json` | `peerjs`, optional `qrcode`; test script |
| `README.md` | Multiplayer setup and caveats |

**Estimated new/modified code: ~1,300–1,800 lines across ~15 existing files.**

## 11. Phases and Milestones

### Phase 0 — De-risking spike (0.5–1 day)

- Add `peerjs`; connect two tabs on one machine.
- Open one data channel; send a `hello` and a small JSON payload.
- Verify: refresh, close/reopen host, `peer-unavailable`, and reconnection behavior.
- **Gate:** PeerJS Cloud works reliably from the GitHub Pages origin.

### Phase 1 — Read-only multiplayer MVP (2–4 days)

- Protocol, chunker, PeerJS transport, host/client sessions.
- Commit listener + delta broadcast + full snapshot on join.
- Mirror DB + `gameApi` read path.
- Host/Join UI with approval; connection pill; player rejoin.
- Client shows live balances, roster, passbook, rounds.
- Banker actions sync to all players.
- **Deliverable:** your core requirement — all transactions visible on every device.

### Phase 2 — Player-initiated payments (1–2 days)

- Player command path with actor identity.
- Force transfer `from` to the session player; host authz matrix.
- Ack/nack + idempotent retries + error toasts.
- Host can kick; duplicate-seat handling.

### Phase 3 — Hardening and polish (3–5 days)

- Heartbeat, exponential backoff, `rev` gap → full resync.
- Snapshot chunking limits and reassembly timeout.
- Wake Lock + host-background warning.
- QR join URL, sound/toast events.
- Unit + integration tests; multi-device manual QA.
- README and troubleshooting.

**Total: ~1.5–2 weeks solo.** Phase 1 alone delivers the stated goal in ~3–5 days.

## 12. Testing

### Unit

- Protocol serialization/deserialization and version mismatch.
- Chunk/reassemble: exact, out-of-order, missing chunk timeout, oversized payload.
- `applyDelta`: upserts, deletes, idempotent replay, void updates.
- Authz matrix: every command × banker/player × owned/foreign player.
- Idempotent command retry returns the same result.

Test runner: existing tests use `node:test` with `.ts`. Add `tsx` as a dev dependency and `"test": "tsx --test src/lib/*.test.ts"` (or migrate to Vitest). Use `fake-indexeddb` for DB tests.

### Integration / E2E

- Transport is injected via `peerFactory`, so tests can use an in-memory fake (no PeerJS Cloud in CI).
- Playwright with two browser contexts:
  - host starts session → player joins → banker transfer → both see it.
  - player refreshes → rejoins same seat with same balance.
  - host reloads → player sees reconnecting → resync.
  - player tries a banker-only command → rejected.
- Manual matrix on target devices:
  - host laptop + 3 phones, same Wi-Fi.
  - host behind captive/guest Wi-Fi (document failure + TURN).
  - iOS Safari background/foreground.
  - duplicate tab claiming the same player.
  - denied join request.

## 13. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| PeerJS public broker outage/limits | Transport abstraction; retry/backoff; option to self-host PeerServer or swap signaling later |
| Large snapshot exceeding a data-channel message | App-level chunking (~12 KB), reassembly timeout, full resync fallback |
| Host tab sleeps/suspends (especially mobile) | Wake Lock, visible warning, recommend host on laptop; clients show reconnecting |
| Host closes tab | State is safe in host IndexedDB; restart host with the same room code; players auto-reconnect |
| Peer ID conflict after host reload | Retry `unavailable-id` with backoff; keep the same derived ID |
| AP isolation / guest Wi-Fi blocks P2P | Document; optional TURN config; no guarantee on public Wi-Fi |
| Client mirror and local DB mixing | Separate `banker_mirror_db`; configure at boot before reads |
| Player cheating / spoofing another seat | Host validates actor on every command; one live session per player; host approval |
| Join code leaked | Host approval prompt; kick; code is bearer secret |
| No internet during game night | App still loads from GitHub Pages (needs internet) unless PWA caching is added; PeerJS signaling needs internet |
| Duplicate/out-of-order deltas | Monotonic `rev`; ignore stale; full snapshot on gap |
| Toast/sound storms from deltas | Derive only new txns since previous state; throttle |

## 14. Acceptance Criteria

- [ ] Local/offline mode behaves exactly as today when not hosting or joining.
- [ ] Host starts a session and 1–6 players join via link/code with host approval.
- [ ] A banker transfer appears on every connected device in <1 s.
- [ ] Round salary, void, bankruptcy, and finish all propagate.
- [ ] Player passbooks and balances match the host ledger.
- [ ] A player can refresh and rejoin the same seat automatically.
- [ ] Host reload → clients show reconnecting → auto-resync.
- [ ] Player sessions cannot execute banker-only commands (UI hidden + host rejects).
- [ ] Player payments are only allowed from their own seat.
- [ ] Retried commands never double-post.
- [ ] `npm run build` and `npx tsc --noEmit` pass.
- [ ] No changes to ledger/domain semantics.

## 15. Explicit Non-Goals (v1)

- No CRDT or offline concurrent editing.
- No multi-banker support.
- No persistent delta log or server-side history.
- No anti-cheat beyond host authority.
- No late join after game start except reconnecting an existing seat.
- No automatic discovery without PeerJS signaling.
- No TURN relay service bundled (documented as optional).

## 16. Open Decisions

1. Late join mid-game: spectator-only, or host-approved seat + starting cash? (Recommend: rejoin only in v1.)
2. Player payments in v1 or Phase 2? (Recommend Phase 2.)
3. QR for join URL in v1 or later? (Recommend later; code + copy link first.)
4. Whether to add PWA/service-worker caching for no-internet nights. (Out of scope unless required.)
