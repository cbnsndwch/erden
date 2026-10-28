import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { resolveBundledReasonerArtifact } from '@erden/reasoner-distribution';
import { MAX_REASONER_WIRE_BYTES, decodeReasonerRequestJson } from '@erden/reasoner-protocol';

import {
    DEFAULT_REASONER_LIMITS,
    REASONER_LIMIT_ENVIRONMENT_NAMES,
    REASONER_LIMIT_SETTINGS,
    ReasonerLimitSettingError,
    decideAssembledOntology,
    normalizeAssembledOntology,
    parseReasonerLimits,
    reasonerWireCeiling,
    snapshotAssembledOntology,
    validateReasonerLimits,
    type ReasonerProcessRequest,
} from '../src/index.js';

import { assembleFixtures, dynamicResponsePort } from './reasoner-helpers.js';

const artifact = resolveBundledReasonerArtifact();
const ONTOLOGY = `
@prefix ex: <https://example.test/root#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:A a owl:Class .
ex:B a owl:Class ; rdfs:subClassOf ex:A .
ex:i a ex:B .
`;

describe('reasoner limits as deployment settings', () => {
    it('defaults to exactly the limits the reasoner has always used', () => {
        expect(DEFAULT_REASONER_LIMITS).toEqual({
            maxWallTimeMs: 30_000,
            maxInputAxioms: 100_000,
            maxInferences: 100_000,
            maxRequestBytes: 16_777_216,
        });
        expect(Object.isFrozen(DEFAULT_REASONER_LIMITS)).toBe(true);
        expect(parseReasonerLimits({})).toEqual(DEFAULT_REASONER_LIMITS);
        expect(REASONER_LIMIT_SETTINGS.map((item) => item.variable)).toEqual([...REASONER_LIMIT_ENVIRONMENT_NAMES]);
    });

    it('reads each variable inside its inclusive bounds', () => {
        expect(
            parseReasonerLimits({
                ERDEN_REASONER_MAX_WALL_TIME_MS: '1000',
                ERDEN_REASONER_MAX_INPUT_AXIOMS: '1000000',
                ERDEN_REASONER_MAX_INFERENCES: '1',
                ERDEN_REASONER_MAX_REQUEST_BYTES: '134217728',
            }),
        ).toEqual({
            maxWallTimeMs: 1_000,
            maxInputAxioms: 1_000_000,
            maxInferences: 1,
            maxRequestBytes: MAX_REASONER_WIRE_BYTES,
        });
        expect(parseReasonerLimits({ ERDEN_REASONER_MAX_REQUEST_BYTES: '1048576' }).maxRequestBytes).toBe(1_048_576);
        expect(parseReasonerLimits({ ERDEN_REASONER_MAX_WALL_TIME_MS: '600000' }).maxWallTimeMs).toBe(600_000);
    });

    it.each([
        ['ERDEN_REASONER_MAX_WALL_TIME_MS', '999'],
        ['ERDEN_REASONER_MAX_WALL_TIME_MS', '600001'],
        ['ERDEN_REASONER_MAX_WALL_TIME_MS', ''],
        ['ERDEN_REASONER_MAX_WALL_TIME_MS', '30s'],
        ['ERDEN_REASONER_MAX_WALL_TIME_MS', '030000'],
        ['ERDEN_REASONER_MAX_WALL_TIME_MS', ' 30000'],
        ['ERDEN_REASONER_MAX_WALL_TIME_MS', '3e4'],
        ['ERDEN_REASONER_MAX_INPUT_AXIOMS', '0'],
        ['ERDEN_REASONER_MAX_INPUT_AXIOMS', '1000001'],
        ['ERDEN_REASONER_MAX_INPUT_AXIOMS', '-1'],
        ['ERDEN_REASONER_MAX_INFERENCES', '0'],
        ['ERDEN_REASONER_MAX_INFERENCES', '1.5'],
        ['ERDEN_REASONER_MAX_INFERENCES', '99999999999999999999'],
        ['ERDEN_REASONER_MAX_REQUEST_BYTES', '1048575'],
        ['ERDEN_REASONER_MAX_REQUEST_BYTES', '134217729'],
        ['ERDEN_REASONER_MAX_REQUEST_BYTES', '16MiB'],
    ])('refuses %s=%j with an error that names the variable and its bounds', (variable, value) => {
        let caught: unknown;
        try {
            parseReasonerLimits({ [variable]: value });
        } catch (cause) {
            caught = cause;
        }
        expect(caught).toBeInstanceOf(ReasonerLimitSettingError);
        expect((caught as ReasonerLimitSettingError).variable).toBe(variable);
        expect((caught as Error).message).toContain(variable);
        expect((caught as Error).message).toMatch(/from \d+ to \d+/u);
    });

    it('validates an in-memory limits value against the same bounds', () => {
        expect(validateReasonerLimits({ ...DEFAULT_REASONER_LIMITS, maxWallTimeMs: 120_000 }).maxWallTimeMs).toBe(
            120_000,
        );
        expect(() => validateReasonerLimits({ ...DEFAULT_REASONER_LIMITS, maxWallTimeMs: 1 })).toThrow(
            ReasonerLimitSettingError,
        );
    });

    it('keeps limits out of the input digest and request identity while sending them on the wire', async () => {
        const graph = snapshotAssembledOntology(
            await assembleFixtures([{ id: 'source:root', locator: 'root.ttl', text: ONTOLOGY }]),
        );
        const base = normalizeAssembledOntology(graph, artifact.requiredTool);
        const raised = normalizeAssembledOntology(graph, artifact.requiredTool, {
            limits: { maxWallTimeMs: 600_000, maxInputAxioms: 1_000_000, maxInferences: 1_000_000 },
        });
        const { maxRequestBytes: _ceiling, ...requestDefaults } = DEFAULT_REASONER_LIMITS;
        expect(base.request.limits).toEqual(requestDefaults);
        expect(raised.request.limits).toEqual({
            maxWallTimeMs: 600_000,
            maxInputAxioms: 1_000_000,
            maxInferences: 1_000_000,
        });
        expect(raised.request.ontology.digest).toBe(base.request.ontology.digest);
        expect(raised.request.requestId).toBe(base.request.requestId);
        expect(raised.request.requiredTool).toEqual(base.request.requiredTool);
        expect(raised.request.profile).toEqual(base.request.profile);
        expect(raised.axiomBindings).toEqual(base.axiomBindings);
    });

    it('passes the decide limits to the request and the parent deadline', async () => {
        const graph = await assembleFixtures([{ id: 'source:root', locator: 'root.ttl', text: ONTOLOGY }]);
        const seen: ReasonerProcessRequest[] = [];
        const inner = dynamicResponsePort();
        const process = Object.freeze({
            run: (request: ReasonerProcessRequest) => {
                seen.push(request);
                return inner.run(request);
            },
        });
        await Effect.runPromise(
            decideAssembledOntology(graph, {
                process,
                limits: { maxWallTimeMs: 120_000, maxInputAxioms: 50, maxInferences: 60 },
            }),
        );
        expect(seen).toHaveLength(1);
        expect(decodeReasonerRequestJson(seen[0]?.wire ?? '').limits).toEqual({
            maxWallTimeMs: 120_000,
            maxInputAxioms: 50,
            maxInferences: 60,
        });
        expect(seen[0]?.timeoutMs).toBe(122_000);
    });
});

