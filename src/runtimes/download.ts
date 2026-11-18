import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzipSync } from 'fflate';
import { runFile } from '../util/process.js';

export interface Checksum {
  algorithm: 'sha256' | 'sha512';
  value: string;
}

/**
 * Download a file, checking its hash as it streams. Reports "12 of 48 MB". A dropped connection is
 * retried (three more tries, with a pause); a checksum mismatch never is.
 */
export async function downloadVerified(url: string, checksum: Checksum, destination: string, onProgress?: (detail: string) => void): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await downloadOnce(url, checksum, destination, onProgress);
    } catch (error) {
      if (attempt >= 4 || /Checksum mismatch|Download failed \(4\d\d\)/.test((error as Error).message)) throw error;
      onProgress?.(`Connection problem, retrying (${attempt} of 3)`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }
}

async function downloadOnce(url: string, checksum: Checksum, destination: string, onProgress?: (detail: string) => void): Promise<void> {
  if (existsSync(destination) && hashFile(destination, checksum.algorithm) === checksum.value) return;
  mkdirSync(dirname(destination), { recursive: true });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  const total = Number(response.headers.get('content-length') ?? 0);
  const hash = createHash(checksum.algorithm);
  let received = 0;
  let lastReport = 0;
  const partial = `${destination}.part`;
  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
  source.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    if (onProgress && Date.now() - lastReport > 300) {
      lastReport = Date.now();
      onProgress(total ? `${mb(received)} of ${mb(total)} MB` : `${mb(received)} MB`);
    }
  });
  await pipeline(source, createWriteStream(partial));
  const actual = hash.digest('hex');
  if (actual !== checksum.value) {
    rmSync(partial, { force: true });
    throw new Error(`Checksum mismatch for ${url}: expected ${checksum.value}, got ${actual}. The download was discarded.`);
  }
  renameSync(partial, destination);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

function hashFile(path: string, algorithm: Checksum['algorithm']): string {
  return createHash(algorithm).update(readFileSync(path)).digest('hex');
}

/** The OS's own tar: bsdtar on Windows 10+ and macOS (reads zip, gz, xz), GNU tar on Linux */
function systemTar(): string {
  if (process.platform === 'win32') return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (process.platform === 'darwin') return '/usr/bin/tar';
  return 'tar';
}

async function untar(archive: string, destination: string): Promise<void> {
  mkdirSync(destination, { recursive: true });
  const result = await runFile(systemTar(), ['-xf', archive, '-C', destination], { timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(`Could not unpack ${archive}: ${result.stderr.trim() || `tar exited ${result.code}`}`);
}

async function unzip(archive: string, destination: string): Promise<void> {
  if (process.platform !== 'linux') return untar(archive, destination);
  // GNU tar can't read zip files; these are small (jars), so unpack in memory
  const entries = unzipSync(readFileSync(archive));
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

export type ArchiveFormat = 'zip' | 'tar' | 'jar-txz';

/**
 * Unpack into `destination`. `strip` moves the contents of a single top-level folder up a level
 * (Node's archives have one). `jar-txz` is zonky's Postgres packaging: a jar holding one .txz.
 */
export async function unpack(archive: string, destination: string, format: ArchiveFormat, strip?: string): Promise<void> {
  const staging = `${destination}.unpacking`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    if (format === 'zip') await unzip(archive, staging);
    else if (format === 'tar') await untar(archive, staging);
    else {
      const entries = unzipSync(readFileSync(archive), { filter: (file) => file.name.endsWith('.txz') });
      const [name, data] = Object.entries(entries)[0] ?? [];
      if (!name || !data) throw new Error(`No .txz inside ${archive}`);
      const inner = join(staging, '..', `${name.split('/').pop()}`);
      writeFileSync(inner, data);
      await untar(inner, staging);
      rmSync(inner, { force: true });
    }
    const root = strip ? join(staging, strip) : staging;
    if (!existsSync(root)) throw new Error(`Expected ${strip} inside ${archive}`);
    rmSync(destination, { recursive: true, force: true });
    renameSync(root, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
