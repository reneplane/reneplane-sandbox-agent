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

const TestStep = z.object({
  name: z.string(),
  layer: z.enum(['frontend', 'backend', 'database']),
  run: z.string(),
  cwd: z.string().default('.'),
  /** JUnit XML report: a file, or a folder of *.xml files */
  junit: z.string(),
});

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
    /** SQL file loaded into the template after migrations, per engine */
    seed: z.string().optional(),
  }),
  setup: z.array(Command).default([]),
  migrate: z.object({
    run: z.string(),
    cwd: z.string().default('.'),
    /** A regex with one capture group: the name of each migration the command applied */
    applied: z.string(),
  }),
  services: z.object({ backend: Service.optional(), frontend: Service.optional() }),
  test: z.array(TestStep).min(1),
  preview: z.object({ service: z.enum(['frontend', 'backend']), path: z.string().startsWith('/') }).nullable().default(null),
  env: z.record(z.string(), z.string()).default({}),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

export function parseWorkspace(text: string): WorkspaceFile {
  const result = WorkspaceFile.safeParse(parse(text));
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`.reneplane/workspace.yaml is invalid at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`);
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

export function renderEnv(env: Record<string, string>, vars: Vars): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, render(value, vars)]));
}
