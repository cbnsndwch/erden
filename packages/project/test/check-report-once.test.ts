import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { decodeCheckProjectReport, encodeCheckProjectReport } from '@erden/contracts';

import { nodeCheckProjectService } from '../src/index.js';

const DEMO = fileURLToPath(new URL('../../../examples/erden-demo', import.meta.url));

function frozenThroughout(value: unknown, path = '$'): string | null {
    if (value === null || typeof value !== 'object') {
        return null;
    }
    if (!Object.isFrozen(value)) {
        return path;
    }
    for (const [key, child] of Object.entries(value)) {
        const found = frozenThroughout(child, `${path}.${key}`);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

describe('check report validated once', () => {
    it('freezes a validated report to its last nested value, so encoding it needs no second validation', async () => {
        const report = await Effect.runPromise(nodeCheckProjectService.check({ from: DEMO, offline: true }));
        expect(frozenThroughout(report)).toBeNull();
        const bytes = encodeCheckProjectReport(report);
        const parsed = JSON.parse(bytes) as Record<string, unknown>;
        expect(encodeCheckProjectReport(decodeCheckProjectReport(parsed))).toBe(bytes);
        // An input whose nested objects a caller froze only shallowly is frozen throughout once decoded.
        const shallow = Object.freeze({ ...parsed, manifest: Object.freeze({ ...(parsed.manifest as object) }) });
        expect(frozenThroughout(decodeCheckProjectReport(shallow))).toBeNull();
    });

    it('still validates any object it did not validate itself', async () => {
        const report = await Effect.runPromise(nodeCheckProjectService.check({ from: DEMO, offline: true }));
        const changed = { ...report, outcome: report.outcome === 'passed' ? 'failed' : 'passed' } as typeof report;
        expect(() => encodeCheckProjectReport(changed)).toThrow(TypeError);
    });
});
