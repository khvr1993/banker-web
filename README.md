# Business Game Banker

Browser-only version of the **Banker** companion app for the Business board game.
It runs entirely on static hosting (GitHub Pages): no server, no account, no build step.
All money movements are kept in a **double-entry ledger** inside your browser's storage.

- **Hosted:** https://khvr1993.github.io/banker-web/
- **Works offline:** after the first visit, the whole app loads from a service worker cache —
  fine even with airplane mode at the table.
- **Data lives on this device** (IndexedDB) per browser profile. It is **not** shared between
  devices — use one device as the banker console.

## Backup & Restore (important)

The app has **Backup** (top bar) → *Download Backup (.json)* / *Restore from backup file*.

- Download a backup before clearing browser data, switching phones/laptops, or resetting a
  browser. Restoring **replaces** everything in the app.
- A backup from one device can be copied to another to migrate your games.

## Run locally

Any static file server works — the app has zero dependencies and no build step:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly via `file://` shows the app shell, but the service worker will
not register — serving the folder is required.)

## Deploy (GitHub Pages)

Every push to `main` deploys automatically via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) (GitHub's official Pages actions).
One-time setup: repo **Settings → Pages → Source: GitHub Actions**.

## Layout

```
index.html / style.css / app.js / sw.js   the app (no build step)
js/                     the engine (port of the Go backend)
  domain.js             entities, categories, ID + error taxonomy
  db.js                 IndexedDB persistence + atomic journal commits
  ledger.js             double-entry posting engine
  service.js            games/players/rounds/transfers/bankruptcy flows
  api.js                local implementation of the /api/v1 contract + CSV export + backup
```

## Money model

Identical semantics to the Go implementation: integer rupees only; each money movement posts
exactly one DR and one CR line; balances are `SUM(CR) − SUM(DR)` per account; corrections are
`VOID` reversals (ledger rows are never deleted); rounds and transfers are replay-safe via
idempotency keys; and every mutation commits atomically (all-or-nothing).

Valid transfer categories: `STARTING_CASH, ROUND_COMPLETE, SALARY, INCOME_TAX, RENT, MORTGAGE,
MORTGAGE_REDEEM, EXPENSE, INCOME, GIFT, LOAN, LOAN_REPAYMENT, PROPERTY_PURCHASE, PROPERTY_SALE,
BUILD, FINE, TRANSFER, OTHERS`

Adding a feature? Re-verify parity against the Go implementation before merging.
