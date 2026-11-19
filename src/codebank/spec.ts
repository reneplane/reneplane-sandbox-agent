import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { DatabaseEngine } from '../protocol.js';
import { safePath } from './patch.js';

/**
 * The codebank format, version 1 (docs/CODEBANK.md explains it for authors). Every file an author
 * writes is checked against these schemas first, with the file and the field in the message.
 */

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'lowercase letters, digits and dashes');
const RelPath = z.string().refine(safePath, 'a relative path with forward slashes and no ..');
const Glob = z.string().min(1).max(200).refine((glob) => !glob.startsWith('/') && !glob.includes('..') && !glob.includes('\\'), 'a relative glob');
const Person = z.string().regex(/^[^<>]+ <[^<>@\s]+@[^<>\s]+>$/, '"Name <email>"');

export const Adapter = z.enum(['node', 'python', 'java-maven', 'dotnet', 'sql']);
export type Adapter = z.infer<typeof Adapter>;

/** How a SQL Server template is made: the pool can't run a migration tool, so it gets a script */
const TemplateRecipe = z.union([
  /** Run a command in the learner tree that writes the migrations as SQL to {{out}} (dotnet ef …) */
  z.object({
    run: z.string().min(1),
    cwd: RelPath.default('.'),
    /** Design-time settings the tool needs (it never connects: a placeholder connection string is fine) */
    env: z.record(z.string(), z.string()).default({}),
  }),
  /** Or concatenate files from the learner tree (SQL practice: schema.sql) */
  z.object({ files: z.array(RelPath).min(1) }),
]);

export const StackSpec = z.object({
  adapter: Adapter,
  /** "Node · Express · PostgreSQL" */
  label: z.string().min(3).max(80),
  engine: DatabaseEngine,
  /** Where the seed generated from the codebank's seed.json goes in this stack's learner tree */
  seed: RelPath.optional(),
  /** SQL Server stacks: how the pool's template is made (migrations as SQL, then the seed) */
  template: TemplateRecipe.optional(),
});
export type StackSpec = z.infer<typeof StackSpec>;

export const CodebankSpec = z
  .object({
    format: z.literal(1),
    /** The repo is reneplane/codebank-<id> */
    id: Id,
    name: z.string().min(2).max(60),
    description: z.string().max(500).default(''),
    stacks: z.record(Id, StackSpec).refine((stacks) => Object.keys(stacks).length > 0, 'at least one stack'),
    /** Folders copied into every stack's learner tree: { "frontend": "shared/frontend" } */
    mounts: z.record(RelPath, RelPath).default({}),
    /** One seed for every stack (shared/seed/seed.json), generated into each stack's `seed` path */
    seed: RelPath.optional(),
  })
  .superRefine((spec, context) => {
    for (const [id, stack] of Object.entries(spec.stacks)) {
      if (stack.engine === 'sqlserver' && !stack.template) context.addIssue({ code: 'custom', path: ['stacks', id, 'template'], message: 'a SQL Server stack needs a template recipe' });
      if (stack.engine !== 'sqlserver' && stack.template) context.addIssue({ code: 'custom', path: ['stacks', id, 'template'], message: 'only SQL Server stacks have a template' });
      if (spec.seed && !stack.seed) context.addIssue({ code: 'custom', path: ['stacks', id, 'seed'], message: 'the codebank has a seed.json: say where this stack gets it' });
    }
  });
export type CodebankSpec = z.infer<typeof CodebankSpec>;

export const ProblemStack = z.object({
  /** What a learner's patch may change; everything else is left out when grading */
  allow: z.array(Glob).min(1),
  /** Visible tests that must fail on the starter (default: at least one fails) */
  expectFailing: z.array(z.string()).optional(),
});

export const ProblemSpec = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d{1,5}$/, 'like SHOP-142'),
  /** The platform's mission id: shop-142-cancel-restock */
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  kind: z.enum(['app', 'sql']),
  type: z.enum(['bug', 'feature', 'hotfix']),
  title: z.string().min(5).max(120),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  skills: z.array(z.string().min(1).max(40)).max(12).default([]),
  /** The ticket the learner reads (markdown, in the problem folder) */
  brief: RelPath.default('brief.md'),
  /** The learner's branch */
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,60}$/),
  /** Where the preview opens */
  preview: z.string().regex(/^\/[^\s]*$/).optional(),
  minAgentVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('0.3.0'),
  /** The last commit of the learner's history: the one that hands them the ticket */
  history: z.object({ head: z.object({ message: z.string().min(3).max(200), author: Person, date: z.iso.datetime({ offset: true }) }) }).optional(),
  stacks: z.record(Id, ProblemStack).refine((stacks) => Object.keys(stacks).length > 0, 'at least one stack'),
  /** Files this problem adds to the learner tree: { "answer.sql": "{stack}/answer.sql" } (paths in the problem folder) */
  files: z.record(RelPath, z.string().min(1)).default({}),
  /** The hidden suite, in the problem folder (never shipped to learners) */
  hidden: RelPath,
  /** SQL problems: how results are compared */
  sql: z.object({ columns: z.array(z.string().min(1)).min(1), orderMatters: z.boolean().default(true) }).optional(),
});
export type ProblemSpec = z.infer<typeof ProblemSpec>;

