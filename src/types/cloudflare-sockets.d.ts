declare module 'cloudflare:sockets' {
  interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
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
