import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { problemCommits } from './repo.js';
import { gitFor } from './repo.js';
import { loadCodebank } from './spec.js';

/**
 * Starting points. `codebank init` copies a minimal healthy product per stack (a small "Notes" app with
 * one example problem) from templates/, so a new codebank passes `codebank check` from its first
 * commit and an author only replaces the product. `problem new` writes a problem.yaml for a commit.
 */

/** templates/ next to the bundled agent (release zip) or at the repo root (running from source) */
export function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'templates'), join(here, '..', 'templates'), join(here, '..', '..', 'templates')]) {
    if (existsSync(join(candidate, 'codebank'))) return candidate;
  }
  throw new Error('The codebank templates are missing from this installation');
}

export function availableTemplates(): string[] {
  const stacks = join(templatesDir(), 'stacks');
  return existsSync(stacks) ? readdirSync(stacks, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
}

export function initCodebank(target: string, name: string, stacks: string[]): void {
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} isn't empty`);
  const templates = templatesDir();
  const known = availableTemplates();
  const unknown = stacks.filter((stack) => !known.includes(stack));
  if (unknown.length) throw new Error(`No template for ${unknown.join(', ')}. Templates: ${known.join(', ')}`);
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  mkdirSync(target, { recursive: true });
  cpSync(join(templates, 'codebank'), target, { recursive: true });
  for (const stack of stacks) cpSync(join(templates, 'stacks', stack), join(target, 'stacks', stack), { recursive: true });

  // codebank.yaml lists the chosen stacks, each described by its template's stack.yaml
  const stackEntries = Object.fromEntries(stacks.map((stack) => [stack, JSON.parse(readFileSync(join(templates, 'stacks', stack, '..', `${stack}.json`), 'utf8')) as unknown]));
  const spec = { format: 1, id, name, description: `${name}, a Reneplane codebank`, stacks: stackEntries, mounts: { frontend: 'shared/frontend' }, seed: 'shared/seed/seed.json' };
  writeFileSync(join(target, 'codebank.yaml'), `# ${name}: see docs/CODEBANK.md in reneplane-sandbox-agent for every field\n${stringify(spec)}`);

  // The example problem covers exactly the chosen stacks
  const problemFile = join(target, 'problems', 'NOTE-1', 'problem.yaml');
  if (existsSync(problemFile)) {
    const text = readFileSync(problemFile, 'utf8');
    const kept = text.replace(/^stacks:\n([\s\S]*?)(?=^\S)/m, (block) =>
      block
        .split(/\n(?=  \S)/)
        .filter((entry, index) => index === 0 || stacks.some((stack) => entry.trimStart().startsWith(`${stack}:`)))
        .join('\n'),
    );
    writeFileSync(problemFile, kept);
  }
}

export async function newProblem(root: string, id: string, sha: string): Promise<string> {
  const codebank = loadCodebank(root);
  const git = await gitFor(root);
  const commits = await problemCommits(git, id);
  const full = (await git.run(['rev-parse', sha])).trim();
  if (!commits.some((commit) => commit.sha === full)) {
    throw new Error(`Commit ${sha} has no "Reneplane-Problem: ${id}" trailer. Add it to the squashed commit's message (last paragraph) and try again.`);
  }
  const commit = commits.find((candidate) => candidate.sha === full)!;
  const dir = join(root, 'problems', id);
  const file = join(dir, 'problem.yaml');
  if (existsSync(file)) throw new Error(`${file} exists already`);
  mkdirSync(join(dir, 'hidden'), { recursive: true });
  const changed = (await git.run(['show', '--name-only', '--format=', full])).split('\n').filter(Boolean);
  const stacks = Object.keys(codebank.spec.stacks).filter((stack) => changed.some((path) => path.startsWith(`stacks/${stack}/`)));
  const problem = {
    id,
    slug: `${id.toLowerCase()}-${commit.subject.toLowerCase().replace(/^[a-z]+(\([^)]*\))?:\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`,
    kind: 'app',
    type: commit.type ?? 'bug',
    title: commit.subject.replace(/^[a-z]+(\([^)]*\))?:\s*/, ''),
    difficulty: 'medium',
    skills: [],
    brief: 'brief.md',
    branch: `${commit.type === 'feature' ? 'feature' : 'bug'}/${id.toLowerCase()}`,
    hidden: 'hidden/behaviours.mjs',
    stacks: Object.fromEntries(stacks.map((stack) => [stack, { allow: ['backend/**', 'frontend/src/**'] }])),
  };
  writeFileSync(file, `# ${id}: generated from ${full.slice(0, 7)}; review every field (docs/CODEBANK.md)\n${stringify(problem)}`);
  writeFileSync(join(dir, 'brief.md'), `# ${problem.title}\n\nWhat the learner reads: the ticket, as a teammate would write it.\n`);
  return file;
}
