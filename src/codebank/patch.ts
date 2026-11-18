/**
 * Git patches, per file. The same rules as the grader (reneplane-grader/grade/lib/patch.mjs), so a
 * codebank checked here is graded the same way there: paths, globs and what counts as a safe path.
 */

export interface PatchFile {
  /** Old and new path (one entry unless renamed); null sides (/dev/null) left out */
  paths: string[];
  binary: boolean;
  symlink: boolean;
  submodule: boolean;
  text: string;
}

/** git's C-style quoting: "a/caf\303\251.ts" → a/café.ts */
export function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index]!;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = value[++index]!;
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(value.slice(index, index + 3), 8));
      index += 2;
    } else {
      bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(value: string): string | null {
  const path = unquote(value.replace(/\t.*$/, '').trim());
  if (path === '/dev/null') return null;
  return path.replace(/^[ab]\//, '');
}

function headerPaths(header: string): string[] {
  const rest = header.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const match = rest.match(/^("(?:[^"\\]|\\.)*")\s+(.*)$/);
    return match ? [stripPrefix(match[1]!), stripPrefix(match[2]!)].filter((path): path is string => path !== null) : [];
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) return [rest.slice(2, half)];
  return [];
}

function describe(lines: string[]): PatchFile {
  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  let binary = false;
  const modes: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('@@')) break;
    if (line.startsWith('--- ')) oldPath = stripPrefix(line.slice(4));
    else if (line.startsWith('+++ ')) newPath = stripPrefix(line.slice(4));
    else if (line.startsWith('rename from ') || line.startsWith('copy from ')) oldPath = unquote(line.replace(/^(rename|copy) from /, ''));
    else if (line.startsWith('rename to ') || line.startsWith('copy to ')) newPath = unquote(line.replace(/^(rename|copy) to /, ''));
    else if (/^(new file mode|deleted file mode|old mode|new mode) /.test(line)) modes.push(line.split(' ').pop()!);
    else if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) binary = true;
  }
  const named = [oldPath, newPath].filter((path): path is string => typeof path === 'string');
  const paths = [...new Set(named.length || oldPath === null || newPath === null ? named : headerPaths(lines[0]!))];
  return { paths, binary, symlink: modes.includes('120000'), submodule: modes.includes('160000'), text: lines.join('\n') };
}

/** One entry per file in the patch. Text before the first "diff --git" (a commit message) is dropped. */
export function splitPatch(text: string): PatchFile[] {
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = [line];
      sections.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return sections.map((lines) => {
    while (lines.length > 1 && lines.at(-1) === '') lines.pop();
    return describe(lines);
  });
}

export function joinPatch(files: PatchFile[]): string {
  return files.length ? `${files.map((file) => file.text).join('\n')}\n` : '';
}

/** A glob over forward-slash paths: ** spans folders, * and ? stay inside one */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** A relative, forward-slash path with no "..", "." or empty parts */
export function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '..' || part === '.' || part === '')
  );
}

/**
 * Move a patch's files to other paths: `map` returns the new path, or null to drop the file. Used to
 * turn a commit in the codebank (stacks/node-postgres/backend/x.ts, shared/frontend/y.tsx) into the
 * same change on one stack's learner tree (backend/x.ts, frontend/y.tsx). Needs a patch made with
 * --no-renames and plain paths (the structure check refuses paths git would quote).
 */
export function mapPatchPaths(patch: string, map: (path: string) => string | null): string {
  const kept: PatchFile[] = [];
  for (const file of splitPatch(patch)) {
    if (file.paths.length !== 1) throw new Error(`Can't move a patch section for ${file.paths.join(', ') || 'an unknown file'} (renames need --no-renames)`);
    const from = file.paths[0]!;
    if (file.text.split('\n', 1)[0]!.includes('"')) throw new Error(`${from}: paths that git quotes aren't supported in a codebank`);
    const to = map(from);
    if (to === null) continue;
    const lines = file.text.split('\n');
    let inHeader = true;
    const moved = lines.map((line, index) => {
      if (index === 0) return `diff --git a/${to} b/${to}`;
      if (!inHeader) return line;
      if (line.startsWith('@@') || line.startsWith('GIT binary patch')) {
        inHeader = false;
        return line;
      }
      if (line === `--- a/${from}`) return `--- a/${to}`;
      if (line === `+++ b/${from}`) return `+++ b/${to}`;
      return line;
    });
    kept.push({ ...file, paths: [to], text: moved.join('\n') });
  }
  return joinPatch(kept);
}
