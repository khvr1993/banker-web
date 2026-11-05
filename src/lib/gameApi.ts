// API facade: local API by default, host-relayed commands for player sessions.
import { localApi, LocalApiOptions } from './api';
import type { ClientSession } from './net/clientSession';

let clientSession: ClientSession | null = null;

export function setClientSession(session: ClientSession | null): void {
  clientSession = session;
}

/** Clients may only post transfers; everything else stays banker-only. */
export function isClientWritable(path: string, method: string): boolean {
  if (String(method || 'GET').toUpperCase() !== 'POST') return false;
  return /^\/games\/[^/]+\/transfers$/.test(String(path || '').split('?')[0]);
}

function hostOnlyError(): Error {
  const err = new Error('This action is only available to the banker');
  (err as any).status = 403;
  (err as any).type = 'FORBIDDEN';
  return err;
}

export async function gameApi(path: string, options: LocalApiOptions = {}): Promise<any> {
  const method = (options.method || 'GET').toUpperCase();
  const session = clientSession;

  if (!session) return localApi(path, options);
  if (method === 'GET') return localApi(path, options);
  if (!isClientWritable(path, method)) throw hostOnlyError();
  return session.command(path, options);
}