/** How the grader builds and runs a stack (.reneplane/grade.yaml in the stack; never shipped to learners) */
const ALLOWED_IMAGES = [/^node:[\w.-]+$/, /^python:[\w.-]+$/, /^eclipse-temurin:[\w.-]+$/, /^maven:[\w.-]+$/, /^mcr\.microsoft\.com\/dotnet\/sdk:[\w.-]+$/];
const Image = z.string().refine((image) => ALLOWED_IMAGES.some((pattern) => pattern.test(image)), 'an image from the allow-list (node, python, eclipse-temurin, maven, dotnet/sdk)');
const Step = z.object({ name: z.string().min(1), image: z.string().min(1), cwd: RelPath.optional(), run: z.string().min(1) });
const GradeService = z.object({ image: z.string().min(1), cwd: RelPath.optional(), run: z.string().min(1), ready: z.string().url() });

export const StackGradeSpec = z
  .object({
    images: z.record(z.string(), Image),
    tools: z.array(z.enum(['uv'])).default([]),
    env: z.record(z.string(), z.string()).default({}),
    prepare: z.array(Step).default([]),
    build: z.array(Step).default([]),
    migrate: z.object({ image: z.string(), cwd: RelPath.optional(), run: z.string(), applied: z.string() }).optional(),
    services: z.partialRecord(z.enum(['backend', 'frontend']), GradeService).default({}),
  })
  .superRefine((spec, context) => {
    const images = new Set(Object.keys(spec.images));
    const steps = [...spec.prepare, ...spec.build, ...(spec.migrate ? [spec.migrate] : []), ...Object.values(spec.services)];
    for (const step of steps) if (!images.has(step.image)) context.addIssue({ code: 'custom', path: ['images'], message: `"${step.image}" is used but not defined under images` });
  });
export type StackGradeSpec = z.infer<typeof StackGradeSpec>;

// ---- loading -------------------------------------------------------------------------------------

export class SpecError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
  }
}

function readYaml(root: string, file: string): unknown {
  const path = join(root, ...file.split('/'));
  if (!existsSync(path)) throw new SpecError(file, 'missing');
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SpecError(file, `not valid YAML (${(error as Error).message.split('\n')[0]})`);
  }
}

function check<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new SpecError(file, `${issue.path.join('.') || '(top)'}: ${issue.message}`);
}

export interface LoadedProblem {
  spec: ProblemSpec;
  /** problems/<ID> */
  dir: string;
}

export interface LoadedCodebank {
  root: string;
  spec: CodebankSpec;
  problems: LoadedProblem[];
}

export function loadCodebank(root: string): LoadedCodebank {
  const spec = check(CodebankSpec, readYaml(root, 'codebank.yaml'), 'codebank.yaml');
  const problems: LoadedProblem[] = [];
  const problemsDir = join(root, 'problems');
  for (const name of existsSync(problemsDir) ? readdirSync(problemsDir).sort() : []) {
    const file = `problems/${name}/problem.yaml`;
    if (!existsSync(join(root, file))) continue;
    const problem = check(ProblemSpec, readYaml(root, file), file);
    if (problem.id !== name) throw new SpecError(file, `id ${problem.id} must match its folder (${name})`);
    for (const stack of Object.keys(problem.stacks)) {
      if (!spec.stacks[stack]) throw new SpecError(file, `stacks.${stack}: no such stack in codebank.yaml`);
    }
    if (problem.kind === 'sql' && !problem.sql) throw new SpecError(file, 'a SQL problem needs sql.columns');
    problems.push({ spec: problem, dir: `problems/${name}` });
  }
  return { root, spec, problems };
}

export function loadStackGrade(root: string, stack: string): StackGradeSpec | null {
  const file = `stacks/${stack}/.reneplane/grade.yaml`;
  if (!existsSync(join(root, ...file.split('/')))) return null;
  return check(StackGradeSpec, readYaml(root, file), file);
}
