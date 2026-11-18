import { connect, type Socket } from 'node:net';

/**
 * A small JDWP client: the JVM's own debugging wire protocol, spoken to `-agentlib:jdwp=…,server=y`.
 * Only what the Java bridge needs (java.ts). Big-endian packets:
 *   command: length(4) id(4) flags(1)=0    commandSet(1) command(1) data
 *   reply:   length(4) id(4) flags(1)=0x80 errorCode(2) data
 * Events arrive as Event.Composite commands (64/100) from the VM.
 */

export class JdwpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** The error codes we act on */
export const ERROR = { ABSENT_INFORMATION: 101, INVALID_OBJECT: 20, THREAD_NOT_SUSPENDED: 13, INVALID_SLOT: 35, NOT_FOUND: 41 };

export const EVENT = { SINGLE_STEP: 1, BREAKPOINT: 2, THREAD_START: 6, THREAD_DEATH: 7, CLASS_PREPARE: 8, VM_START: 90, VM_DEATH: 99 };
export const SUSPEND = { NONE: 0, EVENT_THREAD: 1, ALL: 2 };
export const STEP = { LINE: 1, INTO: 0, OVER: 1, OUT: 2 };

export interface IdSizes {
  field: number;
  method: number;
  object: number;
  referenceType: number;
  frame: number;
}

export interface Location {
  typeTag: number;
  classId: bigint;
  methodId: bigint;
  index: bigint;
}

export type Value =
  | { tag: 'Z'; value: boolean }
  | { tag: 'B' | 'C' | 'S' | 'I' | 'F' | 'D'; value: number }
  | { tag: 'J'; value: bigint }
  | { tag: 'V' }
  | { tag: string; objectId: bigint };

export interface JdwpEvent {
  kind: number;
  requestId: number;
  thread?: bigint;
  location?: Location;
  /** CLASS_PREPARE */
  refTypeTag?: number;
  typeId?: bigint;
  signature?: string;
}

/** Writes a command's data */
export class Out {
  private parts: Buffer[] = [];
  constructor(private readonly sizes: IdSizes) {}

