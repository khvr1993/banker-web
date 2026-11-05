// 128-bit per-device seat credential. Never placed in the URL; sent only over
// the encrypted data channel.

export function newJoinKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `jk-${hex}`;
}

export function sanitizeJoinKey(value: unknown): string {
  const clean = String(value || '').trim();
  return /^jk-[a-f0-9]{32}$/.test(clean) ? clean : '';
}
