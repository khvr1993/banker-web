// Shared transport interfaces so sessions and tests are independent of PeerJS.
export interface TransportConnection {
  readonly id: string;
  send(data: unknown): void;
  close(): void;
  onOpen(handler: () => void): void;
  onData(handler: (data: unknown) => void): void;
  onClose(handler: () => void): void;
  isOpen(): boolean;
}

export interface TransportHandlers {
  onConnection?: (conn: TransportConnection) => void;
  onDisconnected?: () => void;
  onError?: (err: { type: string; message: string }) => void;
}

export interface Transport {
  readonly id: string;
  connect(peerId: string): TransportConnection;
  reconnect(): void;
  destroy(): void;
}

export interface PeerTransportOptions {
  retries?: number;
  debug?: number;
  host?: string;
  port?: number;
  path?: string;
  key?: string;
  secure?: boolean;
  iceServers?: RTCIceServer[];
  /** Per-attempt bound for reaching the signaling server. */
  openTimeoutMs?: number;
  /** Overall bound across all registration retries. */
  totalTimeoutMs?: number;
}
