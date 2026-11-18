import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PATHS } from '../config.js';
import { AgentError, type Codebank } from '../protocol.js';
import { downloadVerified, unpack } from '../runtimes/download.js';
import type { Git } from './git.js';

/**
 * Where a mission's files come from. The mission never cares which: after `materialise` it works on a
 * git working tree and reads everything that must not be tampered with (workspace.yaml, the seed, the
 * schema) from `baseRef`, the commit the learner started at.
 *
 *   GithubSource   a public codebank repo at a pinned tag (Reneplane Local ≤ 0.2; kept until cutover)
 *   BundleSource   a starter bundle from the engine: manifest.json + repo.bundle (curated history,
 *                  ending at the tag reneplane-start) + workspace.yaml, checked against its sha256
 */
export interface MissionSource {
  /** What this attempt was opened from; a saved attempt can't silently switch to something else */
  readonly key: string;
  /** The learner's starting commit: diffs, "original" files and workspace.yaml are read here */
  readonly baseRef: string;
  /** workspace.yaml's text before the working tree exists (candidates in order of preference) */
  workspaceText(candidates: string[]): Promise<string>;
  /** Create the working tree (git.cwd) on `branch`, at baseRef */
  materialise(git: Git, branch: string): Promise<void>;
  /** What the SQL Server pool needs to find this mission's template */
  leaseTemplate(templatePath: string): LeaseTemplate;
  /** The SQL Server template script, when the source carries it outside the repo (compiled bundles) */
  template?(): Promise<string | null>;
}

export type LeaseTemplate =
  | { codebank: { repo: string; ref: string; template: string } }
  /** Signed by the engine: the pool fetches the template text itself and checks its sha256 */
  | { templateRef: string };

export class GithubSource implements MissionSource {
  readonly key: string;
  readonly baseRef: string;

  constructor(
    private readonly codebank: Codebank,
    /** Dev only: read reneplane/codebank-x from <dir>/codebank-x instead of GitHub */
    private readonly localDir?: string,
  ) {
    this.key = `github:${codebank.repo}@${codebank.ref}`;
    this.baseRef = codebank.ref;
  }

  private get localRepo(): string | null {
    // Absolute: git runs from a temp folder, where a relative path would point nowhere
    return this.localDir ? resolve(this.localDir, this.codebank.repo.split('/')[1]!) : null;
  }

  async workspaceText(candidates: string[]): Promise<string> {
    const { repo, ref } = this.codebank;
    for (const path of candidates) {
      if (this.localRepo) {
        const file = join(this.localRepo, ...path.split('/'));
        if (existsSync(file)) return readFileSync(file, 'utf8');
        continue;
      }
      const response = await fetch(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${path}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response.text();
      if (response.status !== 404) throw new AgentError('failed', `Couldn't read ${repo}@${ref} (${response.status}). Check your internet connection.`);
    }
    throw new AgentError('failed', `${repo}@${ref} has no workspace file for this mission`);
  }

  async materialise(git: Git, branch: string): Promise<void> {
    await git.clone(this.localRepo ?? `https://github.com/${this.codebank.repo}.git`, this.codebank.ref, branch);
  }

  leaseTemplate(templatePath: string): LeaseTemplate {
    return { codebank: { ...this.codebank, template: templatePath } };
  }
}

// ---- starter bundles ---------------------------------------------------------------------------------

/** manifest.json inside a starter bundle (written by `reneplane-local codebank compile`) */
export const BundleManifest = z.object({
  format: z.literal(1),
  codebank: z.string(),
  release: z.string(),
  problem: z.string(),
  variant: z.string(),
  kind: z.enum(['app', 'sql']),
  /** The learner's branch, checked out at the tag reneplane-start */
  branch: z.string(),
  /** The commit reneplane-start points at */
  startCommit: z.string().regex(/^[0-9a-f]{40}$/),
  requires: z.array(z.string()).default([]),
  minAgentVersion: z.string().default('0.0.0'),
});
export type BundleManifest = z.infer<typeof BundleManifest>;

export interface BundleRef {
  url: string;
  sha256: string;
}

export interface BundleSourceOptions {
  /** Unpacked bundle goes here (the session folder's bundle/) */
  dir: string;
  /** Allow file:// URLs and any host (dev agents and `codebank check` only) */
  dev: boolean;
  /** Hosts a production agent may download bundles from */
  allowedHosts: string[];
  templateRef?: string;
  onProgress?: (detail: string) => void;
}

export const START_TAG = 'reneplane-start';

export class BundleSource implements MissionSource {
  readonly key: string;
  readonly baseRef = START_TAG;
  private manifestCache: BundleManifest | null = null;

