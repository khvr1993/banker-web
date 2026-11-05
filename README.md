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
writable ledger; players receive a disposable mirror database and live deltas.

1. Open a game on the banker device and click **Host Online Session** (in the lobby or console).
2. Share the room code or the `?join=…` link with players.
3. Each player opens the link, enters a name, and waits for the banker to tap **Allow**.
4. Every transfer, void, bankruptcy, and round payout appears on all connected devices.

Notes and caveats:

- Signaling uses PeerJS Cloud; ledger data stays peer-to-peer. Signaling needs internet access.
- Keep the banker tab open and awake. Reloading the banker page resumes hosting with the same room code; players reconnect automatically.
- Players can refresh or reopen the link to rejoin the same seat (credentials are stored in `localStorage`).
- Only reconnecting an existing seat is supported after the game starts. Seat players before starting.
- Guest Wi-Fi with AP/client isolation blocks peer-to-peer WebRTC. Use a shared hotspot or provide a TURN server by setting `banker_ice_servers` in `localStorage` to a JSON array of `RTCIceServer` objects, e.g.
  `[{"urls":"turn:turn.example.com:3478","username":"user","credential":"secret"}]`.
- Player devices never write local/host data: they use the `banker_mirror_db` IndexedDB database. Opening the app without `?join` keeps the original offline mode.

## Development

```bash
npm install
npm run dev
```

The app will start on `http://localhost:3000`.

### Tests

```bash
npm test        # node:test via tsx (protocol, codec, authz, mirror storage, session sync)
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
