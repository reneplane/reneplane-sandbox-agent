import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DebugProtocol } from './dap.js';
import { DapError } from './dap.js';
import { ERROR, EVENT, JdwpClient, JdwpError, STEP, SUSPEND, type JdwpEvent, type Location, type Value } from './jdwp.js';

/**
 * Debugging Java without an IDE backend: a Debug Adapter Protocol front for a JVM started with
 * -agentlib:jdwp. There is no standalone Java DAP adapter (VS Code's runs inside the Java language
 * server), so this speaks JDWP directly. It supports what the IDE uses: line breakpoints (also in
 * classes loaded later), continue, step over/into/out (framework code is stepped through), pause,
 * threads, the stack, locals, object fields and arrays, readable values for strings, boxed numbers,
 * BigDecimal and java.* types, and evaluating a variable or a field path (order.status).
 */

const STEP_EXCLUDES = ['java.*', 'javax.*', 'jdk.*', 'sun.*', 'com.sun.*', 'org.springframework.*', 'org.apache.*', 'org.flywaydb.*', 'com.zaxxer.*', 'com.mysql.*', 'org.hibernate.*', 'org.slf4j.*', 'ch.qos.*', 'tools.jackson.*', 'com.fasterxml.*', 'io.micrometer.*', 'org.eclipse.*', 'kotlin.*'];
const TO_STRING_TYPES = /^(java\.time\.|java\.util\.(UUID|Date|Optional|ArrayList|LinkedList|List|HashMap|LinkedHashMap|TreeMap|HashSet|LinkedHashSet|Collections|ImmutableCollections)|java\.math\.|java\.sql\.|java\.net\.URI)/;
const BOXED = new Set(['java.lang.Integer', 'java.lang.Long', 'java.lang.Short', 'java.lang.Byte', 'java.lang.Double', 'java.lang.Float', 'java.lang.Boolean', 'java.lang.Character']);
const PRIMITIVE_NAMES: Record<string, string> = { Z: 'boolean', B: 'byte', C: 'char', S: 'short', I: 'int', J: 'long', F: 'float', D: 'double', V: 'void' };

interface MethodInfo {
  id: bigint;
  name: string;
  signature: string;
  modBits: number;
  lines?: { index: bigint; line: number }[] | null;
  variables?: { codeIndex: bigint; name: string; signature: string; length: number; slot: number }[] | null;
}

interface ClassInfo {
  id: bigint;
  tag: number;
  signature: string;
  name: string;
  sourceFile?: string | null;
  methods?: MethodInfo[];
  fields?: { id: bigint; name: string; signature: string; modBits: number }[];
  superclass?: bigint | null;
}

type Container =
  | { kind: 'locals'; thread: bigint; frame: bigint; location: Location }
  | { kind: 'object'; thread: bigint; objectId: bigint }
  | { kind: 'array'; thread: bigint; objectId: bigint };

interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
}

interface FileBreakpointState {
  className: string;
  lines: { id: number; line: number; verified: boolean; requestId?: number }[];
  prepareRequest?: number;
}

