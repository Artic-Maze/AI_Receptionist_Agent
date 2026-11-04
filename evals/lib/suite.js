import { ClaudeClient } from '../../src/agent/llm.js';
import { config } from '../../src/config.js';
import { Judge } from '../judge.js';
import { CATEGORIES, GUARDS, assertPlannedCoverage, loadScenarios } from './scenarios.js';
import { effectiveExpect } from './checks.js';
import { createTestPrisma, migrateTestDatabase } from './db.js';
import { runScenario } from './run-scenario.js';

/**
 * Runs the selected scenarios and summarises them.
 *
 * @param {object} options
 * @param {'scripted'|'claude'} options.mode
 * @param {number} [options.runs]  repeats per scenario, to expose flakiness
 * @param {boolean} [options.core]  only the core set
 * @param {string[]} [options.only]  only these scenario ids
 * @param {string} [options.category]
 * @param {Set<string>} [options.disabledGuards]
 * @param {boolean} [options.judge]
 * @param {(line: string) => void} [options.log]
 */
export async function runSuite({
  mode,
  runs = 3,
  core = false,
  only,
  category,
  disabledGuards,
  judge = false,
  log = () => {},
}) {
  const all = await loadScenarios();
  assertPlannedCoverage(all);
  const scenarios = all.filter(
    (s) => (!core || s.core) && (!only?.length || only.includes(s.id)) && (!category || s.category === category),
  );
  if (!scenarios.length) throw new Error('No scenarios match that selection');

  const tz = 'Asia/Dhaka';
  await migrateTestDatabase();
  const prisma = createTestPrisma();
  // 'error': a harness bug that edits replayed history should fail the run, not degrade it.
  const client = mode === 'claude' ? new ClaudeClient({ ...config.llm, prefixMismatch: 'error' }) : undefined;
  const judgeClient = judge && mode === 'claude' ? new Judge({ model: config.judgeModel }) : null;

  const results = [];
  try {
    for (const scenario of scenarios) {
      const scenarioRuns = [];
      for (let i = 0; i < runs; i += 1) {
        const run = await runScenario(scenario, { prisma, mode, client, disabledGuards, tz });
        if (run.fatal) {
          throw new Error(`Stopping: the API rejected a request (${run.fatal.status}): ${run.fatal.message}`);
        }
        scenarioRuns.push(run);
      }
      const passes = scenarioRuns.filter((r) => r.pass).length;
      const expect = effectiveExpect(scenario, mode);
      const judged = judgeClient ? await judgeClient.score(scenario, scenarioRuns[0].turns) : null;
      results.push({
        id: scenario.id,
        category: scenario.category,
        language: scenario.language,
        channel: scenario.channel,
        description: scenario.description,
        core: scenario.core,
        expectedGuards: expect.guards_fired ?? [],
        expectedCalendar: expect.final_calendar ?? null,
        passes,
        runs: scenarioRuns.length,
        pass: passes === scenarioRuns.length,
        flaky: passes > 0 && passes < scenarioRuns.length,
        judge: judged,
        attempts: scenarioRuns,
      });
      log(`${passes === scenarioRuns.length ? 'PASS' : 'FAIL'}  ${String(passes)}/${scenarioRuns.length}  ${scenario.id}`);
    }
  } finally {
    await prisma.$disconnect();
  }
  return summarize({ results, mode, runs, disabledGuards });
}

function summarize({ results, mode, runs, disabledGuards }) {
  const attempts = results.flatMap((r) => r.attempts);
  const passedAttempts = attempts.filter((a) => a.pass).length;

  const categories = Object.entries(CATEGORIES)
    .map(([key, { label, critical }]) => {
      const group = results.filter((r) => r.category === key);
      return {
        key,
        label,
        critical,
        scenarios: group.length,
        passed: group.filter((r) => r.pass).length,
        attemptsPassed: group.reduce((sum, r) => sum + r.passes, 0),
        attempts: group.reduce((sum, r) => sum + r.runs, 0),
      };
    })
    .filter((c) => c.scenarios > 0);

  const guards = GUARDS.map((guard) => {
    let expected = 0;
    let caught = 0;
    let firedElsewhere = 0;
    for (const result of results) {
      for (const attempt of result.attempts) {
        const fired = attempt.turns.some((t) => t.guards.some((g) => g.guard === guard && g.ok === false));
        if (result.expectedGuards.includes(guard)) {
          expected += 1;
          if (fired) caught += 1;
        } else if (fired) {
          firedElsewhere += 1;
        }
      }
    }
    return { guard, expected, caught, firedElsewhere };
  });

  const failedCritical = results.filter((r) => !r.pass && CATEGORIES[r.category].critical);
  const costs = attempts.map((a) => a.costUsd);
  const latencies = attempts.map((a) => a.latencyMs).sort((a, b) => a - b);

  return {
    generatedAt: new Date().toISOString(),
    mode,
    model: mode === 'claude' ? config.llm.model : 'scripted replay',
    runsPerScenario: runs,
    disabledGuards: [...(disabledGuards ?? [])],
    totals: {
      scenarios: results.length,
      scenariosPassed: results.filter((r) => r.pass).length,
      attempts: attempts.length,
      attemptsPassed: passedAttempts,
      flaky: results.filter((r) => r.flaky).length,
    },
    gate: {
      pass: failedCritical.length === 0,
      failed: failedCritical.map((r) => r.id),
    },
    categories,
    guards,
    cost: {
      totalUsd: costs.reduce((sum, c) => sum + c, 0),
      perScenarioUsd: results.length ? costs.reduce((sum, c) => sum + c, 0) / attempts.length : 0,
    },
    latency: {
      medianMs: latencies[Math.floor(latencies.length / 2)] ?? 0,
      maxMs: latencies.at(-1) ?? 0,
    },
    results,
  };
}

/** Scenarios that passed in the baseline and don't now. */
export function findRegressions(current, baseline) {
  if (!baseline || baseline.mode !== current.mode) return null;
  const before = new Map(baseline.results.map((r) => [r.id, r.pass]));
  return current.results.filter((r) => before.get(r.id) === true && !r.pass).map((r) => r.id);
}
