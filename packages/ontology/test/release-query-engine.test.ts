import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    ReleaseQueryEngineError,
    RELEASE_QUERY_ENGINE_LIMITS,
    makeNodeReleaseQueryEngine,
    runConfinedReleaseQueryWorker,
    verifyReleaseQueryEngineDirectory,
    type NodeReleaseQueryEngine,
    type ReleaseQueryEngineInput,
} from '../src/index.js';

function literals(count: number, width = 10): Buffer {
    let text = '';
    for (let index = 0; index < count; index += 1) {
        text += `<urn:s${String(index)}> <urn:p> "${String(index).padStart(width, 'x')}" .\n`;
    }
    return Buffer.from(text);
}

function input(
    declared: Buffer,
    engineQuery: string,
    form: 'select' | 'ask' = 'select',
    multiplicity = 1,
): ReleaseQueryEngineInput {
    return {
        declared: [{ nquads: declared, multiplicity }],
        inferred: [],
        datasetSha256: 'a'.repeat(64),
        engineQuery,
        form,
    };
}

async function outcome(engine: NodeReleaseQueryEngine, value: ReleaseQueryEngineInput, signal?: AbortSignal) {
    try {
        return (await engine.execute(value, signal ?? new AbortController().signal)).outcome;
    } catch (cause) {
        if (cause instanceof ReleaseQueryEngineError) {
            return cause.code;
        }
        throw cause;
    }
}

/**
 * A wall-clock budget no loaded runner reaches. A test that expects another outcome (a resource, row or byte limit, or
 * a protocol fault) runs under it, so that outcome cannot lose a race with the clock. The budget itself is tested by
 * the cases that run under the default or a short one.
 */
const UNHURRIED_MILLISECONDS = 600_000;
/** What a test waits for when its engine runs unhurried. */
const UNHURRIED_TEST_MILLISECONDS = 300_000;

function faultEngine(body: string, workerMilliseconds = UNHURRIED_MILLISECONDS): NodeReleaseQueryEngine {
    return makeNodeReleaseQueryEngine({
        workerSource: `(async () => { for await (const _ of process.stdin) {} ${body} })().catch(() => process.exit(1));`,
        workerMilliseconds,
        skipKnownAnswer: true,
    });
}

/** The variables libuv's Windows process spawn always supplies (uv `required_vars` in src/win/process.c). */
const WINDOWS_REQUIRED_ENVIRONMENT = [
    'HOMEDRIVE',
    'HOMEPATH',
    'LOGONSERVER',
    'PATH',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
] as const;

