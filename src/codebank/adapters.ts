import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from './spec.js';

/**
 * What each kind of stack must have to run the same everywhere (the Reneplane contract): a pinned
 * runtime, locked dependencies, and no connection details in the code. Adding a stack kind means one
 * entry here, one template under templates/stacks/, and a pack (docs/ADDING-A-STACK.md).
 */

export interface StackRule {
  /** Shown in the report: "pinned runtime", "locked dependencies" */
  rule: string;
  /** Learner paths, any of which satisfies the rule */
  anyOf: string[];
  /** Or: any file in the tree matching this (lockfiles that sit next to each project) */
  find?: RegExp;
  /** Optional: a check on the file's content */
  content?: (text: string) => string | null;
}

export interface StackAdapter {
  rules: StackRule[];
  /** Source files where hard-coded connection details are looked for */
  sources: RegExp;
}

const HARDCODED_URL = /(postgres(ql)?|mysql|jdbc:[a-z]+|mongodb):\/\/[^\s'"`{}$]*@?(localhost|127\.0\.0\.1)[:/]\d+/i;
const HARDCODED_SQLSERVER = /Server=(tcp:)?(localhost|127\.0\.0\.1|\(local\))/i;
const TRUST_CERT = /TrustServerCertificate\s*=\s*(true|yes)/i;

/** A hard-coded connection or port in one line of source, or null */
export function hardcodedConfig(line: string): string | null {
  if (HARDCODED_URL.test(line)) return 'a connection URL with a fixed host and port (read it from the environment)';
  if (HARDCODED_SQLSERVER.test(line)) return 'a SQL Server connection string with a fixed host (read it from the environment)';
  if (TRUST_CERT.test(line)) return 'TrustServerCertificate=true (learners connect to the pool with full certificate checks)';
  return null;
}

export const ADAPTERS: Record<Adapter, StackAdapter> = {
  node: {
    rules: [
      { rule: 'pinned Node version', anyOf: ['.nvmrc', 'backend/.nvmrc'], content: (text) => (/^v?22(\.|$)/.test(text.trim()) ? null : `.nvmrc says ${text.trim()}; the node22 pack runs Node 22`) },
      { rule: 'locked dependencies', anyOf: ['package-lock.json', 'backend/package-lock.json'] },
    ],
    sources: /\.(ts|js|mjs|cjs)$/,
  },
  python: {
    rules: [
      { rule: 'pinned Python version', anyOf: ['backend/.python-version', '.python-version'], content: (text) => (text.trim().startsWith('3.12') ? null : `.python-version says ${text.trim()}; the python312-uv pack runs 3.12`) },
      { rule: 'locked dependencies', anyOf: ['backend/uv.lock', 'uv.lock'] },
    ],
    sources: /\.py$/,
  },
  'java-maven': {
    rules: [
      { rule: 'Java version in pom.xml', anyOf: ['backend/pom.xml', 'pom.xml'], content: (text) => (/<(java\.version|maven\.compiler\.release)>21</.test(text) ? null : 'pom.xml must set <java.version>21</java.version> (the jdk21-maven pack)') },
      { rule: 'Maven wrapper', anyOf: ['backend/mvnw', 'mvnw'] },
    ],
    sources: /\.(java|kt|properties|ya?ml)$/,
  },
  dotnet: {
    rules: [
      {
        rule: 'pinned SDK (global.json)',
        anyOf: ['backend/global.json', 'global.json'],
        content: (text) => {
          try {
            const sdk = (JSON.parse(text) as { sdk?: { version?: string; rollForward?: string } }).sdk;
            if (!sdk?.version?.startsWith('10.')) return 'global.json must pin a .NET 10 SDK (the dotnet10 pack)';
            if (sdk.rollForward !== 'latestFeature') return 'global.json needs "rollForward": "latestFeature", so a newer 10.0 SDK in the pack still builds it';
            return null;
          } catch {
            return 'global.json is not valid JSON';
          }
        },
      },
      { rule: 'locked dependencies (RestorePackagesWithLockFile)', anyOf: [], find: /(^|\/)packages\.lock\.json$/ },
    ],
    sources: /\.(cs|json)$/,
  },
  sql: { rules: [], sources: /\.sql$/ },
};

/** Check a stack's learner tree against its adapter's rules; returns problems found */
export function checkRules(adapter: Adapter, tree: string, findFiles: (pattern: RegExp) => string[]): string[] {
  const issues: string[] = [];
  for (const rule of ADAPTERS[adapter].rules) {
    if (rule.find) {
      if (!findFiles(rule.find).length) issues.push(`${rule.rule}: no file matches ${rule.find}`);
      continue;
    }
    const found = rule.anyOf.find((path) => existsSync(join(tree, ...path.split('/'))));
    if (!found) {
      issues.push(`${rule.rule}: expected ${rule.anyOf.join(' or ')}`);
      continue;
    }
    const problem = rule.content?.(readFileSync(join(tree, ...found.split('/')), 'utf8'));
    if (problem) issues.push(`${rule.rule}: ${problem}`);
  }
  return issues;
}
