import { describe, expect, it } from 'vitest';
import { isAllowedHost, isAllowedOrigin, sameHash, sha256 } from '../src/security.js';

const production = { dev: false, allowPreviewOrigins: false };

describe('Origin allow-list', () => {
  it('accepts only the workspace in production', () => {
    expect(isAllowedOrigin('https://workspace.reneplane.com', production)).toBe(true);
    expect(isAllowedOrigin('https://evil.example', production)).toBe(false);
    expect(isAllowedOrigin('https://workspace.reneplane.com.evil.example', production)).toBe(false);
    expect(isAllowedOrigin('http://workspace.reneplane.com', production)).toBe(false);
    expect(isAllowedOrigin(undefined, production)).toBe(false);
    expect(isAllowedOrigin('null', production)).toBe(false);
  });

  it('accepts the local dev server only with --dev', () => {
    expect(isAllowedOrigin('http://localhost:5175', production)).toBe(false);
    expect(isAllowedOrigin('http://localhost:5175', { dev: true, allowPreviewOrigins: false })).toBe(true);
    expect(isAllowedOrigin('http://localhost:3000', { dev: true, allowPreviewOrigins: false })).toBe(false);
  });

  it('accepts Pages previews only when the tester setting is on', () => {
    const preview = 'https://abc123.reneplane-workspace.pages.dev';
    expect(isAllowedOrigin(preview, production)).toBe(false);
    expect(isAllowedOrigin(preview, { dev: false, allowPreviewOrigins: true })).toBe(true);
    expect(isAllowedOrigin('https://abc.other-project.pages.dev', { dev: false, allowPreviewOrigins: true })).toBe(false);
    expect(isAllowedOrigin('https://x.reneplane-workspace.pages.dev.evil.example', { dev: false, allowPreviewOrigins: true })).toBe(false);
  });
});

describe('Host check (DNS rebinding)', () => {
  it('accepts only loopback names on our port', () => {
    expect(isAllowedHost('127.0.0.1:47811', 47811)).toBe(true);
    expect(isAllowedHost('localhost:47811', 47811)).toBe(true);
    expect(isAllowedHost('attacker.example:47811', 47811)).toBe(false);
    expect(isAllowedHost('127.0.0.1:47812', 47811)).toBe(false);
    expect(isAllowedHost(undefined, 47811)).toBe(false);
  });
});

describe('sameHash', () => {
  it('compares digests in constant time', () => {
    expect(sameHash(sha256('a'), sha256('a'))).toBe(true);
    expect(sameHash(sha256('a'), sha256('b'))).toBe(false);
    expect(sameHash('', '')).toBe(false);
  });
});
