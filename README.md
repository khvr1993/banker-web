# Business Game Banker

Modern React application rewritten from the original Business Game Banker companion app for board games (e.g. Monopoly / Business).
All money movements are kept in a **double-entry ledger** inside your browser's IndexedDB storage.

- **Banker Console:** Full game master view with seated player wallets, bank float drawer health, fast transfer center, round salary distribution, player bankruptcy settlement, and reversible transaction audit trail.
- **Player View:** Personalized participant interface with hero wallet card, table leaderboard rankings, direct one-tap rent payments, and personal passbook statement.
- **Double-Entry Integrity:** Money conservation with debit/credit entries, idempotent round/transfer execution, and compensating reversal voids.
- **Backup & Restore:** Full browser database export and import as portable JSON files, plus audit log ledger CSV download.
- **Web Audio Cues:** Synthesized audio effects for coins, round bell chords, and void reversals.

## Tech Stack

- **React 18** with functional components, hooks, and Context API.
- **TypeScript** with strict domain types and data models.
- **Vite** for fast modern bundling and development on port 3000.
- **IndexedDB** with journal commit semantics for zero-data-loss local persistence.

## Multiplayer (WebRTC)

Play on multiple phones while one device stays the banker. The banker device owns the only
writable ledger; players receive a disposable mirror database and live deltas. Sessions use
**protocol v2**; the host peer id is `bgb-v2-<room>`.

1. Open a game on the banker device and click **Host Online Session** (in the lobby or console).
2. Share the room code or the `?join=…` link with players.
3. Each player opens the link, enters a name, and waits for the banker to tap **Allow**.
4. Every transfer, void, bankruptcy, and round payout appears on all connected devices.

Notes and caveats:

- Signaling uses PeerJS Cloud; ledger data stays peer-to-peer. Signaling needs internet access.
- **After updating the app, reload both the banker and every player tab.** A tab running the old
  protocol is rejected with “This device and the host are running different app versions”; it
  cannot sync, but no data is corrupted.
- Keep the banker tab open and awake. Reloading the banker page resumes hosting with the same
  room code after signaling reclaims it — give it a few seconds. If the host card stays on
  **Starting… / Reclaiming room…**, wait for the old peer id to be released, or stop and reopen
  hosting. Players show `Reconnecting…` and resync automatically without duplicate transactions.
- Players can refresh or reopen the link to rejoin the same seat. Each device keeps a random
  128-bit `joinKey` in `localStorage`; the host durably reserves seats in IndexedDB, so a lost
  join acknowledgment or a reload recovers the seat without banker approval.
- A banker can **Kick** a device. Kicking revokes its key, so the player must be approved again.
- Only reconnecting an existing seat is supported after the game starts. Seat players before starting.
  If a device loses its key (for example a closed private window or cleared browser storage), the
  player re-enters the **same display name** and the request appears in Hosted Session; the banker
  can **Allow** it to re-admit that existing seat without creating a new player.
- Players can use **Leave** in the header to leave the session without signing out of the device.
- Players only see the hosted game's mirror (`banker_mirror_db`), never the banker's full ledger.
  Backup/restore and CSV export are banker-only UI actions (a UI guard; the mirror is
  current-game-only).
- Guest Wi-Fi with AP/client isolation blocks peer-to-peer WebRTC. Use a shared hotspot or provide a TURN server by setting `banker_ice_servers` in `localStorage` to a JSON array of `RTCIceServer` objects, e.g.
  `[{"urls":"turn:turn.example.com:3478","username":"user","credential":"secret"}]`.
- Player devices never write local/host data: they use the `banker_mirror_db` IndexedDB database. Opening the app without `?join` keeps the original offline mode.

### Phone testing and join links

A `localhost` / `127.0.0.1` / `file:` join link only works on the banker machine. For phones,
open the app on your computer via its LAN IP (for example `http://192.168.1.20:3000`) or set a
**Public base URL** in the Hosted Session card. The host UI warns when the copied link is
loopback. Joining by room code always works without any configuration.

### Troubleshooting

- **Stuck on “Connecting…”** — signaling is unreachable, the room code is wrong, or guest Wi-Fi
  blocks WebRTC. The join times out after 15 seconds with a visible error; check the internet
  connection and the room code. If the join was already approved, a blocked local database also
  times out with a storage error after 20 seconds; private browsing may block IndexedDB, so open a
  normal window or free up space.
- **Rejoining from a private window** — Safari private windows discard `localStorage` when they
  close, so the seat key is gone. Enter the same name and ask the banker to **Allow** the reconnect.
- **“Different app versions”** — one tab is stale. Reload both the banker and the player tab.
- **A join link works on the banker but not on a phone** — the link points at loopback. Use the
  LAN IP or a public base URL.
- **Players keep showing “Reconnecting…”** — the banker tab is asleep, closed, or offline. Keep
  it awake and reload it; the host resumes the room and players resync.
- **The host card is stuck on “Starting… / Reclaiming room…”** — PeerJS may still hold the old
  peer id briefly after a reload. Wait a few seconds; if it persists, stop and reopen hosting.
- **“This game has already started”** — a brand-new name cannot join an active game. If you were
  seated before, use the same display name; the banker can Allow the reconnect request. Otherwise
  create a new game and seat everyone before starting.

## Development

```bash
npm install
npm run dev
```

The app will start on `http://localhost:3000`.

### Tests

```bash
npm test        # node:test via tsx (protocol, codec, authz, credentials, session sync, resync)
npx tsc --noEmit
npm run build
```

## Build

```bash
npm run build
```

## Money Model

- Integer currency units only.
- Each money movement posts exactly one DR and one CR line.
- Balances are computed as `SUM(CR) - SUM(DR)` per account.
- Corrections post compensating `VOID` entries (ledger records are immutable).
- Supported categories: `STARTING_CASH, ROUND_COMPLETE, SALARY, INCOME_TAX, RENT, MORTGAGE, MORTGAGE_REDEEM, EXPENSE, INCOME, GIFT, LOAN, LOAN_REPAYMENT, PROPERTY_PURCHASE, PROPERTY_SALE, BUILD, FINE, TRANSFER, OTHERS`.
