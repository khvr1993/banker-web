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

## Development

```bash
npm install
npm run dev
```

The app will start on `http://localhost:3000`.

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
