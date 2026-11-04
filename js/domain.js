// Domain layer — entities, categories, validation, error taxonomy.
// Port of internal/domain/*.go (IDs, account validation, RFC-7807 errors).

// ---- Account types ----

export const ACCOUNT = {
  BANK: "bank",
  PLAYER: "player",
  EQUITY: "equity", // virtual source for the bank float
};

export const Dr = "DR";
export const Cr = "CR";

export const GAME_STATUS = {
  PENDING: "pending",
  ACTIVE: "active",
  FINISHED: "finished",
  ABORTED: "aborted",
};

export const ACCOUNT_CATEGORIES = [
  "STARTING_CASH", "ROUND_COMPLETE", "SALARY", "INCOME_TAX", "RENT",
  "MORTGAGE", "MORTGAGE_REDEEM", "EXPENSE", "INCOME", "GIFT",
  "LOAN", "LOAN_REPAYMENT", "PROPERTY_PURCHASE", "PROPERTY_SALE",
  "BUILD", "FINE", "TRANSFER", "OTHERS",
];

const CATEGORY_SET = new Set([...ACCOUNT_CATEGORIES, "OPENING_BALANCE"]);

export function validCategory(c) {
  return CATEGORY_SET.has(c);
}

// ---- Accounts ----

export function accountKey(acc) {
  if (acc.type === ACCOUNT.BANK) return "BANK";
  return acc.id;
}

export function validateAccount(acc, prefix = "") {
  const tag = prefix ? prefix : "account";
  if (!acc || typeof acc !== "object") {
    throw fail("INVALID", `${tag} is required`);
  }
  switch (acc.type) {
    case ACCOUNT.BANK:
      return;
    case ACCOUNT.EQUITY:
      if (!String(acc.id ?? "").trim()) throw fail("INVALID", `${tag}: equity account GAME_EQUITY`);
      return;
    case ACCOUNT.PLAYER:
      if (!String(acc.id ?? "").trim()) throw fail("INVALID", `${tag}: player account requires id`);
      return;
    default:
      throw fail("INVALID", `${tag}: unknown account type ${acc.type}`);
  }
}

export function transferValidate(t) {
  if (!Number.isInteger(t.amount) || t.amount <= 0) {
    throw fail("INVALID", "amount must be > 0");
  }
  if (!validCategory(t.category)) {
    throw fail("INVALID", `unknown account_category ${t.category}`);
  }
  const same =
    t.from.type === t.to.type && accountKey(t.from) === accountKey(t.to);
  if (same) throw fail("INVALID", "from and to must be different accounts");
  validateAccount(t.from, "from");
  validateAccount(t.to, "to");
  if (t.from.type === ACCOUNT.EQUITY || t.to.type === ACCOUNT.EQUITY) {
    throw fail("INVALID", "equity accounts cannot be used in transfers");
  }
}

// ---- Errors (RFC 7807-ish; UI reads .kind/.status/.message) ----

export class DomainError extends Error {
  constructor(kind, detail) {
    super(detail);
    this.name = "DomainError";
    this.kind = kind; // NOT_FOUND | INVALID | INSUFFICIENT_BALANCE | BANK_INSOLVENT | INVALID_STATE | INTERNAL
    this.detail = detail;
  }
}

export function fail(kind, detail) {
  return new DomainError(kind, detail);
}

export function errorStatus(kind) {
  switch (kind) {
    case "NOT_FOUND": return 404;
    case "INVALID": return 400;
    case "INSUFFICIENT_BALANCE": return 400;
    case "BANK_INSOLVENT": return 400;
    case "INVALID_STATE": return 409;
    case "IDEMPOTENT_REPLAY": return 409;
    default: return 500;
  }
}

export function isDomainError(e) {
  return e instanceof DomainError;
}

// ---- IDs ----

// Mirrors Go: time-ordered prefix + 16 random hex chars.
export function newId(prefix) {
  const d = new Date();
  const p =
    String(d.getUTCFullYear()).slice(-2) +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0") +
    String(d.getUTCHours()).padStart(2, "0") +
    String(d.getUTCMinutes()).padStart(2, "0") +
    "-" +
    String(d.getUTCSeconds()).padStart(2, "0");
  const rand = crypto.getRandomValues(new Uint8Array(8));
  let hex = "";
  for (const b of rand) hex += b.toString(16).padStart(2, "0");
  return `${prefix}-${p}-${hex}`;
}

// ---- Timestamps (canonical UTC "YYYY-MM-DDTHH:MM:SS", lexicographically sortable) ----

const pad = (n) => String(n).padStart(2, "0");

export function formatTimestamp(d) {
  const t = d instanceof Date ? d : new Date(d);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
  );
}

export function nowTs() {
  return formatTimestamp(new Date());
}
