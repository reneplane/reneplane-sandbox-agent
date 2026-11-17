// Pins every runtime the agent can download: exact URL and SHA-256 per platform.
// Writes src/runtimes/manifest.json. Run: npm run pin-runtimes   (after changing a version below)
//
// The agent refuses any download whose hash doesn't match this file.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const NODE = '22.23.5';
const POSTGRES = '16.16.0';
const GIT = { version: '2.56.1', build: '238326e' };

const PLATFORMS = ['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64'];

async function text(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.text();
}

async function hashOf(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const hash = createHash('sha256');
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest('hex');
}

async function node() {
  const sums = await text(`https://nodejs.org/dist/v${NODE}/SHASUMS256.txt`);
  const file = {
    'win32-x64': `node-v${NODE}-win-x64.zip`,
    'linux-x64': `node-v${NODE}-linux-x64.tar.xz`,
    'darwin-arm64': `node-v${NODE}-darwin-arm64.tar.gz`,
    'darwin-x64': `node-v${NODE}-darwin-x64.tar.gz`,
  };
  const platforms = {};
  for (const platform of PLATFORMS) {
    const name = file[platform];
    const sha256 = sums.split('\n').find((line) => line.endsWith(`  ${name}`))?.split(/\s+/)[0];
    if (!sha256) throw new Error(`No checksum for ${name}`);
    platforms[platform] = {
      url: `https://nodejs.org/dist/v${NODE}/${name}`,
      sha256,
      format: name.endsWith('.zip') ? 'zip' : 'tar',
      strip: name.replace(/\.(zip|tar\.xz|tar\.gz)$/, ''),
    };
  }
  return { version: NODE, platforms };
}

async function postgres() {
  // zonky's embedded-postgres binaries: a jar (zip) holding one .txz per platform
  const artifact = { 'win32-x64': 'windows-amd64', 'linux-x64': 'linux-amd64', 'darwin-arm64': 'darwin-arm64v8', 'darwin-x64': 'darwin-amd64' };
  const inner = {
    'win32-x64': 'postgres-windows-x86_64.txz',
    'linux-x64': 'postgres-linux-x86_64.txz',
    'darwin-arm64': 'postgres-darwin-arm_64.txz',
    'darwin-x64': 'postgres-darwin-x86_64.txz',
  };
  const platforms = {};
  for (const platform of PLATFORMS) {
    const id = `embedded-postgres-binaries-${artifact[platform]}`;
    const url = `https://repo1.maven.org/maven2/io/zonky/test/postgres/${id}/${POSTGRES}/${id}-${POSTGRES}.jar`;
    platforms[platform] = { url, sha256: await hashOf(url), format: 'jar-txz', inner: inner[platform] };
    console.log('hashed', url);
  }
  return { version: POSTGRES.replace(/\.0$/, ''), platforms };
}

async function git() {
  const name = {
    'win32-x64': 'windows-x64',
    'linux-x64': 'ubuntu-x64',
    'darwin-arm64': 'macOS-arm64',
    'darwin-x64': 'macOS-x64',
  };
  const platforms = {};
  for (const platform of PLATFORMS) {
    const file = `dugite-native-v${GIT.version}-${GIT.build}-${name[platform]}.tar.gz`;
    const url = `https://github.com/desktop/dugite-native/releases/download/v${GIT.version}/${file}`;
    const sha256 = (await text(`${url}.sha256`)).trim().split(/\s+/)[0];
    platforms[platform] = { url, sha256, format: 'tar' };
  }
  return { version: GIT.version, platforms };
}

const manifest = { node: await node(), postgres: await postgres(), git: await git() };
writeFileSync(new URL('../src/runtimes/manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('wrote src/runtimes/manifest.json');
