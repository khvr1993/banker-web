export type AccountType = 'bank' | 'player' | 'equity';

export interface Account {
  type: AccountType;
  id?: string;
}

export type GameStatus = 'pending' | 'active' | 'finished' | 'aborted';

export interface Player {
  id: string;
  game_id: string;
  name: string;
  seat_no: number;
  is_bankrupt: boolean;
  cash: number;
  created_at: string;
}

export interface Game {
  id: string;
  name: string;
  status: GameStatus;
  starting_cash: number;
  initial_bank_balance: number;
  salary_per_round: number;
  current_round: number;
  currency: string;
  join_token: string;
  created_at: string;
  ended_at: string;
  players?: Player[];
  bank_balance?: number;
}

export interface TxnEntry {
  account_type: AccountType;
  account_ref: string;
  direction: 'DR' | 'CR';
  amount: number;
}

export interface Transaction {
  id: string;
  game_id: string;
  txn_type: string;
  account_category: string;
  round: number;
  amount: number;
  description: string;
  ref_txn_id: string;
  idempotency_key: string;
  voided_by_txn: string;
  created_at: string;
  entries: TxnEntry[];
}

export interface RoundRecord {
  key: string;
  game_id: string;
  round_no: number;
  idem_key: string;
  created_at: string;
}

export interface RoundSummary {
  round: number;
  txn_count: number;
  total_moved: number;
}

export interface AuditRecord {
  id: string;
  game_id: string;
  actor: string;
  action: string;
  detail: string;
  created_at: string;
}

export interface StatementRow {
  txn_id: string;
  account_category: string;
  round: number;
  amount: number;
  dr: number;
  cr: number;
  counterparty: string;
  counterparty_type: AccountType;
  description: string;
  voided: boolean;
  created_at: string;
}

export interface BankInfo {
  game_id: string;
  bank_balance: number;
  currency: string;
  players_active: number;
  players_bankrupt: number;
}

export interface PaletteColor {
  name: string;
  bg: string;
  text: string;
}

export interface ToastMessage {
  id: string;
  text: string;
  type: 'info' | 'success' | 'error';
}