  constructor(
    private readonly bundle: BundleRef,
    private readonly options: BundleSourceOptions,
  ) {
    if (!/^[0-9a-f]{64}$/.test(bundle.sha256)) throw new AgentError('bad_request', 'The starter bundle has no valid sha256');
    this.key = `bundle:${bundle.sha256}`;
    checkBundleUrl(bundle.url, options);
  }

  /** Download (once, cached by sha256), verify and unpack */
  async ensure(): Promise<BundleManifest> {
    if (this.manifestCache) return this.manifestCache;
    const { dir } = this.options;
    if (!existsSync(join(dir, 'manifest.json'))) {
      const cached = join(PATHS.bundles, `${this.bundle.sha256}.tar.gz`);
      await fetchBundle(this.bundle, cached, this.options.onProgress);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dirname(dir), { recursive: true });
      await unpack(cached, dir, 'tar');
    }
    const manifest = BundleManifest.safeParse(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
    if (!manifest.success) throw new AgentError('failed', `The starter bundle's manifest is invalid: ${manifest.error.issues[0]?.message}`);
    this.manifestCache = manifest.data;
    return manifest.data;
  }

  async workspaceText(): Promise<string> {
    await this.ensure();
    return readFileSync(join(this.options.dir, 'workspace.yaml'), 'utf8');
  }

  async materialise(git: Git, branch: string): Promise<void> {
    const manifest = await this.ensure();
    await git.cloneBundle(join(this.options.dir, 'repo.bundle'), START_TAG, branch || manifest.branch, manifest.startCommit);
  }

  leaseTemplate(): LeaseTemplate {
    if (!this.options.templateRef) throw new AgentError('database_unavailable', 'This session has no SQL Server template reference');
    return { templateRef: this.options.templateRef };
  }

  async template(): Promise<string | null> {
    await this.ensure();
    const file = join(this.options.dir, 'template.sql');
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
}

function checkBundleUrl(url: string, options: Pick<BundleSourceOptions, 'dev' | 'allowedHosts'>): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AgentError('bad_request', 'The starter bundle URL is invalid');
  }
  if (parsed.protocol === 'file:' && options.dev) return;
  if (parsed.protocol === 'http:' && options.dev && ['localhost', '127.0.0.1'].includes(parsed.hostname)) return;
  if (parsed.protocol !== 'https:' || !options.allowedHosts.includes(parsed.hostname)) {
    throw new AgentError('bad_request', `Starter bundles only come from Reneplane (refused ${parsed.host || parsed.protocol})`);
  }
}

async function fetchBundle(bundle: BundleRef, destination: string, onProgress?: (detail: string) => void): Promise<void> {
  if (bundle.url.startsWith('file:')) {
    const source = fileURLToPath(bundle.url);
    const actual = createHash('sha256').update(readFileSync(source)).digest('hex');
    if (actual !== bundle.sha256) throw new AgentError('failed', `The starter bundle's checksum doesn't match (expected ${bundle.sha256}, got ${actual})`);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    return;
  }
  await downloadVerified(bundle.url, { algorithm: 'sha256', value: bundle.sha256 }, destination, onProgress);
}
