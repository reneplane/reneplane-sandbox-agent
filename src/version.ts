/** Replaced at build time by scripts/build.mjs; "dev" when running from source */
declare const __AGENT_VERSION__: string | undefined;

export const AGENT_VERSION: string = typeof __AGENT_VERSION__ === 'string' ? __AGENT_VERSION__ : '0.0.0-dev';
