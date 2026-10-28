import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CheckProjectReport } from '@erden/contracts';
import { makeNodeOntologyPorts, makeOntologyService, nodeReasonerService } from '@erden/ontology';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import { makeCheckProjectService, makeManifestService } from '../src/index.js';

import {
    capturingReasoner,
    compareCheckRuns,
    firstJsonDifference,
    runCheck,
    separateReasoner,
    type CheckRun,
} from './support/check-differential.js';
import { buildDifferentialFixtures, type DifferentialFixture } from './support/differential-fixtures.js';

let root: string;
let fixtures: ReadonlyArray<DifferentialFixture>;

beforeAll(async () => {
    root = makeTestTempRoot('erden-check-differential-');
    fixtures = await buildDifferentialFixtures(root);
}, 120_000);

afterAll(() => {
    cleanupTestTempRoot(root);
});

async function check(fixture: DifferentialFixture, separate = false): Promise<CheckRun> {
    const capture = capturingReasoner(separate ? separateReasoner(nodeReasonerService) : nodeReasonerService);
    const service = makeCheckProjectService(
        makeManifestService(),
        makeOntologyService(makeNodeOntologyPorts()),
        capture.reasoner,
    );
    return runCheck(service, { from: fixture.from, offline: true, ...fixture.options }, capture.last);
}

function fixture(name: string): DifferentialFixture {
    const found = fixtures.find((item) => item.name === name);
    if (found === undefined) {
        throw new Error(`no fixture ${name}`);
    }
    return found;
}

function summary(run: CheckRun): string {
    if (run.kind === 'error') {
        return `error ${run.error.code}`;
    }
    const reasoning = run.report.reasoning;
    return `${run.report.outcome} ${reasoning.outcome} ${String(reasoning.consistency)} ${String(reasoning.inferred.length)} inferred`;
}

function report(run: CheckRun): CheckProjectReport {
    if (run.kind !== 'report') {
        throw new Error('expected a report');
    }
    return run.report;
}

function mutable<A>(value: A): A {
    return JSON.parse(JSON.stringify(value)) as A;
}

function withReport(run: CheckRun, changed: unknown): CheckRun {
    return {
        kind: 'report',
        report: changed as CheckProjectReport,
        ...(run.evidence === undefined ? {} : { evidence: run.evidence }),
    };
}

describe('check differential comparator', () => {
    it('finds the fused decide-and-materialize path byte-identical to deciding and materializing separately', async () => {
        const outcomes: Record<string, string> = {};
        for (const item of fixtures) {
            const fused = await check(item);
            const separate = await check(item, true);
            expect(compareCheckRuns(fused, separate, { strict: true }), item.name).toBeNull();
            outcomes[item.name] = summary(fused);
        }
        expect(outcomes).toMatchInlineSnapshot(`
          {
            "ambiguous-property-kind": "error CHECK_AMBIGUOUS_PROPERTY_KIND",
            "assertion-about-dependency-individual": "passed decided consistent 3 inferred",
            "data-range-across-layers": "passed decided consistent 1 inferred",
            "dependency-class-under-new-class": "passed decided consistent 5 inferred",
            "domain-on-borrowed-property": "passed decided consistent 4 inferred",
            "equivalence-between-borrowed-terms": "passed decided consistent 6 inferred",
            "erden-demo": "passed decided consistent 1 inferred",
            "inconsistent": "failed decided inconsistent 0 inferred",
            "inconsistent-across-layers": "failed decided inconsistent 0 inferred",
            "local-additions": "passed decided consistent 8 inferred",
            "new-individual-to-dependency-individual": "passed decided consistent 6 inferred",
            "report-mode-properties-typed-by-dependent": "passed decided consistent 0 inferred",
            "report-mode-undeclared-term-declared-by-dependent": "passed decided consistent 0 inferred",
            "siblings-through-skos": "passed decided consistent 3 inferred",
            "synthetic-chain": "passed decided consistent 30 inferred",
            "union-over-inference-limit": "failed refused null 0 inferred",
            "union-over-input-limit": "failed refused null 0 inferred",
            "unsatisfiable-class": "passed decided consistent 0 inferred",
          }
        `);
    }, 300_000);

    it('names a dropped inference, a changed proof premise and a flipped verdict', async () => {
        const reference = await check(fixture('local-additions'));
        const base = report(reference);
        expect(base.reasoning.inferred.length).toBeGreaterThan(0);

        const dropped = mutable(base) as unknown as {
            reasoning: { inferred: Array<{ subject: string; predicate: string }> };
        };
        const [removed] = dropped.reasoning.inferred.splice(0, 1);
        const droppedDifference = compareCheckRuns(withReport(reference, dropped), reference);
        expect(droppedDifference?.comparison).toBe('inferred');
        expect(droppedDifference?.detail).toContain(`${removed?.subject ?? ''} ${removed?.predicate ?? ''}`);

        const evidence = reference.evidence;
        if (evidence === undefined) {
            throw new Error('expected captured evidence');
        }
        const forged = mutable(evidence);
        const statement = forged.result.inferred[0];
        if (statement === undefined) {
            throw new Error('expected an inferred statement');
        }
        const otherAxiom = forged.request.ontology.axioms.find(
            (axiom) => !statement.provenance.premiseIds.includes(axiom.id),
        );
        (statement.provenance as { premiseIds: ReadonlyArray<string> }).premiseIds = [
            otherAxiom?.id ?? 'axiom:missing',
        ];
        expect(compareCheckRuns({ kind: 'report', report: base, evidence: forged }, reference)?.comparison).toBe(
            'proof',
        );

        const flipped = mutable(base) as { reasoning: { consistency: string | null } };
        flipped.reasoning.consistency = 'inconsistent';
        expect(compareCheckRuns(withReport(reference, flipped), reference)?.comparison).toBe('consistency');
    }, 120_000);

    it('in strict mode names the first differing JSON path of the report bytes', async () => {
        const reference = await check(fixture('local-additions'));
        const changed = mutable(report(reference)) as { manifest: { title: string | null } };
        changed.manifest.title = 'changed';
        const candidate = withReport(reference, changed);
        expect(compareCheckRuns(candidate, reference)).toBeNull();
        expect(compareCheckRuns(candidate, reference, { strict: true })).toEqual({
            comparison: 'report-bytes',
            detail: '$.manifest.title',
        });
        expect(firstJsonDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe('$.a[1].b');
        expect(firstJsonDifference({ a: 1 }, { a: 1, c: 2 })).toBe('$.c');
    }, 120_000);

    it('requires both paths to refuse alike', async () => {
        const refusal = await check(fixture('ambiguous-property-kind'));
        const decided = await check(fixture('local-additions'));
        expect(compareCheckRuns(refusal, decided)?.comparison).toBe('refusal');
    }, 120_000);
});
