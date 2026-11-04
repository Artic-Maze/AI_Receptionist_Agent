import { displayLabels } from '../../src/time.js';

const TZ = 'Asia/Dhaka';

const GUARD_INFO = {
  identity_gate: { name: 'Identity gate', does: 'Blocks booking actions until exactly one patient is verified, and the booking is theirs.' },
  booking_verify: { name: 'Booking verify', does: 'Reads every write back and compares patient, provider and time.' },
  availability_grounding: { name: 'Availability grounding', does: 'Stops replies that offer a date or time no tool returned.' },
  confirmation_check: { name: 'Confirmation check', does: 'Allows “confirmed” only after a verified write in the same turn.' },
  handoff_triggers: { name: 'Handoff triggers', does: 'Sends medical questions, tool failures and requests for a person to staff.' },
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Rounding must never turn a run with a failure into "100%". */
function percent(part, whole) {
  if (!whole) return 0;
  return part === whole ? 100 : Math.min(99, Math.round((part / whole) * 100));
}

function money(usd) {
  if (usd === 0) return '$0';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function duration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

function status(kind, label) {
  const icons = { good: '✓', critical: '✕', warning: '!', neutral: '–' };
  return `<span class="status"><span class="dot ${kind}" aria-hidden="true">${icons[kind]}</span>${esc(label)}</span>`;
}

function meter(part, whole, { critical = false } = {}) {
  const value = percent(part, whole);
  const tone = part === whole ? 'good' : critical ? 'critical' : 'warning';
  return `<div class="meter" role="img" aria-label="${part} of ${whole} passed"><span class="${tone}" style="width:${value}%"></span></div>`;
}

const block = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  const limit = 1600;
  return esc(text.length > limit ? `${text.slice(0, limit)}\n… (full data in results.json)` : text);
};

function bookingLine(booking) {
  const when = displayLabels(booking.start, TZ).display_en;
  return `${esc(booking.patientId)} with ${esc(booking.providerId)}, ${esc(when)}`;
}

function expectedCalendarLines(expected) {
  if (!expected) return ['Not checked in this scenario'];
  const lines = [];
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'exact') {
      for (const want of value) {
        const start = Array.isArray(want.start) ? want.start.join(' or ') : want.start;
        lines.push(`${want.patient} with ${want.provider}, ${start}`);
      }
    } else if (key === 'total_active') {
      lines.push(`${value} active in total`);
    } else {
      lines.push(`${value} active for ${key.replace('bookings_for_', '')}`);
    }
  }
  return lines.map(esc);
}

function scenarioSection(result) {
  // Show the first failure if there is one, since that is what needs reading.
  const attempt = result.attempts.find((a) => !a.pass) ?? result.attempts[0];
  const failedChecks = attempt.checks.filter((c) => !c.pass);
  const fired = attempt.turns.flatMap((t) => t.guards).filter((g) => g.ok === false);
  const active = attempt.calendar.filter((b) => b.status === 'active');

  const transcript = attempt.turns
    .map(
      (turn) => `
        <div class="turn">
          <p class="line patient"><span class="who">Patient</span><span lang="${result.language}">${esc(turn.user)}</span></p>
          <p class="line agent"><span class="who">Agent${turn.handedOff ? ' (handed off)' : ''}</span><span lang="${result.language}">${esc(turn.reply ?? '(no reply)')}</span></p>
        </div>`,
    )
    .join('');

  const tools = attempt.toolCalls.length
    ? `<div class="scroll"><table>
        <thead><tr><th>Tool</th><th>Input</th><th>Output</th><th class="num">Time</th></tr></thead>
        <tbody>${attempt.toolCalls
          .map(
            (call) => `<tr class="${call.error ? 'row-error' : ''}">
              <td>${esc(call.tool)}${call.error ? `<br><small>${esc(call.error)}</small>` : ''}</td>
              <td><pre>${block(call.input)}</pre></td>
              <td><pre>${block(call.output)}</pre></td>
              <td class="num">${call.durationMs} ms</td>
            </tr>`,
          )
          .join('')}</tbody></table></div>`
    : '<p class="muted">No tools were called.</p>';

  const guards = fired.length
    ? `<ul class="plain">${fired
        .map((g) => {
          const detail = g.reason ?? g.trigger ?? g.mismatches?.join(', ') ?? g.violations?.map((v) => v.reason ?? `“${v.mention}”`).join(', ') ?? '';
          return `<li><strong>${esc(GUARD_INFO[g.guard]?.name ?? g.guard)}</strong>${detail ? `: ${esc(detail)}` : ''}</li>`;
        })
        .join('')}</ul>`
    : '<p class="muted">No guard had to step in.</p>';

  const checks = failedChecks.length
    ? `<div class="failures"><h4>Failed checks</h4><div class="scroll"><table>
        <thead><tr><th>Check</th><th>Expected</th><th>Actual</th></tr></thead>
        <tbody>${failedChecks
          .map((c) => `<tr><td>${esc(c.name)}</td><td><pre>${block(c.expected)}</pre></td><td><pre>${block(c.actual)}</pre></td></tr>`)
          .join('')}</tbody></table></div></div>`
    : '';

  const judge = result.judge
    ? `<p class="muted">Tone, not part of pass or fail: politeness ${result.judge.politeness}/5, clarity ${result.judge.clarity}/5, language ${result.judge.correct_language}/5. ${esc(result.judge.notes)}</p>`
    : '';

  const state = result.pass ? status('good', 'Passed') : status('critical', 'Failed');
  return `
    <details class="scenario" data-category="${esc(result.category)}" data-pass="${result.pass}"${result.pass ? '' : ' open'}>
      <summary>
        <span class="scenario-state">${state}</span>
        <span class="scenario-name"><code>${esc(result.id)}</code><span class="muted">${esc(result.description)}</span></span>
        <span class="scenario-runs${result.flaky ? ' flaky' : ''}">${result.passes}/${result.runs} runs</span>
      </summary>
      <div class="scenario-body">
        ${checks}
        ${judge}
        <h4>Transcript</h4>${transcript}
        <h4>Guards that stepped in</h4>${guards}
        <h4>Calendar: expected and actual</h4>
        <div class="diff">
          <div><h5>Expected</h5>${expectedCalendarLines(result.expectedCalendar).map((l) => `<p>${l}</p>`).join('')}</div>
          <div><h5>Actual (active bookings)</h5>${active.length ? active.map((b) => `<p>${bookingLine(b)}</p>`).join('') : '<p>None</p>'}</div>
        </div>
        <h4>Tool calls</h4>${tools}
        <p class="muted small">Audit log: ${esc(attempt.audit.map((a) => a.action).join(', ') || 'empty')}</p>
      </div>
    </details>`;
}

