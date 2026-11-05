// Injectable peer factory. Tests can swap in an in-memory transport.
import { createPeerTransport } from './peerTransport';
import { Transport, TransportHandlers, PeerTransportOptions } from './transportTypes';

export type PeerFactory = (
  id: string,
  handlers?: TransportHandlers,
  options?: PeerTransportOptions
) => Promise<Transport>;

let factory: PeerFactory = createPeerTransport;

export function setPeerFactory(next: PeerFactory): void {
  factory = next;
}

export function resetPeerFactory(): void {
  factory = createPeerTransport;
}

export function createTransport(
  id: string,
  handlers?: TransportHandlers,
  options?: PeerTransportOptions
): Promise<Transport> {
  return factory(id, handlers, options);
}
