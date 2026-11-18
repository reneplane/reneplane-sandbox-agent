import { gzipSync } from 'node:zlib';

/**
 * A minimal tar.gz writer for bundles: regular files only, in path order, owned by nobody, dated
 * 1970. The same files always give the same archive, so a bundle's sha256 only changes when its
 * content does. Every tar (GNU, bsdtar, Windows' tar.exe) reads ustar.
 */

export interface TarEntry {
  /** Forward slashes, relative */
  path: string;
  data: Buffer;
  executable?: boolean;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function header(path: string, size: number, executable: boolean): Buffer {
  const block = Buffer.alloc(512);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    // ustar splits long paths at a slash: prefix (155 bytes) + name (100 bytes)
    const cut = path.lastIndexOf('/', path.length - 1);
    const split = [...path].reduce((best, char, index) => (char === '/' && Buffer.byteLength(path.slice(index + 1)) <= 100 && index <= 155 ? index : best), -1);
    if (split < 0 || cut < 0) throw new Error(`Path too long for a bundle: ${path}`);
    prefix = path.slice(0, split);
    name = path.slice(split + 1);
  }
  block.write(name, 0, 100, 'utf8');
  block.write(executable ? '0000755\0' : '0000644\0', 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');
  block.write(octal(0, 8), 116, 8, 'ascii');
  block.write(octal(size, 12), 124, 12, 'ascii');
  block.write(octal(0, 12), 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write('0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

export function tarGz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  const seen = new Set<string>();
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (seen.has(entry.path)) throw new Error(`Duplicate path in a bundle: ${entry.path}`);
    seen.add(entry.path);
    parts.push(header(entry.path, entry.data.length, entry.executable ?? false), entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  // The gzip header's OS byte depends on how zlib was built; "unknown" keeps archives identical everywhere
  gz[9] = 255;
  return gz;
}
