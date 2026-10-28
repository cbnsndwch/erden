import { Effect, Fiber } from 'effect';
import { DataFactory } from 'n3';
import { describe, expect, it, vi } from 'vitest';

import { resolveBundledReasonerArtifact } from '@erden/reasoner-distribution';
import {
    MAX_REASONER_WIRE_BYTES,
    REASONER_PROTOCOL_VERSION,
    encodeReasonerResponseJson,
    stringifyCanonicalJson,
    type ReasonerResponse,
} from '@erden/reasoner-protocol';

import {
    MAX_REASONER_STDERR_BYTES,
    ReasonerNormalizationError,
    ReasonerProcessError,
    TrustedNegativeReasonerOutcomeError,
    decideAndMaterializeAssembledOntology,
    decideAssembledOntology,
    makeNodeReasonerProcessPort,
    materializeReasonerDecision,
    snapshotAssembledOntology,
    type ReasonerClock,
    type ReasonerProcessPort,
    type ReasonerProcessRequest,
} from '../src/index.js';

import { assembleFixtures, dynamicResponsePort, fakeSpawner, makeFakeChild } from './reasoner-helpers.js';

const PREFIXES = `
@prefix ex: <https://example.test/root#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
`;
const artifact = resolveBundledReasonerArtifact();

async function processFailure(
    process: ReasonerProcessPort,
): Promise<ReasonerProcessError | ReasonerNormalizationError> {
    const graph = await assembleFixtures([
        {
            id: 'source:root',
            locator: 'root.ttl',
            text: `${PREFIXES} ex:A a owl:Class .`,
        },
    ]);
    const standalone = await Effect.runPromise(Effect.flip(decideAssembledOntology(graph, { process })));
    // The check kernel's path verifies the answer through the same single checks and must refuse alike.
    const fused = await Effect.runPromise(Effect.flip(decideAndMaterializeAssembledOntology(graph, { process })));
    expect(fused).toBeInstanceOf(standalone.constructor);
    expect(fused).toMatchObject({ code: standalone.code });
    return standalone;
}

