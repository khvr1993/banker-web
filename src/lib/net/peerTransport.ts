// PeerJS transport wrapper. Only signaling uses PeerJS Cloud; ledger data flows
// over the authenticated data channel between host and players.
import Peer, { DataConnection } from 'peerjs';
import { Transport, TransportConnection, TransportHandlers, PeerTransportOptions } from './transportTypes';

export type { Transport, TransportConnection, TransportHandlers, PeerTransportOptions };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveIceServers(): RTCIceServer[] | undefined {
  try {
    const raw = localStorage.getItem('banker_ice_servers');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as RTCIceServer[];
  } catch {
    // Ignore malformed optional TURN config.
  }
  return undefined;
}

function wrapConnection(conn: DataConnection): TransportConnection {
  let closed = false;
  const closeHandlers: (() => void)[] = [];
  const fireClose = () => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch {
        // ignore handler failures
      }
    }
  };

  return {
    id: conn.peer,
    send(data: unknown) {
      try {
        if (conn.open) conn.send(data);
      } catch (err) {
        console.warn('Peer send failed:', err);
      }
    },
    close() {
      try {
        conn.close();
      } catch {
        // already closed
      }
      fireClose();
    },
    onOpen(handler: () => void) {
      if (conn.open) handler();
      else conn.on('open', handler);
    },
    onData(handler: (data: unknown) => void) {
      conn.on('data', handler);
    },
    onClose(handler: () => void) {
      closeHandlers.push(handler);
      conn.on('close', fireClose);
      conn.on('error', fireClose);
    },
    isOpen() {
      return conn.open;
    },
  };
}

function openOnce(id: string, handlers: TransportHandlers, options: PeerTransportOptions): Promise<Transport> {
  return new Promise<Transport>((resolve, reject) => {
    const iceServers = options.iceServers || resolveIceServers();
    const peerOptions: Record<string, unknown> = { debug: options.debug ?? 1 };
    if (iceServers) peerOptions.config = { iceServers };
    if (options.host) peerOptions.host = options.host;
    if (options.port) peerOptions.port = options.port;
    if (options.path) peerOptions.path = options.path;
    if (options.key) peerOptions.key = options.key;
    if (options.secure !== undefined) peerOptions.secure = options.secure;

    const peer = new Peer(id, peerOptions as any);

    let settled = false;

    peer.on('open', (openId: string) => {
      if (settled) return;
      settled = true;
      resolve({
        id: openId,
        connect(target: string) {
          const conn = peer.connect(target, { reliable: true, serialization: 'json' });
          return wrapConnection(conn);
        },
        reconnect() {
          try {
            if (peer.disconnected) peer.reconnect();
          } catch (err) {
            console.warn('Peer reconnect failed:', err);
          }
        },
        destroy() {
          try {
            peer.destroy();
          } catch {
            // already destroyed
          }
        },
      });
    });

    peer.on('connection', (conn: DataConnection) => {
      handlers.onConnection?.(wrapConnection(conn));
    });

    peer.on('disconnected', () => {
      handlers.onDisconnected?.();
      try {
        peer.reconnect();
      } catch (err) {
        console.warn('Peer reconnect failed:', err);
      }
    });

    peer.on('error', (err: any) => {
      const info = { type: String(err?.type || 'peer-error'), message: String(err?.message || 'PeerJS error') };
      if (!settled) {
        settled = true;
        try {
          peer.destroy();
        } catch {
          // ignore
        }
        reject(Object.assign(new Error(info.message), { type: info.type }));
        return;
      }
      handlers.onError?.(info);
    });
  });
}

/**
 * Opens a peer and retries transient registration/network failures with
 * exponential backoff. Fatal browser errors reject immediately.
 */
export async function createPeerTransport(
  id: string,
  handlers: TransportHandlers = {},
  options: PeerTransportOptions = {}
): Promise<Transport> {
  const retries = options.retries ?? 5;
  let attempt = 0;

  for (;;) {
    try {
      return await openOnce(id, handlers, options);
    } catch (err: any) {
      const type = String(err?.type || '');
      const fatal = type === 'browser-incompatible' || type === 'invalid-id' || type === 'invalid-key';
      if (fatal || attempt >= retries) throw err;
      const delay = Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
      attempt += 1;
      await sleep(delay);
    }
  }
}