  byte(value: number): this {
    this.parts.push(Buffer.from([value & 0xff]));
    return this;
  }
  int(value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value);
    this.parts.push(buffer);
    return this;
  }
  long(value: bigint): this {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(value);
    this.parts.push(buffer);
    return this;
  }
  id(value: bigint, size: number): this {
    const buffer = Buffer.alloc(size);
    if (size === 8) buffer.writeBigUInt64BE(BigInt.asUintN(64, value));
    else buffer.writeUInt32BE(Number(value));
    this.parts.push(buffer);
    return this;
  }
  object(value: bigint): this {
    return this.id(value, this.sizes.object);
  }
  refType(value: bigint): this {
    return this.id(value, this.sizes.referenceType);
  }
  method(value: bigint): this {
    return this.id(value, this.sizes.method);
  }
  field(value: bigint): this {
    return this.id(value, this.sizes.field);
  }
  frame(value: bigint): this {
    return this.id(value, this.sizes.frame);
  }
  string(value: string): this {
    const bytes = Buffer.from(value, 'utf8');
    this.int(bytes.length);
    this.parts.push(bytes);
    return this;
  }
  location(value: Location): this {
    return this.byte(value.typeTag).refType(value.classId).method(value.methodId).long(value.index);
  }
  buffer(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/** Reads a reply's data */
export class In {
  private offset = 0;
  constructor(
    private readonly data: Buffer,
    private readonly sizes: IdSizes,
  ) {}

  byte(): number {
    return this.data.readUInt8(this.offset++);
  }
  boolean(): boolean {
    return this.byte() !== 0;
  }
  int(): number {
    const value = this.data.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  long(): bigint {
    const value = this.data.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }
  id(size: number): bigint {
    const value = size === 8 ? this.data.readBigUInt64BE(this.offset) : BigInt(this.data.readUInt32BE(this.offset));
    this.offset += size;
    return value;
  }
  object(): bigint {
    return this.id(this.sizes.object);
  }
  refType(): bigint {
    return this.id(this.sizes.referenceType);
  }
  method(): bigint {
    return this.id(this.sizes.method);
  }
  field(): bigint {
    return this.id(this.sizes.field);
  }
  frame(): bigint {
    return this.id(this.sizes.frame);
  }
  string(): string {
    const length = this.int();
    const value = this.data.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  location(): Location {
    return { typeTag: this.byte(), classId: this.refType(), methodId: this.method(), index: this.long() };
  }
  /** A value without its tag byte (the tag is known from the signature) */
  untagged(tag: string): Value {
    switch (tag) {
      case 'Z':
        return { tag, value: this.boolean() };
      case 'B':
        return { tag, value: this.data.readInt8(this.offset++) };
      case 'C': {
        const value = this.data.readUInt16BE(this.offset);
        this.offset += 2;
        return { tag, value };
      }
      case 'S': {
        const value = this.data.readInt16BE(this.offset);
        this.offset += 2;
        return { tag, value };
      }
      case 'I':
        return { tag, value: this.int() };
      case 'F': {
        const value = this.data.readFloatBE(this.offset);
        this.offset += 4;
        return { tag, value };
      }
      case 'J':
        return { tag, value: this.long() };
      case 'D': {
        const value = this.data.readDoubleBE(this.offset);
        this.offset += 8;
        return { tag, value };
      }
      case 'V':
        return { tag };
      default:
        return { tag, objectId: this.object() };
    }
  }
  value(): Value {
    return this.untagged(String.fromCharCode(this.byte()));
  }
}

const HANDSHAKE = 'JDWP-Handshake';

export class JdwpClient {
  sizes: IdSizes = { field: 8, method: 8, object: 8, referenceType: 8, frame: 8 };
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (data: In) => void; reject: (error: Error) => void }>();
  private eventListener: (events: JdwpEvent[], suspendPolicy: number) => void = () => undefined;
  private closeListener: () => void = () => undefined;
  private closed = false;

  private constructor(private readonly socket: Socket) {}

  /** Connect and handshake, retrying while the JVM starts */
  static async connect(port: number, timeoutMs = 60_000): Promise<JdwpClient> {
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const candidate = connect({ host: '127.0.0.1', port }, () => resolve(candidate));
          candidate.once('error', reject);
        });
        await new Promise<void>((resolve, reject) => {
          let received = Buffer.alloc(0);
          const onData = (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
            if (received.length < HANDSHAKE.length) return;
            socket.off('data', onData);
            if (received.subarray(0, HANDSHAKE.length).toString('ascii') !== HANDSHAKE) reject(new Error('Not a JDWP port'));
            else {
              if (received.length > HANDSHAKE.length) socket.unshift(received.subarray(HANDSHAKE.length));
              resolve();
            }
          };
          socket.on('data', onData);
          socket.once('error', reject);
          socket.write(HANDSHAKE, 'ascii');
        });
        const client = new JdwpClient(socket);
        client.listen();
        const sizes = await client.command(1, 7);
        client.sizes = { field: sizes.int(), method: sizes.int(), object: sizes.int(), referenceType: sizes.int(), frame: sizes.int() };
        return client;
      } catch (error) {
        lastError = error as Error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error(`Couldn't connect to the Java debugger port ${port}: ${lastError?.message ?? 'timed out'}`);
  }

  out(): Out {
    return new Out(this.sizes);
  }

  onEvents(listener: (events: JdwpEvent[], suspendPolicy: number) => void): void {
    this.eventListener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  command(commandSet: number, command: number, data: Out | Buffer = Buffer.alloc(0), timeoutMs = 15_000): Promise<In> {
    if (this.closed) return Promise.reject(new JdwpError(-1, 'The Java debugger is disconnected'));
    const id = this.nextId++;
    const payload = data instanceof Out ? data.buffer() : data;
    const header = Buffer.alloc(11);
    header.writeUInt32BE(11 + payload.length, 0);
    header.writeUInt32BE(id, 4);
    header.writeUInt8(0, 8);
    header.writeUInt8(commandSet, 9);
    header.writeUInt8(command, 10);
    return new Promise<In>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new JdwpError(-1, `The JVM didn't answer ${commandSet}/${command}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.write(Buffer.concat([header, payload]));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }

  private listen(): void {
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 11) {
        const length = this.buffer.readUInt32BE(0);
        if (this.buffer.length < length) return;
        const packet = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        this.handle(packet);
      }
    });
    const end = () => {
      this.closed = true;
      for (const waiting of this.pending.values()) waiting.reject(new JdwpError(-1, 'The Java debugger disconnected'));
      this.pending.clear();
      this.closeListener();
    };
    this.socket.on('close', end);
    this.socket.on('error', () => undefined);
  }

  private handle(packet: Buffer): void {
    const id = packet.readUInt32BE(4);
    const flags = packet.readUInt8(8);
    if (flags & 0x80) {
      const waiting = this.pending.get(id);
      if (!waiting) return;
      this.pending.delete(id);
      const error = packet.readUInt16BE(9);
      if (error) waiting.reject(new JdwpError(error, `JDWP error ${error}`));
      else waiting.resolve(new In(packet.subarray(11), this.sizes));
      return;
    }
    const commandSet = packet.readUInt8(9);
    const command = packet.readUInt8(10);
    if (commandSet !== 64 || command !== 100) return;
    const data = new In(packet.subarray(11), this.sizes);
    const suspendPolicy = data.byte();
    const count = data.int();
    const events: JdwpEvent[] = [];
    for (let index = 0; index < count; index += 1) {
      const kind = data.byte();
      const requestId = data.int();
      if (kind === EVENT.BREAKPOINT || kind === EVENT.SINGLE_STEP) {
        events.push({ kind, requestId, thread: data.object(), location: data.location() });
      } else if (kind === EVENT.CLASS_PREPARE) {
        events.push({ kind, requestId, thread: data.object(), refTypeTag: data.byte(), typeId: data.refType(), signature: data.string() });
        data.int(); // status
      } else if (kind === EVENT.THREAD_START || kind === EVENT.THREAD_DEATH || kind === EVENT.VM_START) {
        events.push({ kind, requestId, thread: data.object() });
      } else if (kind === EVENT.VM_DEATH) {
        events.push({ kind, requestId });
      } else {
        // An event we never ask for: stop reading this packet rather than misparse it
        break;
      }
    }
    this.eventListener(events, suspendPolicy);
  }
}
