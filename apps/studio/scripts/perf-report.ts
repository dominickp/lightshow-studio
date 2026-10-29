import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { benchmarkComparisonKey, type BenchmarkResult } from '../src/app/benchmark';

/**
 * Print recent benchmark runs and the delta against the previous run **on the
 * same machine**.
 *
 *   npm run bench:report          # last 5 runs + delta
 *   npm run bench:report -- 10    # last 10 runs
 *
 * Laptop and desktop numbers are never compared to each other: each run is
 * stamped with a hardware id, and a run only diffs against the last run with
 * the same id, render preset, backend, rig and scenario options. Legacy runs
 * still require matching viewport and DPR. Display limit never limits lookup.
 */

interface MachineInfo {
  id: string;
  gpu: string;
  cores: number;
  memoryGb?: number;
  devicePixelRatio: number;
  viewport: string;
  userAgent: string;
}

interface Run {
  scenario: string;
  startedAt: string;
  frames: number;
  fps: { p50: number; p95: number; p99: number; max: number };
  frameMs: { p50: number; p95: number; p99: number; max: number };
  cpuMs: { p50: number; p95: number };
  longFrames: number;
  stutterFrames: number;
  longFrameRatio: number;
  drawCalls: number;
  triangles: number;
  backend: string;
  render?: BenchmarkResult['render'];
  resolutionScale?: number;
  options?: BenchmarkResult['options'];
  fixtureCount: number;
  machine?: MachineInfo;
  rigSignature: string;
  warnings?: string[];
}

const historyPath = fileURLToPath(new URL('../../../docs/agent_docs/perf-runs.jsonl', import.meta.url));
const limit = Math.max(2, Number(process.argv[2] ?? 5));

const readRuns = (): Run[] => {
  try {
    return readFileSync(historyPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Run);
  } catch {
    return [];
  }
};

/** Runs written before machine stamping are grouped separately, never silently mixed. */
const machineId = (run: Run): string => run.machine?.id ?? 'unknown';
const viewportOf = (run: Run): string => run.render === undefined
  ? `${run.machine?.viewport ?? 'unknown'} (legacy)`
  : `${run.render.width}x${run.render.height}@${run.render.pixelRatio} (${run.render.protocol})`;

const runs = readRuns();
if (runs.length === 0) {
  console.log('No runs yet. Open the app, then evaluate:\n  window.__dmxsim.benchmark()');
  console.log(`History file: ${historyPath}`);
  process.exit(0);
}

const recent = runs.slice(-limit);
const format = (run: Run): string =>
  [
    run.startedAt.replace('T', ' ').slice(0, 19),
    run.machine?.id ?? 'no-machine',
    run.backend,
    `${run.fixtureCount} fix`,
    viewportOf(run),
    `fps ${run.fps.p50.toFixed(1)}/${run.fps.p95.toFixed(1)}`,
    `p95 ${run.frameMs.p95.toFixed(1)}ms`,
    `cpu ${run.cpuMs.p50.toFixed(1)}ms`,
    `stutter ${run.stutterFrames ?? 0}`,
    `calls ${run.drawCalls}`,
    run.warnings === undefined ? '' : `! ${run.warnings.join('; ')}`,
  ]
    .filter((part) => part !== '')
    .join('  ');

console.log(`Benchmark history (${runs.length} runs, showing last ${recent.length})\n`);
for (const run of recent) console.log(`  ${format(run)}`);

/** One line per machine, so a laptop baseline is not mistaken for a regression. */
const machines = new Map<string, { run: Run; count: number }>();
for (const run of runs) {
  const id = machineId(run);
  const existing = machines.get(id);
  machines.set(id, { run, count: (existing?.count ?? 0) + 1 });
}
console.log('\nMachines');
for (const [id, entry] of machines) {
  const machine = entry.run.machine;
  const gpu = machine?.gpu ?? 'unknown GPU';
  console.log(
    `  ${id}  ${entry.count} run${entry.count === 1 ? '' : 's'}  ${gpu}  ${machine?.cores ?? '?'} cores  ${machine?.viewport ?? '?'}`,
  );
}

const after = recent.at(-1)!;
const afterId = machineId(after);
const afterViewport = viewportOf(after);
// A flagged run (throttled tab, audio never started) cannot be a baseline.
const comparable = (run: Run): boolean => run.warnings === undefined || run.warnings.length === 0;
const afterKey = benchmarkComparisonKey(after);
const before = runs
  .slice(0, -1)
  .reverse()
  .find((run) => afterKey !== null && benchmarkComparisonKey(run) === afterKey && comparable(run));

console.log('\nLast change');
if (!comparable(after)) {
  console.log(`  Skipped: latest run is flagged (${after.warnings?.join('; ')}).`);
  process.exit(0);
}
if (before === undefined) {
  console.log(`  No compatible earlier run on machine ${afterId} at ${afterViewport} with this backend, rig and scenario; nothing to compare.`);
  process.exit(0);
}
console.log(`  against ${before.startedAt.replace('T', ' ').slice(0, 19)} (${afterId}, ${afterViewport})`);

const delta = (next: number, previous: number): string => {
  const change = next - previous;
  const percent = previous === 0 ? 0 : (change / previous) * 100;
  const sign = change > 0 ? '+' : '';
  return `${sign}${change.toFixed(1)} (${sign}${percent.toFixed(1)}%)`;
};

console.log(`  fps p50   ${delta(after.fps.p50, before.fps.p50)}`);
console.log(`  fps p95   ${delta(after.fps.p95, before.fps.p95)}`);
console.log(`  frame p95 ${delta(after.frameMs.p95, before.frameMs.p95)} ms`);
console.log(`  cpu p50   ${delta(after.cpuMs.p50, before.cpuMs.p50)} ms`);
console.log(`  stutters  ${delta(after.stutterFrames ?? 0, before.stutterFrames ?? 0)}`);
console.log(`  draw calls  ${delta(after.drawCalls, before.drawCalls)}`);

/**
 * A run is a regression when the typical frame got slower, when the tail got
 * much worse, or when stutters appeared. Absolute thresholds keep vsync jitter
 * from reading as a change.
 */
const regressions: string[] = [];
if (after.rigSignature !== before.rigSignature) {
  regressions.push('rig changed (incomparable)');
  console.log(`\n  ! rig signature changed: ${before.rigSignature} -> ${after.rigSignature}`);
}
if (after.fps.p50 < before.fps.p50 * 0.95) {
  regressions.push(`fps p50 down ${(100 - (after.fps.p50 / before.fps.p50) * 100).toFixed(0)}%`);
}
if (after.frameMs.p95 > before.frameMs.p95 * 1.15) {
  regressions.push(`p95 frame time up ${((after.frameMs.p95 / before.frameMs.p95) * 100 - 100).toFixed(0)}%`);
}
if ((after.stutterFrames ?? 0) > (before.stutterFrames ?? 0) + 1) {
  regressions.push(`stutters +${(after.stutterFrames ?? 0) - (before.stutterFrames ?? 0)}`);
}

console.log(
  regressions.length === 0
    ? '\n  OK: no regression against the previous run on this machine'
    : `\n  REGRESSION: ${regressions.join(', ')}`,
);
process.exitCode = regressions.length === 0 ? 0 : 1;
