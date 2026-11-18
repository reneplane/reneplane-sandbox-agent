import { connect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';

/**
 * A Debug Adapter Protocol connection: "Content-Length: N\r\n\r\n" + JSON, both ways.
 * Requests get responses; adapters also send events, and some send requests back (js-debug's
 * startDebugging, debugpy's runInTerminal), which `onReverseRequest` answers.
 */

export interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  arguments?: unknown;
  body?: unknown;
  success?: boolean;
  message?: string;
  request_seq?: number;
}

export class DapError extends Error {}

export interface DebugProtocol {
  request<T = unknown>(command: string, args?: unknown, timeoutMs?: number): Promise<T>;
  onEvent(listener: (event: string, body: unknown) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export class DapConnection implements DebugProtocol {
  private seq = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (body: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly eventListeners: ((event: string, body: unknown) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];
  private closed = false;
  /** Answers a request the adapter sends us; return the response body, or throw to refuse */
  onReverseRequest: (command: string, args: unknown) => Promise<unknown> = async (command) => {
    throw new DapError(`${command} is not supported`);
  };

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly destroy: () => void = () => undefined,
  ) {
    input.on('data', (chunk: Buffer) => this.receive(chunk));
    const end = () => this.handleClose();
    input.on('end', end);
    input.on('close', end);
    input.on('error', end);
    output.on('error', end);
  }

  /** Connect to an adapter listening on 127.0.0.1:port, retrying while it starts */
  static async connectTcp(port: number, timeoutMs = 20_000): Promise<DapConnection> {
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const candidate = connect({ host: '127.0.0.1', port }, () => resolve(candidate));
          candidate.once('error', reject);
        });
        return new DapConnection(socket, socket, () => socket.destroy());
      } catch (error) {
        lastError = error as Error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw new DapError(`Couldn't connect to the debugger on port ${port}: ${lastError?.message ?? 'timed out'}`);
  }

  request<T = unknown>(command: string, args?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new DapError('The debugger is not connected'));
    const seq = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new DapError(`The debugger didn't answer "${command}"`));
      }, timeoutMs);
      this.pending.set(seq, { resolve: resolve as (body: unknown) => void, reject, timer });
      this.send({ seq, type: 'request', command, arguments: args });
    });
  }

  onEvent(listener: (event: string, body: unknown) => void): void {
    this.eventListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  close(): void {
    this.handleClose();
    this.destroy();
  }

  private send(message: Omit<DapMessage, 'seq'> & { seq?: number }): void {
    if (this.closed) return;
    const json = Buffer.from(JSON.stringify({ seq: message.seq ?? this.seq++, ...message }), 'utf8');
    this.output.write(`Content-Length: ${json.length}\r\n\r\n`);
    this.output.write(json);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isFinite(length)) {
        // Not DAP (e.g. a banner): drop up to the separator and keep going
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      try {
        this.dispatch(JSON.parse(body) as DapMessage);
      } catch {
        // a malformed message is ignored
      }
    }
  }

  private dispatch(message: DapMessage): void {
    if (message.type === 'response') {
      const waiting = this.pending.get(message.request_seq!);
      if (!waiting) return;
      this.pending.delete(message.request_seq!);
      clearTimeout(waiting.timer);
      if (message.success) waiting.resolve(message.body ?? {});
      else waiting.reject(new DapError(message.message ?? `${message.command} failed`));
    } else if (message.type === 'event') {
      for (const listener of this.eventListeners) listener(message.event!, message.body ?? {});
    } else if (message.type === 'request') {
      void this.onReverseRequest(message.command!, message.arguments).then(
        (body) => this.send({ type: 'response', request_seq: message.seq, command: message.command, success: true, body }),
        (error: Error) => this.send({ type: 'response', request_seq: message.seq, command: message.command, success: false, message: error.message }),
      );
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new DapError('The debugger disconnected'));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}
