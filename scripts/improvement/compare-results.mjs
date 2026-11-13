// Descriptive same-tree noise report, NOT an acceptance gate or significance test.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, hash } from './provenance.mjs';

const verdicts = new Set(['pass', 'pass_text_ask', 'wrong_route', 'missed_ask', 'unnecessary_ask', 'error']);
const kinds = new Set(['attach', 'new', 'ask', 'chat', 'error']);
function validate(run) {
  if (typeof run?.runId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(run.runId)) {
    throw new Error('Every observation needs a runner-generated UUID runId; do not relabel historical artifacts');
  }
  const p = run?.provenance;
  if (p?.version !== 1 || !/^[a-f0-9]{64}$/.test(p.fingerprint ?? '') || run.inputStable !== true) {
    throw new Error('Every run needs v1 provenance and inputStable=true; legacy/changed-input runs are not comparable');
  }
  if (p.sourceHash !== hash(canonical(p.files)) || p.fingerprint !== hash(canonical({ sourceHash: p.sourceHash, runtime: p.runtime, configuration: p.configuration }))) {
    throw new Error('Provenance fingerprint does not match its inputs');
  }
  if (!Array.isArray(run.results) || run.results.length === 0) throw new Error('Empty results are not comparable');
  const ids = new Set();
  for (const row of run.results) {
    if (!Number.isInteger(row.id) || ids.has(row.id) || typeof row.text !== 'string' ||
        !['attach', 'new', 'ask', 'chat'].includes(row.expect?.kind) || !verdicts.has(row.verdict) || !kinds.has(row.outcome?.kind) ||
        (row.outcome.kind === 'attach' && (typeof row.outcome.threadId !== 'string' || typeof row.outcome.isNew !== 'boolean'))) {
      throw new Error('Invalid or duplicate case result');
    }
    ids.add(row.id);
  }
  const sorted = [...ids].sort((a, b) => a - b);
  if (canonical(sorted) !== canonical(p.configuration.caseIds)) throw new Error('Results do not match the recorded case selection');
  return [...run.results].sort((a, b) => a.id - b.id);
}
function stats(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean, min: Math.min(...values), max: Math.max(...values),
    sampleStddev: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) };
}
function metrics(rows) {
  const count = verdict => rows.filter(row => row.verdict === verdict).length;
  const asks = rows.filter(row => row.expect.kind === 'ask').length;
  const nonAsks = rows.length - asks;
  return { passRate: (count('pass') + count('pass_text_ask')) / rows.length,
    wrongRouteRate: count('wrong_route') / rows.length,
    missedAskRate: asks ? count('missed_ask') / asks : null,
    unnecessaryAskRate: nonAsks ? count('unnecessary_ask') / nonAsks : null,
    errors: count('error') };
}
export function compareRuns(runs) {
  if (runs.length < 2) throw new Error('Provide at least two independent runs');
  const rows = runs.map(validate);
  if (new Set(runs.map(run => run.provenance.fingerprint)).size !== 1) throw new Error('Mixed code, runtime, configuration or case selection; measure each cohort separately');
  if (new Set(runs.map(run => canonical(run.thresholds))).size !== 1) throw new Error('Mixed thresholds');
  const definitions = cases => canonical(cases.map(row => ({ id: row.id, text: row.text, expect: row.expect })));
  if (rows.some(cases => definitions(cases) !== definitions(rows[0]))) throw new Error('Case definitions differ');
  if (new Set(runs.map(run => run.runId)).size !== runs.length) throw new Error('Duplicate runId: copies are not independent observations');
  // Normalize execution-order differences before checking copied artifact content. Ignore
  // only runId, so assigning a new ID to a reordered copy does not create new evidence.
  // Same outcomes in genuinely separate runs remain valid (different timestamps/timings).
  const artifacts = runs.map((run, index) => {
    const { runId, results, ...metadata } = run;
    return hash(canonical({ ...metadata, results: rows[index] }));
  });
  if (new Set(artifacts).size !== runs.length) throw new Error('Duplicate run artifact');
  const measurements = rows.map(metrics);
  const distribution = Object.fromEntries(Object.keys(measurements[0]).map(key => [key,
    measurements[0][key] === null ? null : stats(measurements.map(row => row[key]))]));
  const flips = rows[0].flatMap((row, index) => {
    const observed = rows.map(cases => cases[index]);
    // Error messages and prose vary without changing the route; do not count them as route flips.
    const route = outcome => outcome.kind === 'attach' ? canonical({ kind: outcome.kind, threadId: outcome.threadId, isNew: outcome.isNew }) : outcome.kind;
    const outcomes = [...new Set(observed.map(item => route(item.outcome)))];
    const seenVerdicts = [...new Set(observed.map(item => item.verdict))];
    return outcomes.length > 1 || seenVerdicts.length > 1 ? [{ id: row.id, routeVariants: outcomes, verdicts: seenVerdicts }] : [];
  });
  const totalCases = runs[0].provenance.configuration.totalCaseCount;
  const scope = Number.isInteger(totalCases) ? (rows[0].length === totalCases ? 'full' : 'partial') : 'unknown';
  return { version: 1, runs: runs.length, runIds: runs.map(run => run.runId), cases: rows[0].length, scope, fingerprint: runs[0].provenance.fingerprint,
    warnings: ['Descriptive only: no automatic acceptance or significance claim.',
      'Matching fingerprints do not prove the remote model, credentials or gateway routing stayed unchanged.',
      ...(scope !== 'full' ? ['Partial or unknown dataset coverage: not full merge evidence.'] : []),
      ...(runs.length < 5 ? ['Fewer than five runs: exploratory noise estimate only.'] : [])],
    metrics: distribution, flips };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const paths = process.argv.slice(2);
    // Never echo malformed result content, which may contain model/provider diagnostics.
    const runs = paths.map(path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Cannot read result JSON'); } });
    console.log(JSON.stringify(compareRuns(runs), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
