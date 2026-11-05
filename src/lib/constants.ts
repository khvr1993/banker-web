import { PaletteColor, Player } from '../types';
import { randomHex } from './random';

export const PALETTE: PaletteColor[] = [
  { name: 'Slate', bg: '#18181b', text: '#f4f4f5' },
  { name: 'Zinc', bg: '#1f1f23', text: '#f4f4f5' },
  { name: 'Graphite', bg: '#27272a', text: '#f4f4f5' },
  { name: 'Carbon', bg: '#1c1c1f', text: '#f4f4f5' },
  { name: 'Obsidian', bg: '#222226', text: '#f4f4f5' },
  { name: 'Iron', bg: '#26262a', text: '#f4f4f5' },
  { name: 'Ash', bg: '#1a1a1e', text: '#f4f4f5' },
  { name: 'Pewter', bg: '#242429', text: '#f4f4f5' },
];

export function generateIdemKey(prefix = 'txn'): string {
  return `${prefix}-${Date.now()}-${randomHex(6)}`;
}

export function formatMoney(amount: number | string | undefined | null, currency = '₹'): string {
  const num = Number(amount || 0);
  return `${currency}${num.toLocaleString('en-IN')}`;
}

export function derivePlayerColor(seatNo: number): PaletteColor {
  const index = Math.max(0, (seatNo - 1)) % PALETTE.length;
  return PALETTE[index];
}

export function deriveNextSeat(players: Player[] = []): number {
  if (!players || players.length === 0) return 1;
  const maxSeat = players.reduce((max, p) => Math.max(max, p.seat_no || 0), 0);
  return maxSeat + 1;
}
