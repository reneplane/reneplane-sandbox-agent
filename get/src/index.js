// get.reneplane.com: the Reneplane Local installer service (Cloudflare Worker)
//
//   POST /install-tokens           from the workspace (CORS): a one-time install token, valid 30 minutes
//   GET  /local.ps1?t=<token>      the Windows installer with that token filled in
//   GET  /local?t=<token>          the macOS / Linux installer
//   POST /devices {token,…}        the agent redeems the token (once) for a signed device token
//
// Install tokens are stored only as SHA-256 hashes in KV, with a 30-minute expiry. A device token is
// "v1.<deviceId>.<issuedAt>.<hmac>", signed with DEVICE_TOKEN_SECRET; the SQL Server pool and the
// grader check the signature with the same secret, so no lookup is needed.

import windowsScript from '../../install/local.ps1';
import unixScript from '../../install/local.sh';

const TOKEN_TTL_SECONDS = 30 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/install-tokens' && request.method === 'POST') {
      if (!cors['access-control-allow-origin']) return json({ error: 'origin not allowed' }, 403);
      if (!(await allowed(env.INSTALL_LIMIT, clientIp(request)))) return json({ error: 'Too many requests. Try again in a minute.' }, 429, cors);
      const token = randomToken();
      await env.TOKENS.put(`tok:${await sha256(token)}`, JSON.stringify({ issuedAt: Date.now() }), { expirationTtl: TOKEN_TTL_SECONDS });
      return json({ token, expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString() }, 200, cors);
    }

    if ((url.pathname === '/local.ps1' || url.pathname === '/local') && request.method === 'GET') {
      if (!(await allowed(env.INSTALL_LIMIT, clientIp(request)))) return text('echo "Too many requests. Try again in a minute."', 429);
      const windows = url.pathname === '/local.ps1';
      const token = url.searchParams.get('t') ?? '';
      const known = TOKEN_PATTERN.test(token) && (await env.TOKENS.get(`tok:${await sha256(token)}`)) !== null;
      if (!known) return text(windows ? EXPIRED_PS1 : EXPIRED_SH);
      const script = (windows ? windowsScript : unixScript)
        .replaceAll('__RENEPLANE_TOKEN__', token)
        .replaceAll('__RENEPLANE_GET_URL__', url.origin)
        .replaceAll('__RENEPLANE_RELEASE_URL__', env.RELEASE_URL);
      return text(script);
    }

    if (url.pathname === '/devices' && request.method === 'POST') {
      if (!(await allowed(env.INSTALL_LIMIT, clientIp(request)))) return json({ error: 'Too many requests' }, 429);
      const body = await request.json().catch(() => ({}));
      const token = String(body.token ?? '');
      if (!TOKEN_PATTERN.test(token)) return json({ error: 'bad token' }, 400);
      const key = `tok:${await sha256(token)}`;
      if ((await env.TOKENS.get(key)) === null) return json({ error: 'This install link has expired or was already used' }, 410);
      await env.TOKENS.delete(key);
      const deviceId = crypto.randomUUID();
      const issuedAt = Math.floor(Date.now() / 1000);
      const payload = `v1.${deviceId}.${issuedAt}`;
      const deviceToken = `${payload}.${await hmac(env.DEVICE_TOKEN_SECRET, payload)}`;
      console.log(JSON.stringify({ event: 'device_registered', deviceId, platform: body.platform, arch: body.arch, version: body.version }));
      return json({ deviceId, deviceToken });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return text('Reneplane Local installer. Get your install command from https://workspace.reneplane.com (open a mission and choose "On your computer").\n');
    }
    return text('Not found\n', 404);
  },
};

const EXPIRED_PS1 = `Write-Host 'This Reneplane Local install link has expired (links last 30 minutes and work once).' -ForegroundColor Red
Write-Host 'Go back to the workspace and copy a fresh command.'
`;
const EXPIRED_SH = `#!/bin/sh
echo 'This Reneplane Local install link has expired (links last 30 minutes and work once).' >&2
echo 'Go back to the workspace and copy a fresh command.' >&2
exit 1
`;

function corsHeaders(origin, env) {
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim());
  const ok =
    origin &&
    (allowedOrigins.includes(origin) || /^https:\/\/[a-z0-9-]+\.reneplane-workspace\.pages\.dev$/.test(origin));
  return ok
    ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', vary: 'origin' }
    : {};
}

async function allowed(limiter, key) {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))));
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
