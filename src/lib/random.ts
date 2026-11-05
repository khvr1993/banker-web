export function randomHex(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}

export function randomId(prefix: string, bytes = 12): string {
  return `${prefix}-${randomHex(bytes)}`;
}
