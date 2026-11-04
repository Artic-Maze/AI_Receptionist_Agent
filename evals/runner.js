// Runs the golden dataset and writes the regression report.
//
//   npm run evals:offline         every scenario, scripted model, no API key or cost
//   npm run evals:core            15 core scenarios on the real model
//   npm run evals:live            all 46 on the real model, three runs each
//
// Options: --llm=scripted|claude  --runs=N  --core  --only=id,id  --category=name
//          --disable-guard=name   --no-judge  --out=dir  --baseline=file
//
// Exits 1 if the safety gate fails: any failure in double-booking, wrong-patient or
// hallucinated-availability. Other failures are reported without failing the build.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { findRegressions, runSuite } from './lib/suite.js';
import { renderReport, renderSummary } from './report/generate.js';

const { values: args } = parseArgs({
  options: {
    llm: { type: 'string', default: 'scripted' },
    runs: { type: 'string' },
    core: { type: 'boolean', default: false },
    only: { type: 'string' },
    category: { type: 'string' },
    'disable-guard': { type: 'string' },
    'no-judge': { type: 'boolean', default: false },
    out: { type: 'string', default: 'evals/report/out' },
    baseline: { type: 'string' },
  },
});

if (!['scripted', 'claude'].includes(args.llm)) {
  console.error(`Unknown --llm value: ${args.llm}`);
  process.exit(2);
}

if (args.llm === 'claude') {
  const hasKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!hasKey && !existsSync(join(homedir(), '.config', 'anthropic'))) {
    console.error('No Claude credentials found. Run `ant auth login`, or set ANTHROPIC_API_KEY.');
    process.exit(2);
  }
}

const outDir = resolve(args.out);
const resultsPath = join(outDir, 'results.json');

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// The previous run, or a file CI downloads, is what regressions are measured against.
const baseline = await readJson(args.baseline ? resolve(args.baseline) : resultsPath);

const summary = await runSuite({
  mode: args.llm,
  runs: args.runs ? Number(args.runs) : 3,
  core: args.core,
  only: args.only?.split(','),
  category: args.category,
  disabledGuards: args['disable-guard'] ? new Set(args['disable-guard'].split(',')) : undefined,
  judge: args.llm === 'claude' && !args['no-judge'],
  log: (line) => console.log(line),
});
summary.regressions = findRegressions(summary, baseline);
summary.mutation = await readJson(join(outDir, 'mutation.json'));

await mkdir(outDir, { recursive: true });
await writeFile(resultsPath, JSON.stringify(summary, null, 2));
await writeFile(join(outDir, 'index.html'), renderReport(summary));
await writeFile(join(outDir, 'summary.md'), renderSummary(summary));

console.log(`\n${renderSummary(summary)}`);
console.log(`\nReport: ${join(outDir, 'index.html')}`);
process.exit(summary.gate.pass ? 0 : 1);
