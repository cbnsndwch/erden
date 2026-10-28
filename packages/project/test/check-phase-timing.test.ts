import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { encodeCheckProjectReport } from '@erden/contracts';

import {
    CHECK_PHASES,
    makeRecordingCheckPhaseTimer,
    nodeCheckProjectService,
    noopCheckPhaseTimer,
} from '../src/index.js';

const DEMO = fileURLToPath(new URL('../../../examples/erden-demo', import.meta.url));

describe('check phase timing', () => {
    it('charges the time since the previous mark to the phase that just ended', () => {
        const ticks = [10, 13, 20, 21, 30];
        const timer = makeRecordingCheckPhaseTimer(() => ticks.shift() ?? 0);
        timer.mark('load');
        timer.mark('parse');
        timer.mark('report');
        timer.mark('report');
        expect(timer.phases()).toEqual({
            load: 3,
            parse: 7,
            snapshot: 0,
            normalize: 0,
            reasoner: 0,
            verify: 0,
            materialize: 0,
            validate: 0,
            report: 10,
        });
        expect(Object.keys(timer.phases())).toEqual(CHECK_PHASES);
        expect(() => {
            noopCheckPhaseTimer.mark('load');
        }).not.toThrow();
    });

    it('times every phase of a passing check without changing its report bytes', async () => {
        const untimed = await Effect.runPromise(nodeCheckProjectService.check({ from: DEMO, offline: true }));
        const timer = makeRecordingCheckPhaseTimer();
        const timed = await Effect.runPromise(nodeCheckProjectService.check({ from: DEMO, offline: true, timer }));
        expect(timed.outcome).toBe('passed');
        expect(encodeCheckProjectReport(timed)).toBe(encodeCheckProjectReport(untimed));
        const phases = timer.phases();
        for (const phase of CHECK_PHASES) {
            expect(phases[phase], phase).toBeGreaterThan(0);
        }
    });
});
