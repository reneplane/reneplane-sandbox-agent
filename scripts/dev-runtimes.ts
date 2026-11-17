// Dev helper: install runtimes into RENEPLANE_HOME and print where they landed.
//   RENEPLANE_HOME=~/.reneplane-dev npx tsx scripts/dev-runtimes.ts git node postgres
import { ensureRuntime, gitBinary, type RuntimeName } from '../src/runtimes/index.js';

const names = (process.argv.slice(2).length ? process.argv.slice(2) : ['git', 'node', 'postgres']) as RuntimeName[];
for (const name of names) {
  const started = Date.now();
  let last = '';
  const runtime = await ensureRuntime(name, (detail) => {
    if (detail !== last && !/MB$/.test(detail)) console.log(`${name}: ${detail}`);
    last = detail;
  });
  console.log(`${name} ${runtime.version} -> ${runtime.dir} (${Date.now() - started} ms)`);
  if (name === 'git') console.log('  binary', gitBinary(runtime));
}
