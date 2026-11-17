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

const UV = '0.13.9';
const JAVA = { feature: 21, release: 'jdk-21.0.13+9' };
const MYSQL = '8.4.13';
const DOTNET_CHANNEL = '8.0';

async function uv() {
  const name = {
    'win32-x64': 'uv-x86_64-pc-windows-msvc.zip',
    'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz',
    'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz',
    'darwin-x64': 'uv-x86_64-apple-darwin.tar.gz',
  };
  const platforms = {};
  for (const platform of PLATFORMS) {
    const url = `https://github.com/astral-sh/uv/releases/download/${UV}/${name[platform]}`;
    const sha256 = (await text(`${url}.sha256`)).trim().split(/\s+/)[0];
    platforms[platform] = {
      url,
      sha256,
      format: platform.startsWith('win32') ? 'zip' : 'tar',
      ...(platform.startsWith('win32') ? {} : { strip: name[platform].replace('.tar.gz', '') }),
    };
  }
  return { version: UV, platforms };
}

async function java() {
  const query = { 'win32-x64': 'windows&architecture=x64', 'linux-x64': 'linux&architecture=x64', 'darwin-arm64': 'mac&architecture=aarch64', 'darwin-x64': 'mac&architecture=x64' };
  const platforms = {};
  for (const platform of PLATFORMS) {
    const assets = JSON.parse(await text(`https://api.adoptium.net/v3/assets/release_name/eclipse/${encodeURIComponent(JAVA.release)}?os=${query[platform]}&image_type=jdk`));
    const binary = assets.binaries.find((candidate) => candidate.image_type === 'jdk' && candidate.jvm_impl === 'hotspot');
    platforms[platform] = {
      url: binary.package.link,
      sha256: binary.package.checksum,
      format: platform.startsWith('win32') ? 'zip' : 'tar',
      strip: JAVA.release,
    };
  }
  return { version: JAVA.release.replace('jdk-', ''), platforms };
}

async function mysql() {
  // Oracle no longer builds MySQL 8.4 for Intel Macs; the agent says so instead of downloading
  const name = {
    'win32-x64': `mysql-${MYSQL}-winx64.zip`,
    'linux-x64': `mysql-${MYSQL}-linux-glibc2.28-x86_64-minimal.tar.xz`,
    'darwin-arm64': `mysql-${MYSQL}-macos15-arm64.tar.gz`,
  };
  const platforms = {};
  for (const [platform, file] of Object.entries(name)) {
    const url = `https://cdn.mysql.com/Downloads/MySQL-8.4/${file}`;
    platforms[platform] = { url, sha256: await hashOf(url), format: file.endsWith('.zip') ? 'zip' : 'tar', strip: file.replace(/\.(zip|tar\.xz|tar\.gz)$/, '') };
    console.log('hashed', url);
  }
  return { version: MYSQL, platforms };
}

async function dotnet() {
  const releases = JSON.parse(await text(`https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/${DOTNET_CHANNEL}/releases.json`));
  const sdk = releases.releases[0].sdk;
  const name = { 'win32-x64': 'dotnet-sdk-win-x64.zip', 'linux-x64': 'dotnet-sdk-linux-x64.tar.gz', 'darwin-arm64': 'dotnet-sdk-osx-arm64.tar.gz', 'darwin-x64': 'dotnet-sdk-osx-x64.tar.gz' };
  const platforms = {};
  for (const platform of PLATFORMS) {
    const file = sdk.files.find((candidate) => candidate.name === name[platform]);
    platforms[platform] = { url: file.url, sha512: file.hash.toLowerCase(), format: platform.startsWith('win32') ? 'zip' : 'tar' };
  }
  return { version: sdk.version, platforms };
}

const manifest = {
  node: await node(),
  postgres: await postgres(),
  git: await git(),
  uv: await uv(),
  java: await java(),
  mysql: await mysql(),
  dotnet: await dotnet(),
};
writeFileSync(new URL('../src/runtimes/manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('wrote src/runtimes/manifest.json');
