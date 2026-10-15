declare module 'cloudflare:sockets' {
  interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    closed: Promise<void>;
    close(): Promise<void>;
  }

  function connect(
    address: { hostname: string; port: number },
    options?: {
      secureTransport?: 'off' | 'on' | 'starttls';
      allowHalfOpen?: boolean;
    }
  ): Socket;
}
