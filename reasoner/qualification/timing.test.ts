import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { TIMING_SHAPES, outcomeOf, probeTool, runReasoner, timingRequest } from './timing-shapes.js';

// The reasoner timing gate. `pnpm run test:reasoner:timing` runs it against ERDEN_REASONER_BIN;
// `pnpm test` skips it. It records wall time per case, and per phase when the binary was built
// with the `phase-timing` cargo feature. Ceilings are asserted only with ERDEN_REASONER_TIMING_ASSERT=1.

const configuredBinary = process.env.ERDEN_REASONER_BIN;
const binary = configuredBinary === undefined ? undefined : resolve(configuredBinary);
const enabled = process.env.MODE === 'timing' && binary !== undefined && existsSync(binary);
const assertCeilings = process.env.ERDEN_REASONER_TIMING_ASSERT === '1';
const budgetMs = Number(process.env.ERDEN_REASONER_TIMING_BUDGET_MS ?? '120000');

describe.skipIf(!enabled)('reasoner timing gate', () => {
  test('records wall and phase times over the bug report grid and the wall shapes', () => {
    if (binary === undefined) throw new Error('ERDEN_REASONER_BIN is required');
    expect(Number.isSafeInteger(budgetMs) && budgetMs >= 1_000 && budgetMs <= 600_000).toBe(true);
    const tool = probeTool(binary);
    const rows: Array<Record<string, unknown>> = [];
    const lines = [
      `binary ${binary}`,
      `tool ${tool.version} ${tool.executableDigest}`,
      `budget ${String(budgetMs)} ms; ceilings ${assertCeilings ? 'asserted' : 'recorded only'}`,
      '',
      '| Case | C | P | I | Axioms | Outcome | Wall s | Phases (ms) |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const shape of TIMING_SHAPES) {
      const request = timingRequest(shape, tool, budgetMs);
      let run: ReturnType<typeof runReasoner>;
      try {
        run = runReasoner(binary, request);
      } catch (cause) {
        // An older binary exits nonzero on a request above its own wire ceiling (16 MiB before 0.2.0).
        const outcome = `process failed: ${(cause as Error).message.split('\n')[0] ?? ''}`;
        rows.push({ ...shape, axioms: request.ontology.axioms.length, outcome });
        lines.push(`| ${shape.name} | ${String(shape.classes)} | ${String(shape.properties)} | ${String(shape.individuals)} | ${String(request.ontology.axioms.length)} | ${outcome} | | |`);
        if (assertCeilings) expect.fail(`${shape.name}: ${outcome}`);
        continue;
      }
      const outcome = outcomeOf(run.response);
      const phases = Object.entries(run.phases).map(([name, ms]) => `${name} ${ms.toFixed(1)}`).join(', ');
      rows.push({ ...shape, axioms: request.ontology.axioms.length, outcome, wallMs: run.wallMs, phases: run.phases, requestBytes: run.requestBytes, responseBytes: run.responseBytes });
      lines.push(`| ${shape.name} | ${String(shape.classes)} | ${String(shape.properties)} | ${String(shape.individuals)} | ${String(request.ontology.axioms.length)} | ${outcome} | ${(run.wallMs / 1000).toFixed(2)} | ${phases} |`);
      if (assertCeilings) {
        expect(outcome, shape.name).toBe('decided consistent');
        expect(run.wallMs, shape.name).toBeLessThan(shape.ceilingMs);
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    const report = process.env.ERDEN_REASONER_TIMING_REPORT;
    if (report !== undefined) writeFileSync(report, `${JSON.stringify({ tool, budgetMs, rows }, null, 2)}\n`);
  }, 3_600_000);
});
