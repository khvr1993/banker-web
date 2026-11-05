// Player-supplied idempotency keys are namespaced by seat so they can never
// collide with host-generated keys (`round:`, `start:`, `bankfloat:`).

export const MAX_CLIENT_IDEM_KEY_CHARS = 128;

/** Stable key chosen by the client for one logical command. */
export function clientIdempotencyKey(
  headers: Record<string, string> | undefined,
  messageId: string
): string {
  const raw = headers?.['Idempotency-Key'] ?? headers?.['idempotency-key'] ?? messageId;
  const clean = String(raw || '').trim().slice(0, MAX_CLIENT_IDEM_KEY_CHARS);
  return clean || messageId;
}

/** Host-side namespace. No player key can collide with a server key. */
export function playerIdempotencyKey(playerId: string, clientKey: string): string {
  return `player:${playerId}:${clientKey}`;
}