function classes(prefix: string, count: number): string {
    const lines = ['@prefix ex: <https://example.test/root#> .', '@prefix owl: <http://www.w3.org/2002/07/owl#> .'];
    for (let index = 0; index < count; index += 1) {
        lines.push(`ex:${prefix}${String(index)} a owl:Class .`);
    }
    return `${lines.join('\n')}\n`;
}

describe('the request ceiling', () => {
    const neverRun = Object.freeze({
        run: () => Effect.die(new Error('the reasoner must not start for a request over the ceiling')),
    });

    async function sizedGraph() {
        return assembleFixtures([
            { id: 'source:small', locator: 'small.ttl', text: classes('Small', 50) },
            { id: 'source:large', locator: 'large.ttl', text: classes('Large', 2_500) },
            { id: 'source:tiny', locator: 'tiny.ttl', text: classes('Tiny', 5) },
            { id: 'source:middle', locator: 'middle.ttl', text: classes('Middle', 900) },
        ]);
    }

    it('refuses before the process starts, naming the bytes, the ceiling, the variable and the largest sources', async () => {
        const graph = await sizedGraph();
        const failure = await Effect.runPromise(
            Effect.flip(
                decideAssembledOntology(graph, {
                    process: neverRun,
                    limits: { ...DEFAULT_REASONER_LIMITS, maxRequestBytes: 1_048_576 },
                }),
            ),
        );
        expect(failure).toMatchObject({
            code: 'REQUEST_TOO_LARGE',
            details: {
                maximumBytes: 1_048_576,
                variable: 'ERDEN_REASONER_MAX_REQUEST_BYTES',
                hardMaximumBytes: MAX_REASONER_WIRE_BYTES,
                sources: [
                    { sourceId: 'source:large', locator: 'large.ttl', axioms: 2_500 },
                    { sourceId: 'source:middle', locator: 'middle.ttl', axioms: 900 },
                    { sourceId: 'source:small', locator: 'small.ttl', axioms: 50 },
                ],
            },
        });
        const actualBytes = (failure as unknown as { details: { actualBytes: number } }).details.actualBytes;
        expect(actualBytes).toBeGreaterThan(1_048_576);
        expect(failure.message).toBe(
            `Canonical reasoner request is ${String(actualBytes)} bytes, over the 1048576-byte request ceiling; ERDEN_REASONER_MAX_REQUEST_BYTES sets it (1048576 to 134217728 bytes)`,
        );
    });

    it('sends the same request under the default ceiling, which changes nothing', async () => {
        const graph = await sizedGraph();
        const decision = await Effect.runPromise(decideAssembledOntology(graph, { process: dynamicResponsePort() }));
        const bytes = Buffer.byteLength(decision.normalization.wire, 'utf8');
        expect(bytes).toBeGreaterThan(1_048_576);
        expect(bytes).toBeLessThan(DEFAULT_REASONER_LIMITS.maxRequestBytes);
    });
});