const STYLE = `
  :root {
    color-scheme: light;
    --page: #f6f5f1; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --line: #e1e0d9; --track: #e8e7e1;
    --callout: #fdf3dc; --callout-ink: #5c4205; --error-row: #fdeeee; --code: #f2f1ec;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --page: #121211; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --line: #2c2c2a; --track: #383835;
      --callout: #3a2d10; --callout-ink: #f5d48a; --error-row: #3a1d1d; --code: #242422;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", "Noto Sans Bengali", sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 1.5rem; margin: 0; }
  h2 { font-size: 1.0625rem; margin: 36px 0 12px; }
  h4 { font-size: .8125rem; margin: 18px 0 8px; color: var(--ink-2); font-weight: 600; }
  h5 { font-size: .8125rem; margin: 0 0 6px; font-weight: 600; }
  p { margin: 0; }
  code, pre { font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .muted { color: var(--ink-2); }
  .small { font-size: .8125rem; margin-top: 12px; }
  .meta { color: var(--ink-2); margin-top: 4px; }
  .callout { background: var(--callout); color: var(--callout-ink); border-radius: 10px; padding: 12px 16px; margin-top: 20px; }
  .callout strong { display: block; margin-bottom: 2px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-top: 20px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .hero { grid-column: span 2; }
  .label { font-size: .8125rem; color: var(--ink-2); }
  .hero .value { font-size: 56px; line-height: 1.1; font-weight: 600; margin-top: 2px; }
  .value { font-size: 26px; line-height: 1.25; font-weight: 600; margin-top: 4px; }
  .sub { font-size: .8125rem; color: var(--ink-2); margin-top: 4px; }
  .status { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; white-space: nowrap; }
  .dot { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; font-size: 11px; font-weight: 700; color: #fff; flex-shrink: 0; }
  .dot.good { background: #0ca30c; } .dot.critical { background: #d03b3b; }
  .dot.warning { background: #fab219; color: #0b0b0b; } .dot.neutral { background: var(--ink-2); color: var(--surface); }
  .value .dot { width: 24px; height: 24px; font-size: 14px; }
  .value .status { gap: 8px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: .8125rem; color: var(--ink-2); font-weight: 500; }
  tbody tr:last-child td { border-bottom: 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .table-card { padding: 4px; }
  .scroll { overflow-x: auto; }
  .meter { height: 8px; min-width: 96px; background: var(--track); border-radius: 4px; overflow: hidden; margin-top: 7px; }
  .meter span { display: block; height: 100%; border-radius: 4px; }
  .meter .good { background: #0ca30c; } .meter .warning { background: #fab219; } .meter .critical { background: #d03b3b; }
  .tag { font-size: .75rem; color: var(--ink-2); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; margin-left: 6px; white-space: nowrap; }
  .filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 12px; }
  select { font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; min-height: 36px; padding: 0 8px; max-width: 100%; }
  label.check { display: inline-flex; gap: 6px; align-items: center; min-height: 36px; }
  .scenario { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; }
  .scenario[hidden] { display: none; }
  summary { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; cursor: pointer; }
  .scenario-state { width: 92px; flex-shrink: 0; }
  .scenario-name { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .scenario-name code { overflow-wrap: anywhere; }
  .scenario-runs { font-size: .8125rem; color: var(--ink-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .scenario-runs.flaky { font-weight: 600; color: var(--ink); }
  .scenario-body { padding: 0 14px 14px; border-top: 1px solid var(--line); }
  .failures table { background: var(--error-row); border-radius: 8px; }
  .turn { margin-bottom: 10px; }
  .line { display: grid; grid-template-columns: 76px 1fr; gap: 8px; padding: 2px 0; overflow-wrap: anywhere; }
  .who { font-size: .8125rem; color: var(--ink-2); padding-top: 1px; }
  .diff { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .diff > div { background: var(--code); border-radius: 8px; padding: 10px 12px; }
  .plain { margin: 0; padding-left: 18px; }
  .row-error td { background: var(--error-row); }
  small { color: var(--ink-2); }
  @media (max-width: 560px) {
    .hero { grid-column: span 1; }
    summary { flex-wrap: wrap; }
    .scenario-state { width: auto; }
    .scenario-name { order: 3; flex-basis: 100%; }
    .scenario-runs { margin-left: auto; }
    .line { grid-template-columns: 1fr; gap: 0; }
  }
`;

