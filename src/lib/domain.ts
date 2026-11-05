// Domain layer — entities, categories, validation, error taxonomy.
import { Account, AccountType, GameStatus } from '../types';

export const ACCOUNT: Record<string, AccountType> = {
  BANK: 'bank',
  PLAYER: 'player',
  EQUITY: 'equity',
};

export const Dr = 'DR' as const;
export const Cr = 'CR' as const;

export const GAME_STATUS: Record<string, GameStatus> = {
  PENDING: 'pending',
  ACTIVE: 'active',
  FINISHED: 'finished',
  ABORTED: 'aborted',
};

export const ACCOUNT_CATEGORIES = [
  'STARTING_CASH', 'ROUND_COMPLETE', 'SALARY', 'INCOME_TAX', 'RENT',
  'MORTGAGE', 'MORTGAGE_REDEEM', 'EXPENSE', 'INCOME', 'GIFT',
  'LOAN', 'LOAN_REPAYMENT', 'PROPERTY_PURCHASE', 'PROPERTY_SALE',
  'BUILD', 'FINE', 'TRANSFER', 'OTHERS',
] as const;

const CATEGORY_SET = new Set<string>([...ACCOUNT_CATEGORIES, 'OPENING_BALANCE']);

export function validCategory(c: string): boolean {
  return CATEGORY_SET.has(c);
}

// ---- Accounts ----

export function accountKey(acc: Account): string {
  if (acc.type === ACCOUNT.BANK) return 'BANK';
  return acc.id || '';
}

export function validateAccount(acc: Account, prefix = ''): void {
  const tag = prefix ? prefix : 'account';
  if (!acc || typeof acc !== 'object') {
    throw fail('INVALID', `${tag} is required`);
  }
  switch (acc.type) {
    case ACCOUNT.BANK:
      return;
    case ACCOUNT.EQUITY:
      if (!String(acc.id ?? '').trim()) throw fail('INVALID', `${tag}: equity account GAME_EQUITY`);
      return;
    case ACCOUNT.PLAYER:
      if (!String(acc.id ?? '').trim()) throw fail('INVALID', `${tag}: player account requires id`);
      return;
    default:
      throw fail('INVALID', `${tag}: unknown account type ${acc.type}`);
  }
}

export interface TransferValidationInput {
  from: Account;
  to: Account;
  amount: number;
  category: string;
}

export function transferValidate(t: TransferValidationInput): void {
  if (!Number.isInteger(t.amount) || t.amount <= 0) {
    throw fail('INVALID', 'amount must be > 0');
  }
  if (!validCategory(t.category)) {
    throw fail('INVALID', `unknown account_category ${t.category}`);
  }
  const same =
    t.from.type === t.to.type && accountKey(t.from) === accountKey(t.to);
  if (same) throw fail('INVALID', 'from and to must be different accounts');
  validateAccount(t.from, 'from');
  validateAccount(t.to, 'to');
  if (t.from.type === ACCOUNT.EQUITY || t.to.type === ACCOUNT.EQUITY) {
    throw fail('INVALID', 'equity accounts cannot be used in transfers');
  }
}

// ---- Errors ----

export class DomainError extends Error {
  kind: string;
  detail: string;

  constructor(kind: string, detail: string) {
    super(detail);
    this.name = 'DomainError';
    this.kind = kind; // NOT_FOUND | INVALID | INSUFFICIENT_BALANCE | BANK_INSOLVENT | INVALID_STATE | INTERNAL
    this.detail = detail;
  }
}

export function fail(kind: string, detail: string): DomainError {
  return new DomainError(kind, detail);
}

export function errorStatus(kind: string): number {
  switch (kind) {
    case 'NOT_FOUND': return 404;
    case 'INVALID': return 400;
    case 'INSUFFICIENT_BALANCE': return 400;
    case 'BANK_INSOLVENT': return 400;
    case 'INVALID_STATE': return 409;
    case 'IDEMPOTENT_REPLAY': return 409;
    case 'IDEMPOTENT_CONFLICT': return 409;
    default: return 500;
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}

// ---- IDs ----

export function newId(prefix: string): string {
  const d = new Date();
  const p =
    String(d.getUTCFullYear()).slice(-2) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0') +
    '-' +
    String(d.getUTCSeconds()).padStart(2, '0');
  const rand = crypto.getRandomValues(new Uint8Array(8));
  let hex = '';
  for (const b of rand) hex += b.toString(16).padStart(2, '0');
  return `${prefix}-${p}-${hex}`;
}

// ---- Timestamps ----

const pad = (n: number) => String(n).padStart(2, '0');

export function formatTimestamp(d: Date | string | number): string {
  const t = d instanceof Date ? d : new Date(d);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
  );
}

export function nowTs(): string {
  return formatTimestamp(new Date());
}
