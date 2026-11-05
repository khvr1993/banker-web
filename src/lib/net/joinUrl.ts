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
