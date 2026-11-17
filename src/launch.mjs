// The stable entry point. Start-at-login always runs `node launch.mjs …`; this picks the installed
// version named in current.json, so an update can install beside the running one and take over on
// the next restart (Windows can't replace files that are in use).
//
//   ~/.reneplane/bin/
//     node(.exe)            the Node runtime the agent runs on
//     launch.mjs            this file
//     current.json          { "version": "0.2.0" }
//     app-0.2.0/agent.mjs   each installed version
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let version = null;
try {
  version = JSON.parse(readFileSync(join(here, 'current.json'), 'utf8')).version;
} catch {
  // a development build runs straight from dist/
}
const candidates = [version && join(here, `app-${version}`, 'agent.mjs'), join(here, 'app', 'agent.mjs')].filter(Boolean);
const agent = candidates.find((path) => existsSync(path));
if (!agent) {
  console.error('Reneplane Local is not installed correctly. Run the install command from the workspace again.');
  process.exit(1);
}
await import(pathToFileURL(agent).href);
