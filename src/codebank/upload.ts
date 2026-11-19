import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckReport } from './check.js';
import type { ReleaseManifest } from './compile.js';

/**
 * Talking to the engine from a codebank's CI (or a developer's laptop against `wrangler dev`):
 *
 *   report    a check report: the first one from a repo makes the codebank "detected" in admin
 *   upload    a compiled release: manifest, every bundle (checked by sha256 on arrival), complete
 *
 * In GitHub Actions the caller proves itself with an OIDC token (the workflow needs
 * `permissions: id-token: write`); locally, with the dev engine's DEV_TOKEN.
 */

export interface EngineTarget {
  url: string;
  /** OIDC audience: reneplane-engine (production) or reneplane-engine-staging */
  audience: string;
  devToken?: string;
}

async function credential(target: EngineTarget): Promise<string> {
  if (target.devToken) return target.devToken;
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error('No GitHub OIDC token here: run this in GitHub Actions with "permissions: id-token: write", or pass --dev-token for a local engine');
  }
  const url = new URL(requestUrl);
  url.searchParams.set('audience', target.audience);
  const response = await fetch(url, { headers: { authorization: `bearer ${requestToken}`, accept: 'application/json' } });
  if (!response.ok) throw new Error(`GitHub wouldn't issue an OIDC token (${response.status})`);
  return ((await response.json()) as { value: string }).value;
}

async function call<T>(target: EngineTarget, token: string, method: string, path: string, body?: unknown, raw?: Buffer): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(new URL(path, target.url), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(raw ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(120_000),
    }).catch((error: Error) => ({ ok: false, status: 0, text: async () => error.message, headers: new Headers() }) as unknown as Response);
    const text = await response.text();
    if (response.ok) return (text ? JSON.parse(text) : null) as T;
    // The engine says why, with a request id to look up in its logs
    const detail = (() => {
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string; reqId?: string };
        return `${parsed.error}: ${parsed.message}${parsed.reqId ? ` (request ${parsed.reqId})` : ''}`;
      } catch {
        return text.slice(0, 300);
      }
    })();
    if ((response.status === 0 || response.status >= 500) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
      continue;
    }
    throw new Error(`${method} ${path} → ${response.status} ${detail}`);
  }
}

export async function sendReport(target: EngineTarget, report: CheckReport, name?: string): Promise<{ codebank: string; status: string }> {
  const token = await credential(target);
  return call(target, token, 'POST', '/ci/reports', {
    codebank: report.codebank,
    name,
    ok: report.ok,
    level: report.level,
    summary: report.summary,
    results: report.results.map(({ id, title, status, detail }) => ({ id, title, status, ...(detail ? { detail: detail.slice(0, 1000) } : {}) })),
  });
}

export async function uploadRelease(target: EngineTarget, out: string, onProgress: (line: string) => void = () => undefined): Promise<{ releaseId: string; versions: string[] }> {
  const manifest = JSON.parse(readFileSync(join(out, 'release.json'), 'utf8')) as ReleaseManifest;
  const token = await credential(target);
  const { releaseId, upload } = await call<{ releaseId: string; upload: string[] }>(target, token, 'POST', '/ci/releases', manifest);
  onProgress(`release ${manifest.release}: ${upload.length} files to upload`);
  for (const path of upload) {
    const data = readFileSync(join(out, ...path.split('/')));
    await call(target, token, 'PUT', `/ci/releases/${releaseId}/files/${path.split('/').map(encodeURIComponent).join('/')}`, undefined, data);
    onProgress(`  uploaded ${path} (${Math.round(data.length / 1024)} KB)`);
  }
  const { versions } = await call<{ versions: string[] }>(target, token, 'POST', `/ci/releases/${releaseId}/complete`);
  onProgress(`release ${manifest.release} uploaded: ${versions.length} problem versions, now being verified by the grader`);
  return { releaseId, versions };
}
