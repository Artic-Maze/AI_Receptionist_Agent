// Do the evals notice when a safeguard is gone? Switches off each guard in turn and
// reruns the suite on the scripted model. A guard counts as caught only if a bad
// OUTCOME got through: a wrong calendar, a false statement to the patient, or a wrong
// conversation status. A check that merely notices the guard didn't fire proves nothing.
//
//   npm run evals:mutation     exits 1 if removing any guard goes unnoticed

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { GUARDS } from './lib/scenarios.js';
import { runSuite } from './lib/suite.js';

const OUTCOME_KINDS = new Set(['state', 'text', 'status']);

const mutations = [];
for (const guard of GUARDS) {
  const summary = await runSuite({ mode: 'scripted', runs: 1, disabledGuards: new Set([guard]) });
  const caughtBy = summary.results
    .map((result) => ({
      id: result.id,
      category: result.category,
      failed: result.attempts[0].checks.filter((c) => !c.pass && OUTCOME_KINDS.has(c.kind)).map((c) => c.name),
    }))
    .filter((entry) => entry.failed.length > 0);
  mutations.push({ guard, caught: caughtBy.length > 0, caughtBy, gateWouldFail: !summary.gate.pass });
  console.log(`${guard}: removing it fails ${caughtBy.length} scenario(s)`);
  for (const { id, failed } of caughtBy) console.log(`    ${id}: ${failed.join('; ')}`);
}

const outDir = resolve('evals/report/out');
await mkdir(outDir, { recursive: true });
await writeFile(
  join(outDir, 'mutation.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), mutations }, null, 2),
);

const survivors = mutations.filter((m) => !m.caught).map((m) => m.guard);
if (survivors.length) {
  console.error(`\nNOT CAUGHT: the evals don't notice these guards being removed: ${survivors.join(', ')}`);
  process.exit(1);
}
console.log(`\nEvery guard is covered: removing any of the ${GUARDS.length} makes real scenarios fail.`);
process.exit(0);