describe('the wire ceiling bounds the answer too and never exceeds what the bundled reasoner reads', () => {
    function capturing(output?: Buffer) {
        const seen: ReasonerProcessRequest[] = [];
        const inner = dynamicResponsePort();
        return {
            seen,
            port: Object.freeze({
                run: (request: ReasonerProcessRequest) => {
                    seen.push(request);
                    return output === undefined
                        ? inner.run(request)
                        : Effect.succeed(Object.freeze({ stdout: output, stderrBytes: 0, exitCode: 0 }));
                },
            }),
        };
    }

    it('knows the ceiling of each reasoner release, and holds an unknown one to 16 MiB', () => {
        expect(reasonerWireCeiling('0.1.0+purrdf.0.12.0.dfb1df7')).toBe(16_777_216);
        expect(reasonerWireCeiling('0.2.0+purrdf.0.12.0.dfb1df7')).toBe(MAX_REASONER_WIRE_BYTES);
        expect(reasonerWireCeiling('0.3.0+purrdf.0.12.0.dfb1df7')).toBe(MAX_REASONER_WIRE_BYTES);
        expect(reasonerWireCeiling('9.9.9+unknown')).toBe(16_777_216);
    });

    it('bounds the answer at 16 MiB under default settings, as every earlier release did', async () => {
        const graph = await assembleFixtures([{ id: 'source:root', locator: 'root.ttl', text: ONTOLOGY }]);
        const { seen, port } = capturing();
        await Effect.runPromise(decideAssembledOntology(graph, { process: port }));
        expect(seen[0]?.maxResponseBytes).toBe(16_777_216);
    });

    it('refuses an answer above the ceiling, naming the ceiling and its variable', async () => {
        const graph = await assembleFixtures([{ id: 'source:root', locator: 'root.ttl', text: ONTOLOGY }]);
        const { seen, port } = capturing(Buffer.alloc(1_048_577, 0x20));
        const failure = await Effect.runPromise(
            Effect.flip(
                decideAssembledOntology(graph, {
                    process: port,
                    limits: { ...DEFAULT_REASONER_LIMITS, maxRequestBytes: 1_048_576 },
                }),
            ),
        );
        expect(seen[0]?.maxResponseBytes).toBe(1_048_576);
        expect(failure).toMatchObject({
            code: 'STDOUT_OVERFLOW',
            details: { actualBytes: 1_048_577, maximumBytes: 1_048_576, variable: 'ERDEN_REASONER_MAX_REQUEST_BYTES' },
        });
        expect(failure.message).toContain('ERDEN_REASONER_MAX_REQUEST_BYTES');
    });

    it('holds a raised setting to the bundled reasoner ceiling and names it when a request exceeds it', async () => {
        const raised = { ...DEFAULT_REASONER_LIMITS, maxRequestBytes: 33_554_432 };
        const small = await assembleFixtures([{ id: 'source:root', locator: 'root.ttl', text: ONTOLOGY }]);
        const { seen, port } = capturing();
        await Effect.runPromise(decideAssembledOntology(small, { process: port, limits: raised }));
        const ceiling = reasonerWireCeiling(artifact.requiredTool.version);
        // The answer is bounded by the setting, held to the release's ceiling.
        expect(seen[0]?.maxResponseBytes).toBe(Math.min(ceiling, raised.maxRequestBytes));
        if (ceiling >= raised.maxRequestBytes) {
            // 0.2 reads up to the 128 MiB hard ceiling, the largest setting there is, so no setting can exceed it.
            return;
        }
        const large = await assembleFixtures([
            { id: 'source:large', locator: 'large.ttl', text: classes('Large', 40_000) },
        ]);
        const failure = await Effect.runPromise(
            Effect.flip(
                decideAssembledOntology(large, {
                    process: Object.freeze({
                        run: () => Effect.die(new Error('the reasoner must not start for a request over its ceiling')),
                    }),
                    limits: raised,
                }),
            ),
        );
        expect(failure).toMatchObject({
            code: 'REQUEST_TOO_LARGE',
            details: {
                maximumBytes: ceiling,
                settingBytes: 33_554_432,
                reasonerVersion: artifact.requiredTool.version,
            },
        });
        expect(failure.message).toContain(`${String(ceiling)}-byte ceiling of the bundled reasoner`);
    }, 120_000);
});
