// Authorization rules for commands relayed from player sessions.
export interface CommandAuthz {
  ok: boolean;
  status: number;
  type: string;
  message: string;
}

function deny(status: number, type: string, message: string): CommandAuthz {
  return { ok: false, status, type, message };
}

export function gameIdFromPath(path: string): string | null {
  const parts = String(path || '')
    .split('?')[0]
    .split('/')
    .filter(Boolean);
  return parts[0] === 'games' && parts[1] ? parts[1] : null;
}

/**
 * Players may only post transfers paid from their own seat. Every other
 * mutation (rounds, voids, bankruptcy, salaries, seating) is banker-only.
 */
export function authorizeCommand(
  playerId: string | null,
  path: string,
  method: string,
  body: unknown
): CommandAuthz {
  const verb = String(method || 'GET').toUpperCase();
  if (verb === 'GET') {
    return deny(403, 'FORBIDDEN', 'Reads are served from your local session mirror');
  }
  const clean = String(path || '').split('?')[0];
  if (verb === 'POST' && /^\/games\/[^/]+\/transfers$/.test(clean)) {
    if (!playerId) return deny(403, 'FORBIDDEN', 'Join the session before sending payments');
    const from = (body as any)?.from;
    if (!from || from.type !== 'player' || from.id !== playerId) {
      return deny(403, 'FORBIDDEN', 'You can only send payments from your own seat');
    }
    return { ok: true, status: 200, type: 'OK', message: '' };
  }
  return deny(403, 'FORBIDDEN', 'This action is only available to the banker');
}
