// Bundles the agent into dist/app/agent.mjs (one file), next to the only native dependency it needs
// (node-pty for this platform), plus the launcher. Run: npm run build
//
// dist/
//   launch.mjs                       stable entry point: runs the version named in current.json
//   app/agent.mjs                    the agent, bundled
//   app/node_modules/@lydell/…       node-pty and its prebuilt binary for this platform

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = process.env.AGENT_VERSION ?? pkg.version;
const out = 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'app'), { recursive: true });

await build({
  entryPoints: ['src/main.ts'],
  outfile: join(out, 'app', 'agent.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Native or optional modules stay outside the bundle
  external: ['@lydell/node-pty', 'pg-native', 'bufferutil', 'utf-8-validate'],
  define: { __AGENT_VERSION__: JSON.stringify(version) },
  // Some dependencies are CommonJS and call require(); give the ESM bundle a require
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

// node-pty: the JS package and this platform's prebuilt binary
const platformPackage = `node-pty-${process.platform}-${process.arch}`;
for (const name of ['node-pty', platformPackage]) {
  const source = join('node_modules', '@lydell', name);
  if (!existsSync(source)) throw new Error(`Missing ${source}: run npm install on ${process.platform}-${process.arch}`);
  cpSync(source, join(out, 'app', 'node_modules', '@lydell', name), { recursive: true });
}

// Codebank templates for `reneplane-local codebank init`
if (existsSync('templates')) cpSync('templates', join(out, 'app', 'templates'), { recursive: true });

cpSync('src/launch.mjs', join(out, 'launch.mjs'));
writeFileSync(join(out, 'app', 'VERSION'), version);
console.log(`Built Reneplane Local ${version} for ${process.platform}-${process.arch} into ${out}/`);
