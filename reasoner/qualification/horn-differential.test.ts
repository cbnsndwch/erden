// The Horn calculus against the 0.2 procedure on V1 requests: ERDEN_REASONER_BIN decides V1 content by the 0.2
// procedure, ERDEN_REASONER_FORCE_HORN_BIN (built with the `force-horn` feature) decides it by the Horn saturation.
// Both answers must pass the proof checker, and they must state the same statements, consistency and unsatisfiable
// classes.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { computeReasonerInputDigest, getReasonerCompatibilityIssues, makeReasonerTrustExpectation } from '../protocol/src/index.js';
import type { ReasonerRequest, ReasonerResponse, RequiredTool } from '../protocol/src/index.js';

import { DIFFERENTIAL_SHAPES, outcomeOf, probeTool, runReasoner, timingRequest, TIMING_SHAPES } from './timing-shapes.js';

const root = resolve(import.meta.dirname, '..', '..');
const fixtureDirectory = resolve(root, 'reasoner', 'protocol', 'fixtures', 'known-answer');
const v1Binary = process.env.ERDEN_REASONER_BIN === undefined ? undefined : resolve(process.env.ERDEN_REASONER_BIN);
const hornBinary =
    process.env.ERDEN_REASONER_FORCE_HORN_BIN === undefined
        ? undefined
        : resolve(process.env.ERDEN_REASONER_FORCE_HORN_BIN);
const enabled = v1Binary !== undefined && hornBinary !== undefined && existsSync(v1Binary) && existsSync(hornBinary);

function statements(response: ReasonerResponse): ReadonlyArray<string> {
    if (response.result.outcome !== 'decided') return [];
    return [...response.result.asserted, ...response.result.inferred]
        .map((statement) => JSON.stringify([statement.subject, statement.predicate, statement.object]))
        .sort();
}

function summary(response: ReasonerResponse) {
    const result = response.result;
    return {
        outcome: outcomeOf(response),
        unsatisfiable: result.outcome === 'decided' ? result.unsatisfiableClasses.map((item) => item.classIri) : [],
    };
}

function retool(request: ReasonerRequest, tool: RequiredTool): ReasonerRequest {
    const draft = { ...request, requiredTool: tool };
    return { ...draft, ontology: { ...draft.ontology, digest: computeReasonerInputDigest(draft) } };
}

function compare(name: string, request: ReasonerRequest, tools: { v1: RequiredTool; horn: RequiredTool }) {
    if (v1Binary === undefined || hornBinary === undefined) throw new Error('both binaries are required');
    const v1Request = retool(request, tools.v1);
    const hornRequest = retool(request, tools.horn);
    const v1 = runReasoner(v1Binary, v1Request);
    const horn = runReasoner(hornBinary, hornRequest);
    if (v1.response.result.outcome === 'decided') {
        expect(getReasonerCompatibilityIssues(v1Request, v1.response, makeReasonerTrustExpectation(tools.v1))).toEqual([]);
    }
    if (horn.response.result.outcome === 'decided') {
        expect(
            getReasonerCompatibilityIssues(hornRequest, horn.response, makeReasonerTrustExpectation(tools.horn)),
            name,
        ).toEqual([]);
    }
    if (process.env.HORN_DIFFERENTIAL_LOG !== undefined) {
        appendFileSync(
            process.env.HORN_DIFFERENTIAL_LOG,
            `${JSON.stringify({ name, v1Ms: Math.round(v1.wallMs), hornMs: Math.round(horn.wallMs), v1: summary(v1.response), horn: summary(horn.response), v1Statements: statements(v1.response).length, hornStatements: statements(horn.response).length })}\n`,
        );
    }
    // V1 refuses what PurRDF cannot certify; the Horn saturation may decide it. Compare decided pairs.
    if (v1.response.result.outcome !== 'decided') return;
    expect(summary(horn.response), name).toEqual(summary(v1.response));
    const v1Statements = statements(v1.response);
    const hornStatements = new Set(statements(horn.response));
    expect(v1Statements.filter((statement) => !hornStatements.has(statement)), `${name}: only V1`).toEqual([]);
    const v1Set = new Set(v1Statements);
    expect([...hornStatements].filter((statement) => !v1Set.has(statement)), `${name}: only Horn`).toEqual([]);
}

describe.skipIf(!enabled)('Horn calculus against the 0.2 procedure on V1 requests', () => {
    const tools = enabled
        ? { v1: probeTool(v1Binary as string), horn: probeTool(hornBinary as string) }
        : (undefined as never);
    const scenarios = (
        JSON.parse(readFileSync(resolve(fixtureDirectory, 'manifest.json'), 'utf8')) as { scenarios: string[] }
    ).scenarios;
    for (const scenario of scenarios) {
        test(`known answer ${scenario}`, () => {
            const request = JSON.parse(
                readFileSync(resolve(fixtureDirectory, `${scenario}.request.json`), 'utf8'),
            ) as ReasonerRequest;
            compare(scenario, request, tools);
        });
    }
    for (const shape of [...TIMING_SHAPES, ...DIFFERENTIAL_SHAPES.filter((item) => item.rich === true)]) {
        test(`timing shape ${shape.name}`, { timeout: 600_000 }, () => {
            compare(shape.name, timingRequest(shape, tools.v1, 120_000), tools);
        });
    }
});
