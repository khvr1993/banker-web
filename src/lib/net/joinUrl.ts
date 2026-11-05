import { sanitizeRoom } from './protocol';

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    return (
      protocol === 'file:' ||
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

export function buildJoinUrl(room: string, publicBaseUrl?: string): string {
  const clean = sanitizeRoom(room);
  const base = (publicBaseUrl || window.location.origin).replace(/\/$/, '');
  const path = publicBaseUrl ? '/' : window.location.pathname;
  return `${base}${path}?join=${encodeURIComponent(clean)}`;
}

/**
 * Link for the "share this table" screen: a big QR code and room code that the
 * banker can open in a second tab or window. Falls back to a plain join link
 * when the room is empty.
 */
export function buildShareUrl(room: string, publicBaseUrl?: string, gameName?: string): string {
  const clean = sanitizeRoom(room);
  if (!clean) return '';
  const base = (publicBaseUrl || window.location.origin).replace(/\/$/, '');
  const path = publicBaseUrl ? '/' : window.location.pathname;
  const params = new URLSearchParams({ share: clean });
  const title = String(gameName || '').trim();
  if (title) params.set('name', title.slice(0, 64));
  return `${base}${path}?${params.toString()}`;
}