/** "Lcom/shopkart/Foo$Bar;" → "com.shopkart.Foo$Bar"; "[I" → "int[]" */
export function typeName(signature: string): string {
  if (signature.startsWith('[')) return `${typeName(signature.slice(1))}[]`;
  if (signature.startsWith('L')) return signature.slice(1, -1).replace(/\//g, '.');
  return PRIMITIVE_NAMES[signature] ?? signature;
}

const simpleName = (name: string) => name.slice(name.lastIndexOf('.') + 1);

export class JavaDebugBridge implements DebugProtocol {
  private readonly events: ((event: string, body: unknown) => void)[] = [];
  private readonly closes: (() => void)[] = [];
  private readonly classes = new Map<bigint, ClassInfo>();
  private readonly threadIds = new Map<bigint, number>();
  private readonly threadsById = new Map<number, bigint>();
  private readonly frames = new Map<number, { thread: bigint; frame: bigint; location: Location }>();
  private readonly containers = new Map<number, Container>();
  private readonly files = new Map<string, FileBreakpointState>();
  /** Threads stopped by an event (where methods may be invoked) */
  private readonly eventSuspended = new Set<bigint>();
  private readonly stepRequests = new Set<number>();
  private nextRef = 1;
  private nextBreakpointId = 1;
  private closed = false;

  private constructor(
    private readonly jdwp: JdwpClient,
    private readonly sourceRoots: string[],
  ) {
    jdwp.onEvents((events) => void this.onJdwpEvents(events));
    jdwp.onClose(() => this.finish());
  }

  static async attach(options: { port: number; sourceRoots: string[] }): Promise<JavaDebugBridge> {
    return new JavaDebugBridge(await JdwpClient.connect(options.port), options.sourceRoots);
  }

  onEvent(listener: (event: string, body: unknown) => void): void {
    this.events.push(listener);
  }

  onClose(listener: () => void): void {
    this.closes.push(listener);
  }

  close(): void {
    this.jdwp.close();
    this.finish();
  }

  private emit(event: string, body: unknown = {}): void {
    for (const listener of this.events) listener(event, body);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('terminated');
    for (const listener of this.closes) listener();
  }

  async request<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      return (await this.handle(command, args)) as T;
    } catch (error) {
      if (error instanceof JdwpError && error.code === ERROR.THREAD_NOT_SUSPENDED) throw new DapError('The thread is running; pause it first');
      if (error instanceof JdwpError && error.code === ERROR.INVALID_OBJECT) throw new DapError('That value no longer exists');
      throw error instanceof DapError ? error : new DapError((error as Error).message);
    }
  }

  private async handle(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'initialize':
        setTimeout(() => this.emit('initialized'), 0);
        return { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true };
      case 'attach':
      case 'configurationDone':
      case 'setExceptionBreakpoints':
        return {};
      case 'setBreakpoints':
        return this.setBreakpoints(args as { source: { path: string }; breakpoints?: { line: number }[] });
      case 'threads':
        return this.threads();
      case 'stackTrace':
        return this.stackTrace(args as { threadId: number; startFrame?: number; levels?: number });
      case 'scopes': {
        const frame = this.frames.get(args.frameId as number);
        if (!frame) throw new DapError('That frame is gone');
        return { scopes: [{ name: 'Locals', presentationHint: 'locals', variablesReference: this.ref({ kind: 'locals', ...frame }), expensive: false }] };
      }
      case 'variables':
        return { variables: await this.variables(args.variablesReference as number) };
      case 'evaluate':
        return this.evaluate(args as { expression: string; frameId?: number });
      case 'continue':
        await this.resume(this.thread(args.threadId as number));
        return { allThreadsContinued: false };
      case 'next':
      case 'stepIn':
      case 'stepOut':
        await this.step(this.thread(args.threadId as number), command === 'next' ? STEP.OVER : command === 'stepIn' ? STEP.INTO : STEP.OUT);
        return {};
      case 'pause': {
        const thread = this.thread(args.threadId as number);
        await this.jdwp.command(11, 2, this.jdwp.out().object(thread));
        this.emit('stopped', { reason: 'pause', threadId: args.threadId, allThreadsStopped: false });
        return {};
      }
      case 'disconnect':
      case 'terminate':
        await this.jdwp.command(15, 3).catch(() => undefined); // ClearAllBreakpoints
        for (const id of this.stepRequests) await this.jdwp.command(15, 2, this.jdwp.out().byte(EVENT.SINGLE_STEP).int(id)).catch(() => undefined);
        for (const state of this.files.values()) if (state.prepareRequest) await this.clearRequest(EVENT.CLASS_PREPARE, state.prepareRequest);
        await this.jdwp.command(1, 9).catch(() => undefined); // Resume everything we stopped
        await this.jdwp.command(1, 6).catch(() => undefined); // Dispose: the JVM carries on without a debugger
        this.close();
        return {};
      default:
        throw new DapError(`${command} isn't supported for Java`);
    }
  }

  // ---- ids ------------------------------------------------------------------------------------------

  private ref(container: Container): number {
    const id = this.nextRef++;
    this.containers.set(id, container);
    return id;
  }

  private threadId(thread: bigint): number {
    let id = this.threadIds.get(thread);
    if (id === undefined) {
      id = this.threadIds.size + 1;
      this.threadIds.set(thread, id);
      this.threadsById.set(id, thread);
    }
    return id;
  }

  private thread(id: number): bigint {
    const thread = this.threadsById.get(id);
    if (thread === undefined) throw new DapError('Unknown thread');
    return thread;
  }

  // ---- classes, methods, lines --------------------------------------------------------------------

  private async classInfo(id: bigint, tag = 1): Promise<ClassInfo> {
    let info = this.classes.get(id);
    if (!info) {
      const signature = (await this.jdwp.command(2, 1, this.jdwp.out().refType(id))).string();
      info = { id, tag, signature, name: typeName(signature) };
      this.classes.set(id, info);
    }
    return info;
  }

  private async methods(info: ClassInfo): Promise<MethodInfo[]> {
    if (!info.methods) {
      const reply = await this.jdwp.command(2, 5, this.jdwp.out().refType(info.id));
      const count = reply.int();
      info.methods = Array.from({ length: count }, () => ({ id: reply.method(), name: reply.string(), signature: reply.string(), modBits: reply.int() }));
    }
    return info.methods;
  }

  private async lineTable(info: ClassInfo, method: MethodInfo): Promise<{ index: bigint; line: number }[]> {
    if (method.lines === undefined) {
      try {
        const reply = await this.jdwp.command(6, 1, this.jdwp.out().refType(info.id).method(method.id));
        reply.long();
        reply.long();
        const count = reply.int();
        method.lines = Array.from({ length: count }, () => ({ index: reply.long(), line: reply.int() })).sort((a, b) => (a.index < b.index ? -1 : 1));
      } catch {
        method.lines = null; // native or abstract
      }
    }
    return method.lines ?? [];
  }

  private async sourceFile(info: ClassInfo): Promise<string | null> {
    if (info.sourceFile === undefined) {
      try {
        info.sourceFile = (await this.jdwp.command(2, 7, this.jdwp.out().refType(info.id))).string();
      } catch {
        info.sourceFile = null;
      }
    }
    return info.sourceFile;
  }

  private async lineOf(location: Location): Promise<number> {
    const info = await this.classInfo(location.classId, location.typeTag);
    const method = (await this.methods(info)).find((candidate) => candidate.id === location.methodId);
    if (!method) return 0;
    let line = 0;
    for (const entry of await this.lineTable(info, method)) {
      if (entry.index > location.index) break;
      line = entry.line;
    }
    return line;
  }

  /** The .java file a class comes from, when it's in one of the codebank's source folders */
  private async sourcePath(info: ClassInfo): Promise<string | null> {
    const file = await this.sourceFile(info);
    if (!file) return null;
    const outer = info.name.split('$')[0]!;
    const packagePath = outer.includes('.') ? outer.slice(0, outer.lastIndexOf('.')).split('.') : [];
    for (const root of this.sourceRoots) {
      const candidate = join(root, ...packagePath, file);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** backend/src/main/java/com/shopkart/orders/OrdersService.java → com.shopkart.orders.OrdersService */
  private classNameFor(path: string): string | null {
    for (const root of this.sourceRoots) {
      const inside = relative(root, path);
      if (!inside || inside.startsWith('..') || !inside.endsWith('.java')) continue;
      return inside.slice(0, -'.java'.length).split(sep).join('.');
    }
    return null;
  }

  private async loadedClasses(className: string): Promise<ClassInfo[]> {
    const internal = className.replace(/\./g, '/');
    const reply = await this.jdwp.command(1, 3, Buffer.alloc(0), 60_000); // AllClasses
    const count = reply.int();
    const found: ClassInfo[] = [];
    for (let index = 0; index < count; index += 1) {
      const tag = reply.byte();
      const id = reply.refType();
      const signature = reply.string();
      reply.int(); // status
      if (signature === `L${internal};` || signature.startsWith(`L${internal}$`)) {
        if (!this.classes.has(id)) this.classes.set(id, { id, tag, signature, name: typeName(signature) });
        found.push(this.classes.get(id)!);
      }
    }
    return found;
  }

  /** Where a breakpoint on `line` goes: that line's first instruction, or the next line with code */
  private async locationFor(classes: ClassInfo[], line: number): Promise<{ location: Location; line: number } | null> {
    let best: { location: Location; line: number } | null = null;
    for (const info of classes) {
      if (info.signature.includes('$$')) continue; // generated proxies (CGLIB) have no code of the learner's
      for (const method of await this.methods(info)) {
        const lines = await this.lineTable(info, method);
        if (!lines.length) continue;
        const exact = lines.find((entry) => entry.line === line);
        if (exact) return { location: { typeTag: info.tag, classId: info.id, methodId: method.id, index: exact.index }, line };
        const numbers = lines.map((entry) => entry.line);
        if (line < Math.min(...numbers) || line > Math.max(...numbers)) continue;
        const next = lines.filter((entry) => entry.line > line).sort((a, b) => a.line - b.line || (a.index < b.index ? -1 : 1))[0];
        if (next && (!best || next.line < best.line)) best = { location: { typeTag: info.tag, classId: info.id, methodId: method.id, index: next.index }, line: next.line };
      }
    }
    return best;
  }

  // ---- breakpoints --------------------------------------------------------------------------------

  private async clearRequest(kind: number, requestId: number): Promise<void> {
    await this.jdwp.command(15, 2, this.jdwp.out().byte(kind).int(requestId)).catch(() => undefined);
  }

  private async breakpointRequest(location: Location): Promise<number> {
    const data = this.jdwp.out().byte(EVENT.BREAKPOINT).byte(SUSPEND.EVENT_THREAD).int(1).byte(7).location(location);
    return (await this.jdwp.command(15, 1, data)).int();
  }

  private async setBreakpoints(args: { source: { path: string }; breakpoints?: { line: number }[] }) {
    const path = args.source.path;
    const previous = this.files.get(path);
    if (previous) {
      for (const entry of previous.lines) if (entry.requestId) await this.clearRequest(EVENT.BREAKPOINT, entry.requestId);
      if (previous.prepareRequest) await this.clearRequest(EVENT.CLASS_PREPARE, previous.prepareRequest);
      this.files.delete(path);
    }
    const lines = (args.breakpoints ?? []).map((breakpoint) => breakpoint.line);
    const className = this.classNameFor(path);
    if (!className) return { breakpoints: lines.map((line) => ({ id: this.nextBreakpointId++, line, verified: false, message: 'Not in a Java source folder' })) };

    const state: FileBreakpointState = { className, lines: [] };
    const classes = lines.length ? await this.loadedClasses(className) : [];
    for (const line of lines) {
      const id = this.nextBreakpointId++;
      const target = classes.length ? await this.locationFor(classes, line) : null;
      if (target) state.lines.push({ id, line: target.line, verified: true, requestId: await this.breakpointRequest(target.location) });
      else state.lines.push({ id, line, verified: false });
    }
    // Classes that load later (or lines in an inner class that hasn't loaded yet)
    if (state.lines.some((entry) => !entry.verified)) {
      const data = this.jdwp.out().byte(EVENT.CLASS_PREPARE).byte(SUSPEND.EVENT_THREAD).int(1).byte(5).string(`${className}*`);
      state.prepareRequest = (await this.jdwp.command(15, 1, data)).int();
    }
    if (lines.length) this.files.set(path, state);
    return {
      breakpoints: state.lines.map((entry) => ({
        id: entry.id,
        line: entry.line,
        verified: entry.verified,
        message: entry.verified ? undefined : classes.length ? 'No code on this line' : 'Waiting for the class to load',
      })),
    };
  }

  private async onClassPrepared(event: JdwpEvent): Promise<void> {
    const name = typeName(event.signature!);
    for (const state of this.files.values()) {
      if (name !== state.className && !name.startsWith(`${state.className}$`)) continue;
      if (!this.classes.has(event.typeId!)) this.classes.set(event.typeId!, { id: event.typeId!, tag: event.refTypeTag!, signature: event.signature!, name });
      const info = this.classes.get(event.typeId!)!;
      for (const entry of state.lines) {
        if (entry.verified) continue;
        const target = await this.locationFor([info], entry.line);
        if (!target) continue;
        entry.requestId = await this.breakpointRequest(target.location);
        entry.verified = true;
        entry.line = target.line;
        this.emit('breakpoint', { reason: 'changed', breakpoint: { id: entry.id, line: entry.line, verified: true } });
      }
    }
  }

  // ---- events ---------------------------------------------------------------------------------------

  private async onJdwpEvents(events: JdwpEvent[]): Promise<void> {
    // A step can land on a breakpoint: both arrive in one packet, and the IDE gets one "stopped"
    let stopped: { thread: bigint; reason: string } | null = null;
    const hits: number[] = [];
    for (const event of events) {
      if (event.kind === EVENT.BREAKPOINT || event.kind === EVENT.SINGLE_STEP) {
        if (event.kind === EVENT.SINGLE_STEP && this.stepRequests.has(event.requestId)) {
          this.stepRequests.delete(event.requestId);
          await this.clearRequest(EVENT.SINGLE_STEP, event.requestId);
        }
        const hit = [...this.files.values()].flatMap((state) => state.lines.filter((entry) => entry.requestId === event.requestId).map((entry) => entry.id));
        hits.push(...hit);
        stopped = { thread: event.thread!, reason: event.kind === EVENT.BREAKPOINT || hits.length ? 'breakpoint' : 'step' };
      } else if (event.kind === EVENT.CLASS_PREPARE) {
        try {
          await this.onClassPrepared(event);
        } finally {
          await this.jdwp.command(11, 3, this.jdwp.out().object(event.thread!)).catch(() => undefined);
        }
      } else if (event.kind === EVENT.VM_DEATH) {
        this.emit('exited', { exitCode: 0 });
        this.finish();
      }
    }
    if (stopped) {
      this.eventSuspended.add(stopped.thread);
      this.emit('stopped', { reason: stopped.reason, threadId: this.threadId(stopped.thread), allThreadsStopped: false, hitBreakpointIds: hits });
    }
  }

  private forgetState(): void {
    this.frames.clear();
    this.containers.clear();
  }

  private async resume(thread: bigint): Promise<void> {
    this.forgetState();
    this.eventSuspended.delete(thread);
    await this.jdwp.command(11, 3, this.jdwp.out().object(thread));
    this.emit('continued', { threadId: this.threadId(thread), allThreadsContinued: false });
  }

  private async step(thread: bigint, depth: number): Promise<void> {
    const data = this.jdwp.out().byte(EVENT.SINGLE_STEP).byte(SUSPEND.EVENT_THREAD).int(2 + STEP_EXCLUDES.length);
    data.byte(10).object(thread).int(STEP.LINE).int(depth);
    data.byte(1).int(1);
    for (const pattern of STEP_EXCLUDES) data.byte(6).string(pattern);
    this.stepRequests.add((await this.jdwp.command(15, 1, data)).int());
    await this.resume(thread);
  }

  // ---- threads and stack --------------------------------------------------------------------------

  private async threads() {
    const reply = await this.jdwp.command(1, 4);
    const count = reply.int();
    const ids = Array.from({ length: count }, () => reply.object());
    const threads = [];
    for (const thread of ids) {
      const name = await this.jdwp
        .command(11, 1, this.jdwp.out().object(thread))
        .then((answer) => answer.string())
        .catch(() => null);
      if (name !== null) threads.push({ id: this.threadId(thread), name });
    }
    return { threads };
  }

  private async stackTrace(args: { threadId: number; startFrame?: number; levels?: number }) {
    const thread = this.thread(args.threadId);
    const start = args.startFrame ?? 0;
    const total = (await this.jdwp.command(11, 7, this.jdwp.out().object(thread))).int();
    const length = Math.max(0, Math.min(args.levels || total, total - start));
    const reply = await this.jdwp.command(11, 6, this.jdwp.out().object(thread).int(start).int(length));
    const count = reply.int();
    const raw = Array.from({ length: count }, () => ({ frame: reply.frame(), location: reply.location() }));
    const stackFrames = [];
    for (const { frame, location } of raw) {
      const info = await this.classInfo(location.classId, location.typeTag);
      const method = (await this.methods(info)).find((candidate) => candidate.id === location.methodId);
      const path = await this.sourcePath(info);
      const id = this.nextRef++;
      this.frames.set(id, { thread, frame, location });
      stackFrames.push({
        id,
        name: `${simpleName(info.name)}.${method?.name ?? '?'}`,
        line: await this.lineOf(location),
        column: 1,
        source: { name: (await this.sourceFile(info)) ?? `${simpleName(info.name)}.java`, path: path ?? undefined },
        presentationHint: path ? 'normal' : 'subtle',
      });
    }
    return { stackFrames, totalFrames: total };
  }

  // ---- values ---------------------------------------------------------------------------------------

  private async variableTable(info: ClassInfo, method: MethodInfo) {
    if (method.variables === undefined) {
      try {
        const reply = await this.jdwp.command(6, 2, this.jdwp.out().refType(info.id).method(method.id));
        reply.int(); // argument count
        const count = reply.int();
        method.variables = Array.from({ length: count }, () => ({ codeIndex: reply.long(), name: reply.string(), signature: reply.string(), length: reply.int(), slot: reply.int() }));
      } catch {
        method.variables = null;
      }
    }
    return method.variables;
  }

  private async fields(info: ClassInfo) {
    if (!info.fields) {
      const reply = await this.jdwp.command(2, 4, this.jdwp.out().refType(info.id));
      const count = reply.int();
      info.fields = Array.from({ length: count }, () => ({ id: reply.field(), name: reply.string(), signature: reply.string(), modBits: reply.int() }));
    }
    return info.fields;
  }

  private async superclass(info: ClassInfo): Promise<ClassInfo | null> {
    if (info.superclass === undefined) {
      info.superclass = info.tag === 1 ? (await this.jdwp.command(3, 1, this.jdwp.out().refType(info.id))).refType() : 0n;
    }
    return info.superclass ? this.classInfo(info.superclass) : null;
  }

  private async typeOf(objectId: bigint): Promise<ClassInfo> {
    const reply = await this.jdwp.command(9, 1, this.jdwp.out().object(objectId));
    const tag = reply.byte();
    return this.classInfo(reply.refType(), tag);
  }

  /** Instance fields of an object, its superclasses' included */
  private async instanceFields(objectId: bigint): Promise<{ name: string; value: Value }[]> {
    const all: { id: bigint; name: string }[] = [];
    for (let info: ClassInfo | null = await this.typeOf(objectId); info && info.name !== 'java.lang.Object'; info = await this.superclass(info)) {
      for (const field of await this.fields(info)) if (!(field.modBits & 0x0008)) all.push(field);
    }
    if (!all.length) return [];
    const data = this.jdwp.out().object(objectId).int(all.length);
    for (const field of all) data.field(field.id);
    const reply = await this.jdwp.command(9, 2, data);
    const count = reply.int();
    return Array.from({ length: count }, (_, index) => ({ name: all[index]!.name, value: reply.value() }));
  }

  private async field(objectId: bigint, name: string): Promise<Value | null> {
    return (await this.instanceFields(objectId)).find((field) => field.name === name)?.value ?? null;
  }

  private async string(objectId: bigint): Promise<string> {
    return (await this.jdwp.command(10, 1, this.jdwp.out().object(objectId))).string();
  }

  /** toString(), only on a thread stopped by an event, and only for value-like java.* types */
  private async invokeToString(objectId: bigint, thread: bigint, info: ClassInfo): Promise<string | null> {
    if (!this.eventSuspended.has(thread)) return null;
    for (let current: ClassInfo | null = info; current; current = await this.superclass(current)) {
      const method = (await this.methods(current)).find((candidate) => candidate.name === 'toString' && candidate.signature === '()Ljava/lang/String;');
      if (!method) continue;
      const data = this.jdwp.out().object(objectId).object(thread).refType(current.id).method(method.id).int(0).int(1);
      const reply = await this.jdwp.command(9, 6, data, 5000);
      const value = reply.value();
      const exception = reply.value();
      if ('objectId' in exception && exception.objectId !== 0n) return null;
      return 'objectId' in value && value.objectId !== 0n ? this.string(value.objectId) : null;
    }
    return null;
  }

  private async describe(name: string, value: Value, thread: bigint, evaluateName?: string): Promise<DapVariable> {
    const base = { name, evaluateName, variablesReference: 0 };
    if (value.tag === 'V') return { ...base, value: 'void' };
    if (value.tag === 'Z') return { ...base, value: String((value as { value: boolean }).value), type: 'boolean' };
    if (value.tag === 'J') return { ...base, value: String((value as { value: bigint }).value), type: 'long' };
    if (value.tag === 'C') return { ...base, value: `'${String.fromCharCode((value as { value: number }).value)}'`, type: 'char' };
    if ('value' in value) return { ...base, value: String(value.value), type: PRIMITIVE_NAMES[value.tag] };
    const objectId = (value as { objectId: bigint }).objectId;
    if (objectId === 0n) return { ...base, value: 'null' };
    if (value.tag === 's') {
      const text = await this.string(objectId);
      return { ...base, value: JSON.stringify(text.length > 500 ? `${text.slice(0, 500)}…` : text), type: 'String' };
    }
    const info = await this.typeOf(objectId);
    const type = simpleName(info.name);
    if (value.tag === '[') {
      const length = (await this.jdwp.command(13, 1, this.jdwp.out().object(objectId))).int();
      return { ...base, value: `${type.replace(/\[\]$/, '')}[${length}]`, type, variablesReference: length ? this.ref({ kind: 'array', thread, objectId }) : 0 };
    }
    const children = this.ref({ kind: 'object', thread, objectId });
    if (BOXED.has(info.name)) {
      const inner = await this.field(objectId, 'value');
      if (inner) return { ...(await this.describe(name, inner, thread, evaluateName)), type };
    }
    if (info.name === 'java.math.BigDecimal') {
      const compact = await this.field(objectId, 'intCompact');
      const scale = await this.field(objectId, 'scale');
      if (compact && 'value' in compact && scale && 'value' in scale && compact.value !== -(2n ** 63n)) {
        const digits = String(compact.value);
        const places = Number(scale.value);
        const negative = digits.startsWith('-');
        const plain = (negative ? digits.slice(1) : digits).padStart(places + 1, '0');
        const shown = places > 0 ? `${plain.slice(0, -places)}.${plain.slice(-places)}` : plain;
        return { ...base, value: `${negative ? '-' : ''}${shown}`, type, variablesReference: children };
      }
    }
    if (TO_STRING_TYPES.test(info.name) || info.name.startsWith('java.lang.')) {
      const text = await this.invokeToString(objectId, thread, info).catch(() => null);
      if (text !== null) return { ...base, value: text.length > 200 ? `${text.slice(0, 200)}…` : text, type, variablesReference: children };
    }
    return { ...base, value: type, type, variablesReference: children };
  }

  private async variables(reference: number): Promise<DapVariable[]> {
    const container = this.containers.get(reference);
    if (!container) return [];
    if (container.kind === 'locals') {
      const { thread, frame, location } = container;
      const result: DapVariable[] = [];
      const self = (await this.jdwp.command(16, 3, this.jdwp.out().object(thread).frame(frame))).value();
      if ('objectId' in self && self.objectId !== 0n) result.push(await this.describe('this', self, thread, 'this'));
      const info = await this.classInfo(location.classId, location.typeTag);
      const method = (await this.methods(info)).find((candidate) => candidate.id === location.methodId);
      const table = method ? await this.variableTable(info, method) : null;
      if (!table) {
        result.push({ name: '(locals)', value: 'Not available: the class was compiled without debug information', variablesReference: 0 });
        return result;
      }
      const visible = table.filter((variable) => variable.name !== 'this' && variable.codeIndex <= location.index && location.index < variable.codeIndex + BigInt(variable.length));
      if (!visible.length) return result;
      const data = this.jdwp.out().object(thread).frame(frame).int(visible.length);
      for (const variable of visible) data.int(variable.slot).byte(variable.signature.charCodeAt(0));
      const reply = await this.jdwp.command(16, 1, data);
      const count = reply.int();
      for (let index = 0; index < count; index += 1) {
        const variable = visible[index]!;
        result.push(await this.describe(variable.name, reply.value(), thread, variable.name));
      }
      return result;
    }
    if (container.kind === 'array') {
      const length = (await this.jdwp.command(13, 1, this.jdwp.out().object(container.objectId))).int();
      const shown = Math.min(length, 100);
      const reply = await this.jdwp.command(13, 2, this.jdwp.out().object(container.objectId).int(0).int(shown));
      const tag = String.fromCharCode(reply.byte());
      const count = reply.int();
      const primitive = 'ZBCSIJFD'.includes(tag);
      const items: DapVariable[] = [];
      for (let index = 0; index < count; index += 1) items.push(await this.describe(`[${index}]`, primitive ? reply.untagged(tag) : reply.value(), container.thread));
      if (length > shown) items.push({ name: '…', value: `${length - shown} more`, variablesReference: 0 });
      return items;
    }
    const fields = await this.instanceFields(container.objectId);
    return Promise.all(fields.map((field) => this.describe(field.name, field.value, container.thread)));
  }

  /** A variable or a path through fields and indexes: order, order.status, items[0].name, this.db */
  private async evaluate(args: { expression: string; frameId?: number }) {
    const expression = args.expression.trim();
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(expression)) {
      throw new DapError('Java expressions are limited to a variable and its fields, e.g. order.status or items[0]');
    }
    const frame = args.frameId !== undefined ? this.frames.get(args.frameId) : undefined;
    if (!frame) throw new DapError('Stop at a breakpoint first');
    const parts = expression.match(/[A-Za-z_$][\w$]*|\[\d+\]/g)!;
    const locals = await this.variablesRaw(frame);
    let current: Value | null = locals.get(parts[0]!) ?? null;
    const rest = parts.slice(1);
    if (!current && locals.has('this')) {
      const self = locals.get('this')!;
      current = 'objectId' in self ? await this.field(self.objectId, parts[0]!) : null;
    }
    if (!current) throw new DapError(`${parts[0]} is not defined here`);
    for (const part of rest) {
      if (!('objectId' in current) || current.objectId === 0n) throw new DapError(`Can't read ${part} of null`);
      if (part.startsWith('[')) {
        const index = Number(part.slice(1, -1));
        const reply = await this.jdwp.command(13, 2, this.jdwp.out().object(current.objectId).int(index).int(1));
        const tag = String.fromCharCode(reply.byte());
        reply.int();
        current = 'ZBCSIJFD'.includes(tag) ? reply.untagged(tag) : reply.value();
      } else {
        current = await this.field(current.objectId, part);
        if (!current) throw new DapError(`No field ${part}`);
      }
    }
    const shown = await this.describe(expression, current, frame.thread, expression);
    return { result: shown.value, type: shown.type, variablesReference: shown.variablesReference };
  }

  private async variablesRaw(frame: { thread: bigint; frame: bigint; location: Location }): Promise<Map<string, Value>> {
    const values = new Map<string, Value>();
    const self = (await this.jdwp.command(16, 3, this.jdwp.out().object(frame.thread).frame(frame.frame))).value();
    if ('objectId' in self && self.objectId !== 0n) values.set('this', self);
    const info = await this.classInfo(frame.location.classId, frame.location.typeTag);
    const method = (await this.methods(info)).find((candidate) => candidate.id === frame.location.methodId);
    const table = method ? await this.variableTable(info, method) : null;
    const visible = (table ?? []).filter((variable) => variable.name !== 'this' && variable.codeIndex <= frame.location.index && frame.location.index < variable.codeIndex + BigInt(variable.length));
    if (!visible.length) return values;
    const data = this.jdwp.out().object(frame.thread).frame(frame.frame).int(visible.length);
    for (const variable of visible) data.int(variable.slot).byte(variable.signature.charCodeAt(0));
    const reply = await this.jdwp.command(16, 1, data);
    const count = reply.int();
    for (let index = 0; index < count; index += 1) values.set(visible[index]!.name, reply.value());
    return values;
  }
}
