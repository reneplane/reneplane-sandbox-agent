// Assembles the release archive for this platform from dist/ (run npm run build first):
//
//   reneplane-local-<platform>-<arch>.zip (Windows) or .tar.gz (macOS, Linux)
//     node(.exe)     the official Node 22 binary (signed by the OpenJS Foundation)
//     launch.mjs     the stable entry point
//     app/           the agent and node-pty for this platform
//
// The Node binary comes from the same pinned, checksummed download the agent uses for missions.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('src/runtimes/manifest.json', 'utf8'));
const platform = `${process.platform}-${process.arch}`;
const entry = manifest.node.platforms[platform];
if (!entry) throw new Error(`No Node build pinned for ${platform}`);
if (!existsSync('dist/app/agent.mjs')) throw new Error('Run npm run build first');

const work = join('release', 'work');
const stage = join('release', 'stage');
rmSync('release', { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(stage, { recursive: true });

// Node: download, verify, take just the binary
const archive = join(work, entry.url.split('/').pop());
const data = Buffer.from(await (await fetch(entry.url)).arrayBuffer());
const actual = createHash('sha256').update(data).digest('hex');
if (actual !== entry.sha256) throw new Error(`Node checksum mismatch: ${actual}`);
writeFileSync(archive, data);
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-xf', archive, '-C', work]);
const nodeFile = process.platform === 'win32' ? 'node.exe' : 'node';
const nodePath = process.platform === 'win32' ? join(work, entry.strip, 'node.exe') : join(work, entry.strip, 'bin', 'node');
cpSync(nodePath, join(stage, nodeFile));

cpSync('dist/launch.mjs', join(stage, 'launch.mjs'));
cpSync('dist/app', join(stage, 'app'), { recursive: true });
cpSync('LICENSE', join(stage, 'LICENSE'));

const name = `reneplane-local-${platform}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
const output = join('release', name);
if (process.platform === 'win32') execFileSync(tar, ['-a', '-cf', output, '-C', stage, '.']);
else execFileSync('tar', ['-czf', output, '-C', stage, '.']);

const sha = createHash('sha256').update(readFileSync(output)).digest('hex');
writeFileSync(`${output}.sha256`, `${sha}  ${name}\n`);
rmSync(work, { recursive: true, force: true });
rmSync(stage, { recursive: true, force: true });
console.log(`${name}  ${(readFileSync(output).length / 1024 / 1024).toFixed(1)} MB  ${sha}`);
