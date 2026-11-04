// Placeholder replaced in the report task; the runner needs these two exports to exist.
export const renderReport = (summary) => `<pre>${JSON.stringify(summary.totals)}</pre>`;
export const renderSummary = (summary) => `Scenarios: ${summary.totals.scenariosPassed}/${summary.totals.scenarios} | gate: ${summary.gate.pass ? 'pass' : 'FAIL'}`;