describe('confined release query engine', () => {
    let engine: NodeReleaseQueryEngine;
    let defaultBudget: NodeReleaseQueryEngine;
    beforeAll(async () => {
        engine = makeNodeReleaseQueryEngine({ workerMilliseconds: UNHURRIED_MILLISECONDS });
        defaultBudget = makeNodeReleaseQueryEngine();
        expect(await engine.start()).toBe(true);
        expect(await defaultBudget.start()).toBe(true);
    }, UNHURRIED_TEST_MILLISECONDS);
    afterAll(async () => {
        await engine.close();
        await defaultBudget.close();
    });

    it('verifies the pinned engine identity and refuses a substituted directory', async () => {
        expect(verifyReleaseQueryEngineDirectory()).not.toBeNull();
        const missing = makeNodeReleaseQueryEngine({ directory: () => null });
        expect(await missing.start()).toBe(false);
        expect(missing.state()).toBe('unavailable');
        expect(await outcome(missing, input(literals(1), 'ASK WHERE { }', 'ask'))).toBe('ENGINE_UNAVAILABLE');
    });

    it(
        'E01 stops a runaway COUNT at the wall-clock budget and frees the slot after exit',
        async () => {
            const started = performance.now();
            expect(
                await outcome(
                    defaultBudget,
                    input(literals(200), 'SELECT (COUNT(*) AS ?c) WHERE { ?a ?p ?x . ?b ?q ?y . ?c ?r ?z . ?d ?t ?w }'),
                ),
            ).toBe('time-limit');
            const elapsed = performance.now() - started;
            expect(elapsed).toBeGreaterThanOrEqual(RELEASE_QUERY_ENGINE_LIMITS.workerMilliseconds - 50);
            expect(elapsed).toBeLessThan(RELEASE_QUERY_ENGINE_LIMITS.workerMilliseconds + 2_000);
            expect(await outcome(defaultBudget, input(literals(1), 'ASK WHERE { ?s ?p ?o . }', 'ask'))).toBe(
                'complete',
            );
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E02 E03 turn materializing cross products into resource limits',
        async () => {
            expect(
                await outcome(
                    engine,
                    input(
                        literals(3_000),
                        'SELECT ?a ?b WHERE { ?a ?p ?x . ?b ?q ?y . } ORDER BY ASC(?x) ASC(?y) LIMIT 1001',
                    ),
                ),
            ).toBe('resource-limit');
            expect(
                await outcome(
                    engine,
                    input(
                        literals(3_000),
                        'SELECT (GROUP_CONCAT(?x) AS ?g) WHERE { ?a ?p ?x . ?b ?q ?y . } LIMIT 1001',
                    ),
                ),
            ).toBe('resource-limit');
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E04 E05 E06 report row and byte limits without returning rows',
        async () => {
            expect(await outcome(engine, input(literals(2_000), 'SELECT ?a WHERE { ?a ?p ?x . } LIMIT 1001'))).toBe(
                'row-limit',
            );
            expect(
                await outcome(engine, input(literals(1_000, 5_000), 'SELECT ?a ?x WHERE { ?a ?p ?x . } LIMIT 1001')),
            ).toBe('result-byte-limit');
            expect(
                await outcome(
                    engine,
                    input(
                        literals(1, 10_000),
                        'SELECT ?y WHERE { ?a ?p ?x . BIND (CONCAT(?x, ?x, ?x, ?x, ?x, ?x, ?x) AS ?y) } LIMIT 1001',
                    ),
                ),
            ).toBe('result-byte-limit');
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E07 E08 keep a backtracking-shaped regex and a deep OPTIONAL chain bounded',
        async () => {
            const started = performance.now();
            const data = Buffer.from(`<urn:s> <urn:p> "${'a'.repeat(900)}b" .\n`);
            expect(
                await outcome(
                    engine,
                    input(data, 'SELECT ?s WHERE { ?s ?p ?o . FILTER (REGEX(?o, "(a+)+$")) } LIMIT 1001'),
                ),
            ).toBe('complete');
            const chain = Array.from(
                { length: 16 },
                (_, index) => `OPTIONAL { ?s${String(index)} <urn:p> ?o${String(index)} . }`,
            ).join(' ');
            expect(['complete', 'row-limit', 'time-limit', 'resource-limit']).toContain(
                await outcome(
                    defaultBudget,
                    input(literals(50), `SELECT * WHERE { ?s <urn:p> ?o . ${chain} } LIMIT 1001`),
                ),
            );
            expect(performance.now() - started).toBeLessThan(
                2 * RELEASE_QUERY_ENGINE_LIMITS.workerMilliseconds + 2_000,
            );
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E09 loads the maximum admissible dataset and answers COUNT within the caps',
        async () => {
            const declared = literals(100_000, 30);
            const inferred = Buffer.from(literals(100_000, 30).toString('utf8').replaceAll('<urn:p>', '<urn:q>'));
            expect(declared.byteLength + inferred.byteLength).toBeLessThanOrEqual(
                RELEASE_QUERY_ENGINE_LIMITS.maxEngineInputBytes,
            );
            const result = await engine.execute(
                {
                    declared: [{ nquads: declared, multiplicity: 1 }],
                    inferred: [{ nquads: inferred, multiplicity: 1 }],
                    datasetSha256: 'b'.repeat(64),
                    engineQuery:
                        'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o . } UNION { GRAPH <urn:erden:release-query:v1:graph:inferred> { ?s ?p ?o . } } } LIMIT 1001',
                    form: 'select',
                },
                new AbortController().signal,
            );
            expect(result.outcome).toBe('complete');
            expect(result.outcome === 'complete' ? result.result : '').toContain('"value":"200000"');
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E19 expands a maximum-multiplicity dataset inside the worker within the caps',
        async () => {
            const started = performance.now();
            const result = await engine.execute(
                {
                    declared: [
                        {
                            nquads: Buffer.from(`_:c14n0 <urn:p> "${'v'.repeat(40)}" .\n_:c14n0 <urn:q> _:c14n1 .\n`),
                            multiplicity: 50_000,
                        },
                    ],
                    inferred: [{ nquads: Buffer.from('_:c14n0 <urn:r> <urn:o> .\n'), multiplicity: 100_000 }],
                    datasetSha256: 'c'.repeat(64),
                    engineQuery:
                        'SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { { ?s <urn:p> ?o . } UNION { GRAPH <urn:erden:release-query:v1:graph:inferred> { ?s ?p ?o . } } } LIMIT 1001',
                    form: 'select',
                },
                new AbortController().signal,
            );
            expect(result.outcome).toBe('complete');
            expect(result.outcome === 'complete' ? result.result : '').toContain('"value":"150000"');
            expect(performance.now() - started).toBeLessThan(RELEASE_QUERY_ENGINE_LIMITS.workerMilliseconds);
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E11 kills a cancelled worker and resolves only after its exit',
        async () => {
            const controller = new AbortController();
            const pending = outcome(
                engine,
                input(literals(200), 'SELECT (COUNT(*) AS ?c) WHERE { ?a ?p ?x . ?b ?q ?y . ?c ?r ?z . }'),
                controller.signal,
            );
            setTimeout(() => {
                controller.abort();
            }, 300);
            expect(await pending).toBe('ENGINE_CANCELLED');
            const directory = verifyReleaseQueryEngineDirectory() ?? '';
            const direct = new AbortController();
            const run = runConfinedReleaseQueryWorker({
                directory,
                source: 'setInterval(() => {}, 1000);',
                input: [],
                signal: direct.signal,
                milliseconds: 10_000,
            });
            setTimeout(() => {
                direct.abort();
            }, 200);
            const observed = await run;
            expect(observed.cancelled).toBe(true);
            expect(observed.signal).toBe('SIGKILL');
            expect(observed.stdout.byteLength).toBe(0);
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E12 admits two engine processes and refuses a third without queueing',
        async () => {
            const slow = input(literals(200), 'SELECT (COUNT(*) AS ?c) WHERE { ?a ?p ?x . ?b ?q ?y . ?c ?r ?z . }');
            const controller = new AbortController();
            const first = outcome(engine, slow, controller.signal);
            const second = outcome(engine, slow, controller.signal);
            expect(await outcome(engine, slow, controller.signal)).toBe('ENGINE_BUSY');
            controller.abort();
            expect(await first).toBe('ENGINE_CANCELLED');
            expect(await second).toBe('ENGINE_CANCELLED');
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E13 decodes only exact framing and never reports complete for injected protocol faults',
        async () => {
            const line = '{"schema":"erden.release-query-worker-response/v1","outcome":"complete","resultBytes":2}';
            const valid = `${line}\\n{}`;
            const STUCK = 'setInterval(() => {}, 1000); await new Promise(() => {});';
            const faults: ReadonlyArray<readonly [string, string, number, string]> = [
                ['valid', `process.stdout.write('${valid}');`, UNHURRIED_MILLISECONDS, 'complete'],
                ['hang', 'setInterval(() => {}, 1000); await new Promise(() => {});', 500, 'time-limit'],
                [
                    'slow',
                    `await new Promise((r) => setTimeout(r, 1500)); process.stdout.write('${valid}');`,
                    500,
                    'time-limit',
                ],
                [
                    'oversized stdout',
                    "const b = 'x'.repeat(1 << 20); for (let i = 0; i < 6; i++) process.stdout.write(b);",
                    UNHURRIED_MILLISECONDS,
                    'resource-limit',
                ],
                [
                    'valid, then stuck at exit',
                    `process.stdout.write('${valid}'); ${STUCK}`,
                    UNHURRIED_MILLISECONDS,
                    'complete',
                ],
                [
                    'a limit, then stuck at exit',
                    `process.stdout.write(JSON.stringify({schema:'erden.release-query-worker-response/v1',outcome:'row-limit'}) + '\\n'); ${STUCK}`,
                    UNHURRIED_MILLISECONDS,
                    'row-limit',
                ],
                [
                    'a wrong schema, then stuck',
                    `process.stdout.write(JSON.stringify({schema:'x',outcome:'row-limit'}) + '\\n'); ${STUCK}`,
                    2_500,
                    'time-limit',
                ],
                ['a partial result, then stuck', `process.stdout.write('${line}\\n{'); ${STUCK}`, 2_500, 'time-limit'],
                ['extra bytes, then stuck', `process.stdout.write('${valid}{}'); ${STUCK}`, 2_500, 'time-limit'],
                ['malformed', "process.stdout.write('{not json}\\n');", UNHURRIED_MILLISECONDS, 'ENGINE_UNAVAILABLE'],
                ['extra bytes', `process.stdout.write('${valid}{}');`, UNHURRIED_MILLISECONDS, 'ENGINE_UNAVAILABLE'],
                ['short result', `process.stdout.write('${line}\\n{');`, UNHURRIED_MILLISECONDS, 'ENGINE_UNAVAILABLE'],
                ['missing newline', `process.stdout.write('${line}');`, UNHURRIED_MILLISECONDS, 'ENGINE_UNAVAILABLE'],
                [
                    'bytes after a limit',
                    `process.stdout.write('{"schema":"erden.release-query-worker-response/v1","outcome":"row-limit"}\\n{}');`,
                    UNHURRIED_MILLISECONDS,
                    'ENGINE_UNAVAILABLE',
                ],
                [
                    'inline result',
                    `process.stdout.write('{"schema":"erden.release-query-worker-response/v1","outcome":"complete","result":"{}"}\\n');`,
                    UNHURRIED_MILLISECONDS,
                    'ENGINE_UNAVAILABLE',
                ],
                [
                    'result over budget',
                    `process.stdout.write('{"schema":"erden.release-query-worker-response/v1","outcome":"complete","resultBytes":${String(RELEASE_QUERY_ENGINE_LIMITS.maxResultBytes + 1)}}\\n');`,
                    UNHURRIED_MILLISECONDS,
                    'ENGINE_UNAVAILABLE',
                ],
                [
                    'invalid utf-8',
                    `process.stdout.write('${line}\\n'); process.stdout.write(Buffer.from([0xc3, 0x28]));`,
                    UNHURRIED_MILLISECONDS,
                    'ENGINE_UNAVAILABLE',
                ],
                [
                    'wrong schema',
                    "process.stdout.write(JSON.stringify({schema:'x',outcome:'complete',resultBytes:0}) + '\\n');",
                    UNHURRIED_MILLISECONDS,
                    'ENGINE_UNAVAILABLE',
                ],
                [
                    'unknown field',
                    "process.stdout.write(JSON.stringify({schema:'erden.release-query-worker-response/v1',outcome:'row-limit',extra:1}) + '\\n');",
                    UNHURRIED_MILLISECONDS,
                    'ENGINE_UNAVAILABLE',
                ],
                [
                    'exit 1',
                    `process.stdout.write('${valid}'); process.exitCode = 1;`,
                    UNHURRIED_MILLISECONDS,
                    'ENGINE_UNAVAILABLE',
                ],
                ['sigsegv', "process.kill(process.pid, 'SIGSEGV');", UNHURRIED_MILLISECONDS, 'ENGINE_UNAVAILABLE'],
                [
                    'stderr flood',
                    `process.stderr.write('e'.repeat(70000)); process.stdout.write('${valid}');`,
                    UNHURRIED_MILLISECONDS,
                    'ENGINE_UNAVAILABLE',
                ],
            ];
            for (const [name, body, budget, expected] of faults) {
                const faulty = faultEngine(body, budget);
                expect(await faulty.start()).toBe(true);
                const run = await outcome(faulty, input(literals(1), 'ASK WHERE { }', 'ask'));
                expect([name, run]).toEqual([name, expected]);
                await faulty.close();
            }
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E20 kills a worker stuck after its whole response, observes the exit, counts it, and keeps the budget authoritative',
        async () => {
            const line = '{"schema":"erden.release-query-worker-response/v1","outcome":"complete","resultBytes":2}';
            const stuck = `process.stdout.write('${line}\\n{}'); setInterval(() => {}, 1000); await new Promise(() => {});`;
            let forced = 0;
            function counted(workerMilliseconds: number): NodeReleaseQueryEngine {
                return makeNodeReleaseQueryEngine({
                    workerSource: `(async () => { for await (const _ of process.stdin) {} ${stuck} })().catch(() => process.exit(1));`,
                    workerMilliseconds,
                    skipKnownAnswer: true,
                    onWorkerExitForced: () => {
                        forced += 1;
                    },
                });
            }
            const accepted = counted(UNHURRIED_MILLISECONDS);
            expect(await accepted.start()).toBe(true);
            expect(await outcome(accepted, input(literals(1), 'ASK WHERE { }', 'ask'))).toBe('complete');
            expect(forced).toBe(1);
            // close() resolves only once no worker is left, and it would hang on a worker whose exit went unobserved.
            await accepted.close();
            // A budget shorter than the grace period: the time limit wins and nothing counts as a forced exit.
            const budgeted = counted(100);
            expect(await budgeted.start()).toBe(true);
            expect(await outcome(budgeted, input(literals(1), 'ASK WHERE { }', 'ask'))).toBe('time-limit');
            expect(forced).toBe(1);
            await budgeted.close();
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E14 confines the worker: empty environment, no reads, no child processes, no string evaluation',
        async () => {
            const directory = verifyReleaseQueryEngineDirectory() ?? '';
            const probe = `(async () => {
            const report = { env: Object.keys(process.env).sort() };
            const fs = await import('node:fs');
            try { fs.readFileSync('/etc/passwd'); report.passwd = 'read'; } catch (e) { report.passwd = e.code; }
            try { (await import('node:child_process')).spawnSync('true'); report.child = 'spawned'; } catch (e) { report.child = e.code; }
            try { new (await import('node:worker_threads')).Worker('1', { eval: true }); report.worker = 'started'; } catch (e) { report.worker = e.code; }
            try { eval('1'); report.eval = 'evaluated'; } catch (e) { report.eval = e.name; }
            try { new Function('return 1')(); report.function = 'evaluated'; } catch (e) { report.function = e.name; }
            try { fs.writeFileSync('/tmp/erden-release-query-probe', 'x'); report.write = 'written'; } catch (e) { report.write = e.code; }
            process.stdout.write(JSON.stringify(report));
        })();`;
            const run = await runConfinedReleaseQueryWorker({
                directory,
                source: probe,
                input: [],
                signal: new AbortController().signal,
                milliseconds: 5_000,
            });
            expect(run.code).toBe(0);
            const report = JSON.parse(run.stdout.toString('utf8')) as { env: string[] } & Record<string, unknown>;
            // libuv cannot start a Windows process without these variables, so it copies them from the parent even for
            // an empty environment. The engine runs only in the Linux server; there the environment is empty.
            const windowsRequired = new Set<string>(WINDOWS_REQUIRED_ENVIRONMENT);
            expect(
                process.platform === 'win32'
                    ? report.env.filter((name) => !windowsRequired.has(name.toUpperCase()))
                    : report.env,
            ).toEqual([]);
            expect({ ...report, env: [] }).toEqual({
                env: [],
                passwd: 'ERR_ACCESS_DENIED',
                child: 'ERR_ACCESS_DENIED',
                worker: 'ERR_ACCESS_DENIED',
                eval: 'EvalError',
                function: 'EvalError',
                write: 'ERR_ACCESS_DENIED',
            });
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E17 fits a worst-case escaped engine text in the header and refuses a larger one',
        async () => {
            const bound = RELEASE_QUERY_ENGINE_LIMITS.maxEngineQueryBytes;
            expect(2 * bound + 2_048).toBeLessThanOrEqual(RELEASE_QUERY_ENGINE_LIMITS.workerHeaderBytes);
            expect(await outcome(engine, input(literals(1), '"'.repeat(bound)))).toBe('query-rejected');
            expect(await outcome(engine, input(literals(1), '\\'.repeat(bound)))).toBe('query-rejected');
            expect(await outcome(engine, input(literals(1), '"'.repeat(bound + 1)))).toBe('ENGINE_UNAVAILABLE');
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E18 completes escape-heavy results under the result budget and reports larger ones as byte limits',
        async () => {
            function quotes(count: number, width: number): Buffer {
                let text = '';
                for (let index = 0; index < count; index += 1) {
                    text += `<urn:s${String(index)}> <urn:p> "${'\\"'.repeat(width)}" .\n`;
                }
                return Buffer.from(text);
            }
            const query = 'SELECT ?x WHERE { ?s ?p ?x . } LIMIT 1001';
            const heavy = await engine.execute(input(quotes(1_000, 1_400), query), new AbortController().signal);
            expect(heavy.outcome).toBe('complete');
            const bytes = heavy.outcome === 'complete' ? Buffer.byteLength(heavy.result) : 0;
            expect(bytes).toBeGreaterThan(RELEASE_QUERY_ENGINE_LIMITS.maxResultBytes / 2);
            expect(bytes).toBeLessThanOrEqual(RELEASE_QUERY_ENGINE_LIMITS.maxResultBytes);
            expect(await outcome(engine, input(quotes(1_000, 2_200), query))).toBe('result-byte-limit');
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E15 expands component instances in the worker with distinct labels and intact literal text',
        async () => {
            const result = await engine.execute(
                {
                    declared: [
                        { nquads: Buffer.from('_:c14n0 <urn:p> "_:c14n0 same" .\n'), multiplicity: 2 },
                        {
                            nquads: Buffer.from('_:c14n0 <urn:p> "other" .\n<urn:a> <urn:p> _:c14n0 .\n'),
                            multiplicity: 1,
                        },
                    ],
                    inferred: [{ nquads: Buffer.from('_:c14n0 <urn:q> "inferred" .\n'), multiplicity: 3 }],
                    datasetSha256: 'a'.repeat(64),
                    engineQuery:
                        'SELECT (COUNT(DISTINCT ?s) AS ?c) (COUNT(DISTINCT ?i) AS ?n) WHERE { { ?s <urn:p> ?o . } UNION { GRAPH <urn:erden:release-query:v1:graph:inferred> { ?i <urn:q> ?x . } } } LIMIT 1001',
                    form: 'select',
                },
                new AbortController().signal,
            );
            const counts = JSON.parse(result.outcome === 'complete' ? result.result : '{}') as {
                results?: { bindings?: ReadonlyArray<Readonly<Record<string, { value: string }>>> };
            };
            // Two instances of the first component, the second component's blank subject, and <urn:a>.
            expect(counts.results?.bindings?.[0]?.['c']?.value).toBe('4');
            expect(counts.results?.bindings?.[0]?.['n']?.value).toBe('3');
            const literal = await engine.execute(
                input(
                    Buffer.from('_:c14n0 <urn:p> "_:c14n0 same" .\n'),
                    'SELECT ?s ?o WHERE { ?s ?p ?o . } LIMIT 1001',
                    'select',
                    2,
                ),
                new AbortController().signal,
            );
            const rows = JSON.parse(literal.outcome === 'complete' ? literal.result : '{}') as {
                results?: { bindings?: ReadonlyArray<Readonly<Record<string, { value: string }>>> };
            };
            expect(rows.results?.bindings?.map((row) => row['o']?.value)).toEqual(['_:c14n0 same', '_:c14n0 same']);
            expect(new Set(rows.results?.bindings?.map((row) => row['s']?.value)).size).toBe(2);
            for (const malformed of [
                '<urn:a>  <urn:p> <urn:b> .\n',
                '<urn:a> <urn:p> <urn:b> <urn:g> .\n',
                '<urn:a> <urn:p> <urn:b> .',
            ]) {
                expect(await outcome(engine, input(Buffer.from(malformed), 'ASK WHERE { }', 'ask'))).toBe(
                    'ENGINE_UNAVAILABLE',
                );
            }
        },
        UNHURRIED_TEST_MILLISECONDS,
    );

    it(
        'E16 returns identical bytes for the same query in fresh processes',
        async () => {
            const data = Buffer.from(
                Array.from(
                    { length: 300 },
                    (_, index) => `_:q${String(index)}_0_b <urn:p${String(index % 7)}> "v${String(index % 13)}" .\n`,
                ).join(''),
            );
            const query = 'SELECT ?o (SAMPLE(?s) AS ?x) (COUNT(?s) AS ?n) WHERE { ?s ?p ?o . } GROUP BY ?o LIMIT 1001';
            const results = new Set<string>();
            for (let run = 0; run < 3; run += 1) {
                const result = await engine.execute(input(data, query), new AbortController().signal);
                expect(result.outcome).toBe('complete');
                results.add(result.outcome === 'complete' ? result.result : '');
            }
            expect(results.size).toBe(1);
        },
        UNHURRIED_TEST_MILLISECONDS,
    );
});
