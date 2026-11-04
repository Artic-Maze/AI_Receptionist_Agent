import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderReport, renderSummary } from '../evals/report/generate.js';

function attempt(overrides = {}) {
  return {
    pass: true,
    checks: [{ kind: 'state', name: 'calendar.total_active', pass: true, expected: 0, actual: 0 }],
    turns: [{ user: 'Hello', reply: 'Hi there.', handedOff: false, guards: [] }],
    toolCalls: [],
    audit: [{ action: 'turn.completed' }],
    calendar: [],
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    id: 'sample-01',
    category: 'double_booking',
    language: 'en',
    description: 'A sample.',
    expectedCalendar: { total_active: 0 },
    expectedGuards: [],
    passes: 3,
    runs: 3,
    pass: true,
    flaky: false,
    judge: null,
    attempts: [attempt()],
    ...overrides,
  };
}

function summary(overrides = {}) {
  return {
    generatedAt: '2026-11-04T07:00:00.000Z',
    mode: 'claude',
    model: 'claude-opus-5-5',
    runsPerScenario: 3,
    disabledGuards: [],
    totals: { scenarios: 1, scenariosPassed: 1, attempts: 3, attemptsPassed: 3, flaky: 0 },
    gate: { pass: true, failed: [] },
    categories: [
      { key: 'double_booking', label: 'Double-booking', critical: true, scenarios: 1, passed: 1, attemptsPassed: 3, attempts: 3 },
    ],
    guards: [
      { guard: 'identity_gate', expected: 3, caught: 3, firedElsewhere: 0 },
      { guard: 'booking_verify', expected: 0, caught: 0, firedElsewhere: 0 },
      { guard: 'availability_grounding', expected: 0, caught: 0, firedElsewhere: 0 },
      { guard: 'confirmation_check', expected: 0, caught: 0, firedElsewhere: 0 },
      { guard: 'handoff_triggers', expected: 0, caught: 0, firedElsewhere: 0 },
    ],
    cost: { totalUsd: 0.5, perScenarioUsd: 0.17 },
    latency: { medianMs: 2400, maxMs: 9000 },
    regressions: [],
    mutation: null,
    results: [result()],
    ...overrides,
  };
}

describe('HTML report', () => {
  it('escapes everything that came from a conversation', () => {
    const hostile = '<script>alert(1)</script>';
    const html = renderReport(
      summary({
        results: [
          result({
            attempts: [
              attempt({
                turns: [{ user: hostile, reply: `<img src=x onerror=alert(2)>`, guards: [{ guard: 'identity_gate', ok: false, reason: hostile }] }],
                toolCalls: [{ tool: 'find_patient', input: { name: hostile }, output: { error: hostile }, error: hostile, durationMs: 1 }],
                checks: [{ kind: 'text', name: hostile, pass: false, expected: hostile, actual: hostile }],
              }),
            ],
          }),
        ],
      }),
    );
    assert.equal(html.includes(hostile), false);
    assert.equal(html.includes('<img src=x'), false);
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('says plainly when no model was involved', () => {
    assert.match(renderReport(summary({ mode: 'scripted', model: 'scripted replay' })), /no AI model was involved/);
    assert.doesNotMatch(renderReport(summary()), /no AI model was involved/);
  });

  it('warns when guards were switched off', () => {
    assert.match(renderReport(summary({ disabledGuards: ['identity_gate'] })), /Guards were switched off/);
  });

  it('never rounds a failure up to 100%', () => {
    const html = renderReport(
      summary({ totals: { scenarios: 300, scenariosPassed: 299, attempts: 900, attemptsPassed: 899, flaky: 0 } }),
    );
    assert.match(html, /99%/);
    assert.doesNotMatch(html, /class="value">100%/);
  });

  it('shows a failed gate with an icon and a label, not colour alone', () => {
    const html = renderReport(summary({ gate: { pass: false, failed: ['sample-01'] } }));
    assert.match(html, /dot critical[^>]*>✕<\/span>Failed/);
    assert.match(html, /1 critical scenario failed/);
  });

  it('opens failures and lists them first', () => {
    const html = renderReport(
      summary({
        results: [
          result({ id: 'passes-01' }),
          result({ id: 'fails-02', pass: false, passes: 0, attempts: [attempt({ pass: false })] }),
        ],
      }),
    );
    assert.ok(html.indexOf('fails-02') < html.indexOf('passes-01'));
    assert.match(html, /data-pass="false" open/);
  });

  it('distinguishes no baseline from no regressions', () => {
    assert.match(renderReport(summary({ regressions: null })), /No earlier run to compare with/);
    assert.match(renderReport(summary({ regressions: [] })), /Nothing that passed before fails now/);
  });

  it('shows what happens if a guard is removed, only when measured', () => {
    const mutation = { mutations: [{ guard: 'identity_gate', caughtBy: [{}, {}] }] };
    assert.match(renderReport(summary({ mutation })), /2 scenarios fail/);
    assert.match(renderReport(summary()), /Not measured/);
  });
});

describe('summary comment', () => {
  it('leads with the result and the gate', () => {
    const text = renderSummary(summary());
    assert.match(text, /^## ✅ Regression report: 1\/1 scenarios passed/);
    assert.match(text, /\*\*Safety gate: passed\*\*/);
    assert.match(text, /Double-booking \(blocks the build\) \| 1\/1 \| 3\/3/);
    assert.match(text, /identity gate 3\/3/);
    assert.match(text, /Estimated cost:\*\* \$0\.50/);
  });

  it('names the scenarios that failed the gate', () => {
    const text = renderSummary(summary({ gate: { pass: false, failed: ['a-01', 'b-02'] } }));
    assert.match(text, /^## ❌/);
    assert.match(text, /failed \(a-01, b-02\)/);
  });

  it('flags an offline run and leaves out cost', () => {
    const text = renderSummary(summary({ mode: 'scripted', model: 'scripted replay' }));
    assert.match(text, /Offline replay/);
    assert.doesNotMatch(text, /Estimated cost/);
  });
});