/** The full static report. Everything from a run is escaped: transcripts are untrusted text. */
export function renderReport(summary) {
  const { totals, gate, categories, guards, regressions, mutation } = summary;
  const offline = summary.mode === 'scripted';
  const date = new Date(summary.generatedAt).toUTCString();
  const scenarios = [...summary.results].sort((a, b) => Number(a.pass) - Number(b.pass));
  const mutationFor = (guard) => mutation?.mutations.find((m) => m.guard === guard);

  const regressionTile =
    regressions === null || regressions === undefined
      ? { value: '–', sub: 'No earlier run to compare with' }
      : { value: String(regressions.length), sub: regressions.length ? esc(regressions.join(', ')) : 'Nothing that passed before fails now' };

  const judged = summary.results.filter((r) => r.judge);
  const average = (key) => (judged.reduce((sum, r) => sum + r.judge[key], 0) / judged.length).toFixed(1);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receptionist Regression Report</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>AI receptionist: regression report</h1>
  <p class="meta">${esc(date)} · ${esc(summary.model)} · ${summary.runsPerScenario} run${summary.runsPerScenario === 1 ? '' : 's'} per scenario</p>

  ${offline ? `<div class="callout"><strong>Offline replay: no AI model was involved in this run</strong>A script stood in for the model, often misbehaving on purpose. This shows the guards, database and booking logic hold up when the model gets things wrong. It does not show how well a real model handles these conversations.</div>` : ''}
  ${summary.disabledGuards?.length ? `<div class="callout"><strong>Guards were switched off for this run</strong>${esc(summary.disabledGuards.join(', '))}. These results do not describe the real system.</div>` : ''}

  <section class="kpis" aria-label="Summary">
    <div class="card hero">
      <div class="label">Scenarios passed</div>
      <div class="value">${percent(totals.scenariosPassed, totals.scenarios)}%</div>
      <div class="sub">${totals.scenariosPassed} of ${totals.scenarios} scenarios, ${totals.attemptsPassed} of ${totals.attempts} runs</div>
    </div>
    <div class="card">
      <div class="label">Safety gate</div>
      <div class="value">${gate.pass ? status('good', 'Passed') : status('critical', 'Failed')}</div>
      <div class="sub">${gate.pass ? 'No failures in double-booking, wrong-patient or hallucinated availability' : `${gate.failed.length} critical scenario${gate.failed.length === 1 ? '' : 's'} failed`}</div>
    </div>
    <div class="card">
      <div class="label">Regressions since last run</div>
      <div class="value">${regressionTile.value}</div>
      <div class="sub">${regressionTile.sub}</div>
    </div>
    <div class="card">
      <div class="label">Flaky scenarios</div>
      <div class="value">${totals.flaky}</div>
      <div class="sub">Passed some runs and failed others</div>
    </div>
    <div class="card">
      <div class="label">${offline ? 'Model cost' : 'Cost per scenario run'}</div>
      <div class="value">${offline ? 'None' : money(summary.cost.perScenarioUsd)}</div>
      <div class="sub">${offline ? 'No model calls' : `Estimated ${money(summary.cost.totalUsd)} for this run`}</div>
    </div>
    <div class="card">
      <div class="label">Median scenario time</div>
      <div class="value">${duration(summary.latency.medianMs)}</div>
      <div class="sub">Slowest ${duration(summary.latency.maxMs)}</div>
    </div>
    ${judged.length ? `<div class="card"><div class="label">Tone (never affects a pass)</div><div class="value">${average('politeness')} / 5</div><div class="sub">Politeness. Clarity ${average('clarity')}, language ${average('correct_language')}</div></div>` : ''}
  </section>

  <h2>By risk category</h2>
  <div class="card table-card"><div class="scroll"><table>
    <thead><tr><th>Category</th><th>Pass rate</th><th class="num">Scenarios</th><th class="num">Runs</th></tr></thead>
    <tbody>${categories
      .map(
        (c) => `<tr>
          <td>${esc(c.label)}${c.critical ? '<span class="tag">Blocks the build</span>' : ''}</td>
          <td>${meter(c.attemptsPassed, c.attempts, { critical: c.critical })}</td>
          <td class="num">${c.passed}/${c.scenarios}</td>
          <td class="num">${c.attemptsPassed}/${c.attempts}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table></div></div>

  <h2>What the guards caught</h2>
  <div class="card table-card"><div class="scroll"><table>
    <thead><tr><th>Guard</th><th class="num">Caught when expected</th><th class="num">Also stepped in</th><th class="num">If removed</th></tr></thead>
    <tbody>${guards
      .map((g) => {
        const info = GUARD_INFO[g.guard];
        const removed = mutationFor(g.guard);
        return `<tr>
          <td><strong>${esc(info.name)}</strong><br><span class="muted">${esc(info.does)}</span></td>
          <td class="num">${g.caught}/${g.expected}</td>
          <td class="num">${g.firedElsewhere}</td>
          <td class="num">${removed ? `${removed.caughtBy.length} scenario${removed.caughtBy.length === 1 ? '' : 's'} fail` : 'Not measured'}</td>
        </tr>`;
      })
      .join('')}</tbody>
  </table></div></div>
  ${mutation ? '<p class="muted small">“If removed” comes from a separate run with that guard switched off. It only counts scenarios where a bad outcome reached the calendar or the patient.</p>' : ''}

  <h2>Scenarios</h2>
  <div class="filters">
    <select id="category" aria-label="Filter by category">
      <option value="">All categories</option>
      ${categories.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}
    </select>
    <label class="check"><input type="checkbox" id="failed-only"> Failures only</label>
  </div>
  ${scenarios.map(scenarioSection).join('')}
</main>
<script>
  const category = document.getElementById('category');
  const failedOnly = document.getElementById('failed-only');
  function applyFilters() {
    document.querySelectorAll('.scenario').forEach((element) => {
      element.hidden =
        (category.value && element.dataset.category !== category.value) ||
        (failedOnly.checked && element.dataset.pass === 'true');
    });
  }
  category.addEventListener('change', applyFilters);
  failedOnly.addEventListener('change', applyFilters);
</script>
</body>
</html>
`;
}

/** The short version, posted as a pull request comment and printed after a run. */
export function renderSummary(summary) {
  const { totals, gate, categories, guards, regressions } = summary;
  const lines = [
    `## ${gate.pass ? '✅' : '❌'} Regression report: ${totals.scenariosPassed}/${totals.scenarios} scenarios passed`,
    '',
    `**Safety gate: ${gate.pass ? 'passed' : `failed (${gate.failed.join(', ')})`}** · ${summary.model} · ${summary.runsPerScenario} run${summary.runsPerScenario === 1 ? '' : 's'} per scenario`,
  ];
  if (summary.mode === 'scripted') {
    lines.push(
      '',
      '> Offline replay: a script stood in for the model. This tests the guards and booking logic, not how a real model behaves.',
    );
  }
  lines.push(
    '',
    '| Category | Scenarios | Runs |',
    '| --- | --- | --- |',
    ...categories.map((c) => `| ${c.label}${c.critical ? ' (blocks the build)' : ''} | ${c.passed}/${c.scenarios} | ${c.attemptsPassed}/${c.attempts} |`),
    '',
    `**Guard catches:** ${guards.filter((g) => g.expected > 0).map((g) => `${GUARD_INFO[g.guard].name.toLowerCase()} ${g.caught}/${g.expected}`).join(' · ') || 'none expected'}`,
  );
  if (regressions) {
    lines.push('', `**Regressions:** ${regressions.length ? regressions.join(', ') : 'none'}`);
  }
  if (totals.flaky) lines.push('', `**Flaky scenarios:** ${totals.flaky}`);
  if (summary.mode !== 'scripted') {
    lines.push('', `**Estimated cost:** ${money(summary.cost.totalUsd)} · **Median scenario time:** ${duration(summary.latency.medianMs)}`);
  }
  return lines.join('\n');
}
