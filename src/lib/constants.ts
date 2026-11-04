import { PaletteColor, Player } from '../types';

export const PALETTE: PaletteColor[] = [
  { name: 'Crimson', bg: '#e11d48', text: '#fff' },
  { name: 'Royal Blue', bg: '#2563eb', text: '#fff' },
  { name: 'Emerald', bg: '#059669', text: '#fff' },
  { name: 'Amber', bg: '#d97706', text: '#fff' },
  { name: 'Purple', bg: '#9333ea', text: '#fff' },
  { name: 'Teal', bg: '#0d9488', text: '#fff' },
  { name: 'Coral', bg: '#ea580c', text: '#fff' },
  { name: 'Pink', bg: '#db2777', text: '#fff' },
];

export function generateIdemKey(prefix = 'txn'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
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