describe('bounded bundled-reasoner child process', () => {
    it('writes exactly one request, uses the validated direct process shape, sanitizes test mode, and allows bounded diagnostics', async () => {
        const original = process.env.ERDEN_REASONER_TEST_WORKER_MODE;
        process.env.ERDEN_REASONER_TEST_WORKER_MODE = 'malicious-test-mode';
        let captured: Parameters<NonNullable<Parameters<typeof fakeSpawner>[1]>> | undefined;
        const requestWire = '{"request":"one"}\n';
        const spawner = fakeSpawner(
            (control) => {
                control.stderr.end('bounded diagnostic');
                control.stdout.end('response\n');
                control.close(0);
            },
            (...args) => {
                captured = args;
            },
        );
        const port = makeNodeReasonerProcessPort({ spawn: spawner });
        try {
            const output = await Effect.runPromise(
                port.run({
                    path: artifact.path,
                    wire: requestWire,
                    timeoutMs: 1_000,
                }),
            );
            expect(Buffer.from(output.stdout).toString()).toBe('response\n');
            expect(output.stderrBytes).toBe(Buffer.byteLength('bounded diagnostic'));
            expect(captured?.[0]).toBe(artifact.path);
            expect(captured?.[1]).toEqual([]);
            expect(captured?.[2]).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            expect(captured?.[2].env?.ERDEN_REASONER_TEST_WORKER_MODE).toBeUndefined();
        } finally {
            if (original === undefined) {
                delete process.env.ERDEN_REASONER_TEST_WORKER_MODE;
            } else {
                process.env.ERDEN_REASONER_TEST_WORKER_MODE = original;
            }
        }
    });

    it('accepts the exact request and stdout ceilings including LF', async () => {
        let control = makeFakeChild();
        const spawner = fakeSpawner((next) => {
            control = next;
            next.stdout.end(Buffer.alloc(MAX_REASONER_WIRE_BYTES, 0x61));
            next.close(0);
        });
        const wire = `${'x'.repeat(MAX_REASONER_WIRE_BYTES - 1)}\n`;
        const output = await Effect.runPromise(
            makeNodeReasonerProcessPort({ spawn: spawner }).run({
                path: artifact.path,
                wire,
                timeoutMs: 1_000,
            }),
        );
        expect(output.stdout.byteLength).toBe(MAX_REASONER_WIRE_BYTES);
        expect(control.stdinBytes().byteLength).toBe(MAX_REASONER_WIRE_BYTES);
        expect(control.stdinBytes().at(-1)).toBe(0x0a);
    });

    it('rejects request ceiling plus one before spawn', async () => {
        const spawn = vi.fn(
            fakeSpawner((control) => {
                control.close(0);
            }),
        );
        const port = makeNodeReasonerProcessPort({ spawn });
        const failure = await Effect.runPromise(
            Effect.flip(
                port.run({
                    path: artifact.path,
                    wire: `${'x'.repeat(MAX_REASONER_WIRE_BYTES)}\n`,
                    timeoutMs: 1_000,
                }),
            ),
        );
        expect(failure).toMatchObject({ code: 'REQUEST_TOO_LARGE' });
        expect(spawn).not.toHaveBeenCalled();
    });

    it('kills and reaps on stdout ceiling plus one with overflow taking precedence over exit', async () => {
        let control = makeFakeChild();
        const port = makeNodeReasonerProcessPort({
            spawn: fakeSpawner((next) => {
                control = next;
                next.stdout.write(Buffer.alloc(MAX_REASONER_WIRE_BYTES));
                next.stdout.write(Buffer.from([0]));
                next.close(9);
            }),
        });
        const failure = await Effect.runPromise(
            Effect.flip(
                port.run({
                    path: artifact.path,
                    wire: '{}\n',
                    timeoutMs: 1_000,
                }),
            ),
        );
        expect(failure).toMatchObject({ code: 'STDOUT_OVERFLOW' });
        expect(control.killCalls).toEqual(['SIGKILL']);
    });

    it('allows the exact stderr cap and rejects cap plus one', async () => {
        const exact = makeNodeReasonerProcessPort({
            spawn: fakeSpawner((control) => {
                control.stderr.end(Buffer.alloc(MAX_REASONER_STDERR_BYTES));
                control.stdout.end('ok');
                control.close(0);
            }),
        });
        await expect(
            Effect.runPromise(exact.run({ path: artifact.path, wire: '{}\n', timeoutMs: 1_000 })),
        ).resolves.toMatchObject({ stderrBytes: MAX_REASONER_STDERR_BYTES });

        const overflow = makeNodeReasonerProcessPort({
            spawn: fakeSpawner((control) => {
                control.stderr.end(Buffer.alloc(MAX_REASONER_STDERR_BYTES + 1));
                control.close(0);
            }),
        });
        const failure = await Effect.runPromise(
            Effect.flip(
                overflow.run({
                    path: artifact.path,
                    wire: '{}\n',
                    timeoutMs: 1_000,
                }),
            ),
        );
        expect(failure).toMatchObject({ code: 'STDERR_OVERFLOW' });
    });

    it('reports synchronous spawn failures, asynchronous spawn failures, EPIPE, and nonzero exits', async () => {
        const thrown = makeNodeReasonerProcessPort({
            spawn: () => {
                throw new Error('spawn failed');
            },
        });
        expect(
            await Effect.runPromise(
                Effect.flip(
                    thrown.run({
                        path: artifact.path,
                        wire: '{}\n',
                        timeoutMs: 1_000,
                    }),
                ),
            ),
        ).toMatchObject({ code: 'PROCESS_SPAWN_FAILED' });

        const emitted = makeNodeReasonerProcessPort({
            spawn: fakeSpawner((control) => {
                control.child.emit('error', new Error('spawn event'));
                control.close(null);
            }),
        });
        expect(
            await Effect.runPromise(
                Effect.flip(
                    emitted.run({
                        path: artifact.path,
                        wire: '{}\n',
                        timeoutMs: 1_000,
                    }),
                ),
            ),
        ).toMatchObject({ code: 'PROCESS_SPAWN_FAILED' });

        const epipe = makeNodeReasonerProcessPort({
            spawn: fakeSpawner((control) => {
                control.child.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
                control.close(null);
            }),
        });
        expect(
            await Effect.runPromise(
                Effect.flip(
                    epipe.run({
                        path: artifact.path,
                        wire: '{}\n',
                        timeoutMs: 1_000,
                    }),
                ),
            ),
        ).toMatchObject({ code: 'STDIN_FAILED' });

        const syncControl = makeFakeChild();
        syncControl.child.stdin.end = () => {
            throw new Error('synchronous stdin failure');
        };
        const syncStdin = makeNodeReasonerProcessPort({ spawn: () => syncControl.child });
        expect(
            await Effect.runPromise(
                Effect.flip(
                    syncStdin.run({
                        path: artifact.path,
                        wire: '{}\n',
                        timeoutMs: 1_000,
                    }),
                ),
            ),
        ).toMatchObject({ code: 'STDIN_FAILED' });
        expect(syncControl.killCalls).toEqual(['SIGKILL']);

        const nonzero = makeNodeReasonerProcessPort({
            spawn: fakeSpawner((control) => {
                control.close(7);
            }),
        });
        expect(
            await Effect.runPromise(
                Effect.flip(
                    nonzero.run({
                        path: artifact.path,
                        wire: '{}\n',
                        timeoutMs: 1_000,
                    }),
                ),
            ),
        ).toMatchObject({ code: 'NONZERO_EXIT', details: { exitCode: 7 } });
    });

    it('turns stdout and stderr stream errors into deterministic failures and reaps the child', async () => {
        let stdoutControl = makeFakeChild();
        const stdoutPort = makeNodeReasonerProcessPort({
            spawn: fakeSpawner((control) => {
                stdoutControl = control;
                control.stdout.emit('error', new Error('stdout failed'));
            }),
        });
        expect(
            await Effect.runPromise(
                Effect.flip(
                    stdoutPort.run({
                        path: artifact.path,
                        wire: '{}\n',
                        timeoutMs: 1_000,
                    }),
                ),
            ),
        ).toMatchObject({ code: 'STDOUT_STREAM_FAILED' });
        expect(stdoutControl.killCalls).toEqual(['SIGKILL']);

        let stderrControl = makeFakeChild();
        const stderrPort = makeNodeReasonerProcessPort({
            spawn: fakeSpawner((control) => {
                stderrControl = control;
                control.stderr.emit('error', new Error('stderr failed'));
            }),
        });
        expect(
            await Effect.runPromise(
                Effect.flip(
                    stderrPort.run({
                        path: artifact.path,
                        wire: '{}\n',
                        timeoutMs: 1_000,
                    }),
                ),
            ),
        ).toMatchObject({ code: 'STDERR_STREAM_FAILED' });
        expect(stderrControl.killCalls).toEqual(['SIGKILL']);
    });

    it('enforces the outer deadline, kills the direct supervisor, and waits for close', async () => {
        let control = makeFakeChild();
        const port = makeNodeReasonerProcessPort({
            spawn: fakeSpawner((next) => {
                control = next;
            }),
        });
        const failure = await Effect.runPromise(
            Effect.flip(
                port.run({
                    path: artifact.path,
                    wire: '{}\n',
                    timeoutMs: 1,
                }),
            ),
        );
        expect(failure).toMatchObject({ code: 'PROCESS_TIMEOUT' });
        expect(control.killCalls).toEqual(['SIGKILL']);
    });

    it('kills the direct supervisor when the Effect is interrupted', async () => {
        let control = makeFakeChild();
        const port = makeNodeReasonerProcessPort({
            spawn: fakeSpawner((next) => {
                control = next;
            }),
        });
        const fiber = Effect.runFork(port.run({ path: artifact.path, wire: '{}\n', timeoutMs: 10_000 }));
        await new Promise((resolve) => setImmediate(resolve));
        await Effect.runPromise(Fiber.interrupt(fiber));
        await new Promise((resolve) => setImmediate(resolve));
        expect(control.killCalls).toEqual(['SIGKILL']);
    });

    it('chunks deadlines beyond the JavaScript timer maximum instead of firing immediately', async () => {
        const delays: number[] = [];
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const clock: ReasonerClock = {
            now: () => 0,
            setTimer: (_callback, delay) => {
                delays.push(delay);
                const token = {} as ReturnType<typeof setTimeout>;
                timers.add(token);
                return token;
            },
            clearTimer: (timer) => {
                timers.delete(timer);
            },
        };
        const port = makeNodeReasonerProcessPort({
            clock,
            spawn: fakeSpawner((control) => {
                control.stdout.end('ok');
                control.close(0);
            }),
        });
        await Effect.runPromise(
            port.run({
                path: artifact.path,
                wire: '{}\n',
                timeoutMs: Number.MAX_SAFE_INTEGER,
            }),
        );
        expect(delays).toEqual([2_147_483_647]);
        expect(timers.size).toBe(0);
    });

    it('rejects paths not produced as absolute validated artifact paths', async () => {
        const spawn = vi.fn(
            fakeSpawner((control) => {
                control.close(0);
            }),
        );
        const failure = await Effect.runPromise(
            Effect.flip(
                makeNodeReasonerProcessPort({ spawn }).run({
                    path: 'erden-reasoner',
                    wire: '{}\n',
                    timeoutMs: 1_000,
                }),
            ),
        );
        expect(failure).toMatchObject({ code: 'INVALID_EXECUTABLE_PATH' });
        expect(spawn).not.toHaveBeenCalled();
    });
});

