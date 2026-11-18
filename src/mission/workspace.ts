import { parse } from 'yaml';
import { z } from 'zod';
import { DatabaseEngine } from '../protocol.js';

/**
 * `.reneplane/workspace.yaml`: how a codebank runs. The agent reads it from the pinned commit only,
 * never from the learner's working tree, so editing it can't change what the agent runs.
 *
 * Strings may use {{…}} variables, filled in by the agent:
 *   {{ports.frontend}} {{ports.backend}}        ports the agent picked (preferring the ones below)
 *   {{db.host}} {{db.port}} {{db.user}} {{db.password}} {{db.name}} {{db.testName}}
 *   {{url.backend}}                             http://127.0.0.1:<backend port>
 *   {{out}}                                     a fresh folder for test reports, per run
 */

const Command = z.object({
  name: z.string(),
  run: z.string(),
  cwd: z.string().default('.'),
  /** Skip the step when these files haven't changed since it last succeeded (e.g. lockfiles) */
  inputs: z.array(z.string()).default([]),
});

const Service = z.object({
  label: z.string(),
  run: z.string(),
  cwd: z.string().default('.'),
  /** Preferred port; the next free one is used if it's taken */
  port: z.number().int().min(1024).max(65535),
  /** Path that answers once the service is up */
  ready: z.string().default('/'),
  env: z.record(z.string(), z.string()).default({}),
  /** Restart when a file under one of these paths changes (stacks without their own hot reload, e.g. Spring Boot) */
  restartOn: z.array(z.string()).default([]),
});

/**
 * Debugging the backend. While a debug session runs, the backend is started this way instead of
 * services.backend.run, with its debugger port at {{ports.debug}}:
 *   node    `run` opens the inspector (node --inspect=127.0.0.1:{{ports.debug}} …); js-debug attaches
 *   python  `run` starts debugpy (python -m debugpy --listen 127.0.0.1:{{ports.debug}} …); we attach
 *   java    `run` starts the JVM with -agentlib:jdwp=…address=127.0.0.1:{{ports.debug}}; `sourceRoots`
 *           map classes to .java files
 *   dotnet  `build` builds, then netcoredbg launches `program` (the built .dll) in `cwd`
 * Debug runs have no file watcher: a change under `restartOn` restarts the session.
 */
const Debug = z
  .object({
    adapter: z.enum(['node', 'python', 'java', 'dotnet']),
    run: z.string().optional(),
    build: z.string().optional(),
    program: z.string().optional(),
    /** Defaults to the backend service's folder */
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    sourceRoots: z.array(z.string()).default([]),
    restartOn: z.array(z.string()).default([]),
  })
  .refine((debug) => (debug.adapter === 'dotnet' ? Boolean(debug.build && debug.program) : Boolean(debug.run)), {
    message: 'debug needs `run` (node, python, java) or `build` and `program` (dotnet)',
  })
  .refine((debug) => debug.adapter !== 'java' || debug.sourceRoots.length > 0, { message: 'java debugging needs sourceRoots' });

/**
 * A test step is either a command that writes a JUnit/TRX report, or a SQL check: the agent runs the
 * learner's query against the mission's database and compares the result with the expected rows.
 */
const TestStep = z
  .object({
    name: z.string(),
    layer: z.enum(['frontend', 'backend', 'database']),
    run: z.string().optional(),
    cwd: z.string().default('.'),
    /** JUnit XML or TRX report: a file, or a folder of reports */
    junit: z.string().optional(),
    sql: z.object({ answer: z.string(), expected: z.string() }).optional(),
  })
  .refine((step) => (step.run && step.junit) || step.sql, { message: 'a test step needs run + junit, or sql' });

export const WorkspaceFile = z.object({
  version: z.literal(1),
  /** The repo name the IDE shows, e.g. "shopkart" */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  /** The branch the learner works on, e.g. "bug/142a" */
  branch: z.string().regex(/^[A-Za-z0-9._/-]{1,60}$/),
  runtimes: z
    .object({ node: z.string().optional(), python: z.string().optional(), java: z.string().optional(), dotnet: z.string().optional() })
    .default({}),
  database: z.object({
    engine: DatabaseEngine,
    /** Database and role name */
    name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
    /** SQL file for the schema, when there is no migration tool (SQL practice problems) */
    schema: z.string().optional(),
    /** SQL file loaded into the template after migrations, per engine */
    seed: z.string().optional(),
    /** SQL Server only: the whole template (migrations as SQL + seed), which the database pool loads */
    template: z.string().optional(),
  }),
  setup: z.array(Command).default([]),
  /** Absent for SQL practice problems: the learner changes data in the SQL console only */
  migrate: z
    .object({
      run: z.string(),
      cwd: z.string().default('.'),
      /** A regex with one capture group: the name of each migration the command applied */
      applied: z.string(),
    })
    .optional(),
  services: z.object({ backend: Service.optional(), frontend: Service.optional() }).default({}),
  /** How the IDE's debugger runs the backend (absent: the mission can't be debugged) */
  debug: Debug.optional(),
  test: z.array(TestStep).min(1),
  preview: z.object({ service: z.enum(['frontend', 'backend']), path: z.string().startsWith('/') }).nullable().default(null),
  env: z.record(z.string(), z.string()).default({}),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

export function parseWorkspace(text: string): WorkspaceFile {
  const result = WorkspaceFile.safeParse(parse(text));
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`The workspace file is invalid at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`);
  }
  return result.data;
}

export type Vars = Record<string, string | number>;

/** Fill in {{a.b}} variables. An unknown variable is an error, never silently empty. */
export function render(template: string, vars: Vars): string {
  return template.replace(/\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`workspace.yaml uses an unknown variable {{${name}}}`);
    return String(value);
  });
}

/**
 * Commands run through the shell: cmd.exe on Windows, which can't run "./mvnw". Rewrite "./" at the
 * start of a command to ".\" there, so one workspace.yaml works everywhere (cmd finds mvnw.cmd).
 */
export function shellCommand(command: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? command.replace(/(^|[\s;&|(])\.\//g, '$1.\\') : command;
}

export function renderEnv(env: Record<string, string>, vars: Vars): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, render(value, vars)]));
}