describe('strict response framing, identity, outcome, and proof order', () => {
    it('rejects forged assembled provenance before invoking a process port', async () => {
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES} ex:A a owl:Class .`,
            },
        ]);
        const run = vi.fn(dynamicResponsePort().run);
        const failure = await Effect.runPromise(
            Effect.flip(decideAssembledOntology({ ...graph, provenance: [] }, { process: Object.freeze({ run }) })),
        );
        expect(failure).toMatchObject({ code: 'INVALID_ASSEMBLED_ONTOLOGY' });
        expect(run).not.toHaveBeenCalled();
    });

    it('accepts a canonical fully verified response and retains bounded stderr size only', async () => {
        const process = dynamicResponsePort();
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES} ex:A a owl:Class .`,
            },
        ]);
        const decision = await Effect.runPromise(decideAssembledOntology(graph, { process }));
        expect(decision.response.result.outcome).toBe('decided');
        expect(decision.normalization.request.requiredTool).toEqual(artifact.requiredTool);
        expect(decision.stderrBytes).toBe(0);
    });

    it.each([
        ['nonzero exit', { exitCode: 7 }, 'NONZERO_EXIT'],
        ['negative stderr size', { stderrBytes: -1 }, 'INVALID_PROCESS_OUTPUT'],
        ['oversized stderr size', { stderrBytes: MAX_REASONER_STDERR_BYTES + 1 }, 'INVALID_PROCESS_OUTPUT'],
        ['oversized stdout', { stdout: Buffer.alloc(MAX_REASONER_WIRE_BYTES + 1) }, 'STDOUT_OVERFLOW'],
        ['non-byte stdout', { stdout: 'not bytes' }, 'INVALID_PROCESS_OUTPUT'],
    ] as const)('revalidates an injected process port envelope: %s', async (_label, patch, code) => {
        const delegate = dynamicResponsePort();
        const process: ReasonerProcessPort = Object.freeze({
            run: (request: ReasonerProcessRequest) =>
                delegate.run(request).pipe(Effect.map((output) => ({ ...output, ...patch }) as typeof output)),
        });
        expect(await processFailure(process)).toMatchObject({ code });
    });

    it('snapshots the explicit graph and owner metadata before invoking an untrusted process port', async () => {
        const prefixes = ['https://example.test/root#'];
        const owner = {
            canonicalIri: 'https://example.test/root',
            role: 'root' as const,
            ownedIriPrefixes: prefixes,
        };
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                owner,
                text: `${PREFIXES} ex:A a owl:Class .`,
            },
        ]);
        const delegate = dynamicResponsePort();
        const process: ReasonerProcessPort = Object.freeze({
            run: (request: ReasonerProcessRequest) =>
                Effect.gen(function* () {
                    yield* Effect.sync(() => {
                        graph.dataset.removeQuads(graph.dataset.getQuads(null, null, null, null));
                        prefixes.push('https://mutated.invalid/');
                    });
                    return yield* delegate.run(request);
                }),
        });
        const decision = await Effect.runPromise(decideAssembledOntology(graph, { process }));
        expect(graph.dataset.size).toBe(0);
        expect(decision.graph.dataset.size).toBe(1);
        expect(decision.normalization.sourceBindings[0]?.owner.ownedIriPrefixes).toEqual([
            'https://example.test/root#',
        ]);
        expect(materializeReasonerDecision(decision).dataset.size).toBe(1);
    });

    it('reparses the snapshot so mutable RDF term objects cannot alias the caller graph', async () => {
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES} ex:A a owl:Class .`,
            },
        ]);
        const originalSubject = graph.dataset.getQuads(null, null, null, null)[0]?.subject;
        if (originalSubject?.termType !== 'NamedNode') {
            throw new TypeError('Expected named subject');
        }
        const delegate = dynamicResponsePort();
        const process: ReasonerProcessPort = Object.freeze({
            run: (request: ReasonerProcessRequest) =>
                Effect.gen(function* () {
                    yield* Effect.sync(() => {
                        (originalSubject as unknown as { id: string }).id = 'https://mutated.invalid/A';
                    });
                    return yield* delegate.run(request);
                }),
        });
        const decision = await Effect.runPromise(decideAssembledOntology(graph, { process }));
        expect(
            decision.graph.dataset.countQuads(DataFactory.namedNode('https://example.test/root#A'), null, null, null),
        ).toBe(1);
        expect(materializeReasonerDecision(decision).dataset.size).toBe(1);
    });

    it('refuses to materialize a decision against a mutated or substituted snapshot', async () => {
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES} ex:A a owl:Class .`,
            },
        ]);
        const decision = await Effect.runPromise(decideAssembledOntology(graph, { process: dynamicResponsePort() }));
        decision.graph.dataset.addQuad(
            DataFactory.quad(
                DataFactory.namedNode('https://example.test/root#B'),
                DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
                DataFactory.namedNode('http://www.w3.org/2002/07/owl#Class'),
            ),
        );
        expect(() => materializeReasonerDecision(decision)).toThrow(
            expect.objectContaining({
                code: 'REASONER_MATERIALIZATION_FAILED',
            }),
        );

        const other = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES} ex:C a owl:Class .`,
            },
        ]);
        const substituted = Object.freeze({ ...decision, graph: snapshotAssembledOntology(other) });
        expect(() => materializeReasonerDecision(substituted)).toThrow(
            expect.objectContaining({
                code: 'REASONER_MATERIALIZATION_FAILED',
            }),
        );
    });

    it('binds materialization to the full RDF snapshot even when normalization collapses equivalent declarations', async () => {
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES}
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:A a owl:Class, rdfs:Class .
`,
            },
        ]);
        const decision = await Effect.runPromise(decideAssembledOntology(graph, { process: dynamicResponsePort() }));
        const redundant = decision.graph.dataset.getQuads(
            DataFactory.namedNode('https://example.test/root#A'),
            DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
            DataFactory.namedNode('http://www.w3.org/2000/01/rdf-schema#Class'),
            null,
        )[0];
        if (redundant === undefined) {
            throw new TypeError('Expected redundant class declaration');
        }
        decision.graph.dataset.removeQuad(redundant);
        expect(() => materializeReasonerDecision(decision)).toThrow(
            expect.objectContaining({
                code: 'REASONER_MATERIALIZATION_FAILED',
            }),
        );
    });

    it.each([
        ['empty', () => new Uint8Array(), 'EMPTY_RESPONSE'],
        ['invalid UTF-8', () => Uint8Array.from([0xc3, 0x28]), 'INVALID_RESPONSE_UTF8'],
        [
            'BOM',
            (response: ReasonerResponse) =>
                Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encodeReasonerResponseJson(response))]),
            'INVALID_RESPONSE_UTF8',
        ],
        ['malformed JSON', () => '{', 'MALFORMED_RESPONSE'],
        ['wrong schema', () => '{}\n', 'MALFORMED_RESPONSE'],
        ['pretty JSON', (response: ReasonerResponse) => JSON.stringify(response, null, 2), 'NONCANONICAL_RESPONSE'],
        [
            'trailing whitespace',
            (response: ReasonerResponse) => `${encodeReasonerResponseJson(response)}\n`,
            'NONCANONICAL_RESPONSE',
        ],
        [
            'multiple values',
            (response: ReasonerResponse) =>
                `${encodeReasonerResponseJson(response)}${encodeReasonerResponseJson(response)}`,
            'MALFORMED_RESPONSE',
        ],
    ] as const)('rejects %s output', async (_label, output, code) => {
        const failure = await processFailure(dynamicResponsePort((response) => output(response)));
        expect(failure).toMatchObject({ code });
    });

    it.each([
        ['request ID', (response: ReasonerResponse) => ({ ...response, requestId: 'wrong:request' })],
        [
            'profile',
            (response: ReasonerResponse) => ({
                ...response,
                profile: { ...response.profile, digest: `sha256:${'1'.repeat(64)}` },
            }),
        ],
        ['input digest', (response: ReasonerResponse) => ({ ...response, inputDigest: `sha256:${'2'.repeat(64)}` })],
        [
            'tool',
            (response: ReasonerResponse) => ({ ...response, tool: { ...response.tool, version: 'wrong-version' } }),
        ],
    ])('rejects wrong %s before inspecting semantic proof', async (_label, mutate) => {
        const failure = await processFailure(
            dynamicResponsePort((response) => encodeReasonerResponseJson(mutate(response))),
        );
        expect(failure).toMatchObject({ code: 'UNTRUSTED_RESPONSE' });
    });

    it('surfaces trusted refused and incompatible outcomes distinctly', async () => {
        const refused = await processFailure(
            dynamicResponsePort((response) =>
                encodeReasonerResponseJson({
                    ...response,
                    result: {
                        outcome: 'refused',
                        completeness: 'incomplete',
                        reason: 'unsupported-construct',
                        diagnostics: [
                            { severity: 'error', code: 'unsupported-construct', message: 'unsupported', axiomIds: [] },
                        ],
                    },
                }),
            ),
        );
        expect(refused).toMatchObject({ code: 'REASONER_REFUSED', details: { reason: 'unsupported-construct' } });
        expect(refused).toBeInstanceOf(TrustedNegativeReasonerOutcomeError);
        expect(Object.isFrozen((refused as TrustedNegativeReasonerOutcomeError).context)).toBe(true);
        expect(Object.isFrozen((refused as TrustedNegativeReasonerOutcomeError).context.diagnostics)).toBe(true);
        expect((refused as TrustedNegativeReasonerOutcomeError).context.protocolVersion).toBe(
            REASONER_PROTOCOL_VERSION,
        );

        const incompatible = await processFailure(
            dynamicResponsePort((response) =>
                encodeReasonerResponseJson({
                    ...response,
                    result: {
                        outcome: 'incompatible',
                        completeness: 'incomplete',
                        reason: 'input-digest',
                        expected: 'expected digest',
                        actual: 'actual digest',
                        diagnostics: [
                            { severity: 'error', code: 'input-digest', message: 'incompatible', axiomIds: [] },
                        ],
                    },
                }),
            ),
        );
        expect(incompatible).toMatchObject({
            code: 'REASONER_INCOMPATIBLE',
            details: { reason: 'input-digest', expected: 'expected digest', actual: 'actual digest' },
            context: {
                outcome: 'incompatible',
                reason: 'input-digest',
                expected: 'expected digest',
                actual: 'actual digest',
            },
        });
        expect(incompatible).toBeInstanceOf(TrustedNegativeReasonerOutcomeError);
        expect(Object.isFrozen((incompatible as TrustedNegativeReasonerOutcomeError).context)).toBe(true);
        expect((incompatible as TrustedNegativeReasonerOutcomeError).context.protocolVersion).toBe(
            REASONER_PROTOCOL_VERSION,
        );
    });

    it.each(['refused', 'incompatible'] as const)(
        'authenticates every %s response envelope before classifying the negative outcome',
        async (outcome) => {
            const result: ReasonerResponse['result'] =
                outcome === 'refused'
                    ? {
                          outcome: 'refused' as const,
                          completeness: 'incomplete' as const,
                          reason: 'unsupported-construct' as const,
                          diagnostics: [
                              {
                                  severity: 'error',
                                  code: 'unsupported-construct',
                                  message: 'unsupported',
                                  axiomIds: [],
                              },
                          ],
                      }
                    : {
                          outcome: 'incompatible' as const,
                          completeness: 'incomplete' as const,
                          reason: 'input-digest' as const,
                          expected: 'expected digest',
                          actual: 'actual digest',
                          diagnostics: [
                              { severity: 'error', code: 'input-digest', message: 'incompatible', axiomIds: [] },
                          ],
                      };
            const mutations: ReadonlyArray<(response: ReasonerResponse) => ReasonerResponse> = [
                (response) => ({ ...response, requestId: 'wrong:request', result }),
                (response) => ({
                    ...response,
                    profile: { ...response.profile, digest: `sha256:${'1'.repeat(64)}` },
                    result,
                }),
                (response) => ({ ...response, inputDigest: `sha256:${'2'.repeat(64)}`, result }),
                (response) => ({ ...response, tool: { ...response.tool, version: 'wrong-version' }, result }),
            ];
            for (const mutate of mutations) {
                const failure = await processFailure(
                    dynamicResponsePort((response) => encodeReasonerResponseJson(mutate(response))),
                );
                expect(failure).toMatchObject({ code: 'UNTRUSTED_RESPONSE' });
                expect(failure).not.toBeInstanceOf(TrustedNegativeReasonerOutcomeError);
            }
        },
    );

    it('rejects unchecked certificates at schema decode and invalid checked proofs at trust verification', async () => {
        const unchecked = await processFailure(
            dynamicResponsePort((response) =>
                stringifyCanonicalJson({
                    ...response,
                    result:
                        response.result.outcome === 'decided'
                            ? { ...response.result, certificate: { ...response.result.certificate, checked: false } }
                            : response.result,
                }),
            ),
        );
        expect(unchecked).toMatchObject({ code: 'MALFORMED_RESPONSE' });

        const invalidProof = await processFailure(
            dynamicResponsePort((response) => {
                if (response.result.outcome !== 'decided') {
                    throw new Error('Expected decided response');
                }
                return encodeReasonerResponseJson({
                    ...response,
                    result: {
                        ...response.result,
                        inferred: [
                            {
                                id: 'inferred:forged',
                                subject: 'https://example.test/root#alice',
                                predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
                                object: 'https://example.test/root#NotEntailed',
                                graph: { kind: 'DefaultGraph' },
                                provenance: {
                                    kind: 'inferred',
                                    rule: 'subclass-type',
                                    premiseIds: [response.result.certificate.inputDigest],
                                    justificationDigest: `sha256:${'3'.repeat(64)}`,
                                },
                            },
                        ],
                    },
                });
            }),
        );
        expect(invalidProof).toMatchObject({ code: 'UNTRUSTED_RESPONSE' });
    });

    it('rejects an answer whose certificate names another input digest', async () => {
        const failure = await processFailure(
            dynamicResponsePort((response) => {
                if (response.result.outcome !== 'decided') {
                    throw new Error('Expected decided response');
                }
                return encodeReasonerResponseJson({
                    ...response,
                    result: {
                        ...response.result,
                        certificate: { ...response.result.certificate, inputDigest: `sha256:${'4'.repeat(64)}` },
                    },
                });
            }),
        );
        expect(failure).toMatchObject({ code: 'UNTRUSTED_RESPONSE' });
    });

    it('propagates typed transport errors without treating them as semantic outcomes', async () => {
        const process: ReasonerProcessPort = Object.freeze({
            run: () => Effect.fail(new ReasonerProcessError('PROCESS_TIMEOUT', 'fixture timeout')),
        });
        expect(await processFailure(process)).toMatchObject({ code: 'PROCESS_TIMEOUT' });
    });

    it('rejects a non-complete decided shape before proof verification', async () => {
        const failure = await processFailure(
            dynamicResponsePort((response) =>
                stringifyCanonicalJson({
                    ...response,
                    result:
                        response.result.outcome === 'decided'
                            ? { ...response.result, completeness: 'incomplete' }
                            : response.result,
                }),
            ),
        );
        expect(failure).toMatchObject({ code: 'MALFORMED_RESPONSE' });
    });
});
