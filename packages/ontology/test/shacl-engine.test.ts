// erden.shacl/v1 from the TypeScript side: request encoding, every trust check on an answer, and, when a built
// erden-shacl is available (ERDEN_SHACL_BIN, or the bundled package once installed), the real program.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DataFactory, Parser, type Quad } from 'n3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    decodeTrustedShaclAnswer,
    encodeShaclRequest,
    prepareShaclShapes,
    runShaclRequest,
    SHACL_ENGINE_CARGO_LOCK_SHA256,
    SHACL_ENGINE_DIGEST,
    SHACL_ENGINE_NAME,
    SHACL_ENGINE_VERSION,
    ShaclAnswerUntrustedError,
    ShaclProcessError,
    ShaclRequestEncodingError,
    ShaclSession,
    shaclEngineTool,
    type EncodedShaclRequest,
} from '../src/index.js';

const SH = 'http://www.w3.org/ns/shacl#';
const repositoryRoot = new URL('../../../', import.meta.url);

function turtle(text: string, prefix: string): Quad[] {
    return new Parser({ blankNodePrefix: prefix, factory: DataFactory }).parse(
        `@prefix sh: <${SH}> . @prefix ex: <http://ex/> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n${text}`,
    );
}

const SHAPES = turtle(
    `ex:PersonShape a sh:NodeShape ; sh:targetClass ex:Person ;
        sh:property [ sh:path ex:age ; sh:datatype xsd:integer ; sh:maxCount 1 ] ;
        sh:property [ sh:path [ sh:inversePath ex:parent ] ; sh:minCount 1 ] .
     ex:TaskShape a sh:NodeShape ; sh:targetClass ex:Task ;
        sh:sparql [ sh:message "{$this} ends before it starts" ;
          sh:select "SELECT $this ?value WHERE { $this <http://ex/start> ?s ; <http://ex/end> ?value . FILTER (?value < ?s) }" ] .`,
    'erden_shape_00000000_',
);
const BROKEN = turtle(
    `_:p a ex:Person ; ex:age "x", 1 .
     ex:t a ex:Task ; ex:start 5 ; ex:end 3 .`,
    'erden_data_',
);
const FINE = turtle(`ex:a a ex:Person . ex:b ex:parent ex:a .`, 'erden_data_');
const FAKE_TOOL = shaclEngineTool(`sha256:${'1'.repeat(64)}`);

function encode(tool = FAKE_TOOL, graphs = [{ id: 'data', quads: BROKEN }]): EncodedShaclRequest {
    return encodeShaclRequest({
        requestId: 'test:1',
        tool,
        shapes: prepareShaclShapes(SHAPES),
        graphs,
        maxResults: 100,
    });
}

describe('the engine identity', () => {
    it('names the committed shacl/Cargo.lock', () => {
        const lock = readFileSync(new URL('shacl/Cargo.lock', repositoryRoot));
        expect(`sha256:${createHash('sha256').update(lock).digest('hex')}`).toBe(SHACL_ENGINE_CARGO_LOCK_SHA256);
    });

    it('is the identity the Rust program compiles in', () => {
        const source = readFileSync(new URL('shacl/erden-shacl/src/lib.rs', repositoryRoot), 'utf8').replace(
            /\s+/gu,
            '',
        );
        expect(source).toContain(`pubconstTOOL_VERSION:&str="${SHACL_ENGINE_VERSION}";`);
        expect(source).toContain(`pubconstCARGO_LOCK_SHA256:&str="${SHACL_ENGINE_CARGO_LOCK_SHA256}";`);
    });
});

describe('encoding a request', () => {
    it('writes N-Triples with wire labels, escapes, and digests hashed from the text written', () => {
        const shapes = prepareShaclShapes([
            {
                subject: DataFactory.blankNode('original'),
                predicate: DataFactory.namedNode('http://ex/p'),
                object: DataFactory.literal('a "quoted"\nline\\', 'en'),
            },
            {
                subject: DataFactory.namedNode('http://ex/x y'),
                predicate: DataFactory.namedNode(`${SH}severity`),
                object: DataFactory.namedNode('http://ex/Custom'),
            },
            {
                subject: DataFactory.blankNode('original'),
                predicate: DataFactory.namedNode('http://ex/q'),
                object: DataFactory.literal('7', DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#integer')),
            },
        ]);
        expect(shapes.nTriples).toBe(
            '_:s0 <http://ex/p> "a \\"quoted\\"\\nline\\\\"@en .\n' +
                `<http://ex/x\\u0020y> <${SH}severity> <http://ex/Custom> .\n` +
                '_:s0 <http://ex/q> "7"^^<http://www.w3.org/2001/XMLSchema#integer> .\n',
        );
        expect(shapes.digest).toBe(`sha256:${createHash('sha256').update(shapes.nTriples).digest('hex')}`);
        expect(shapes.terms.map((term) => term.value)).toEqual(['original']);
        expect(shapes.severities.has('http://ex/Custom')).toBe(true);
        expect(shapes.nodes.has('B:s0')).toBe(true);
    });

    it('labels every data graph in its own space and can leave the shapes text out', () => {
        const request = encodeShaclRequest({
            requestId: 'test:2',
            tool: FAKE_TOOL,
            shapes: prepareShaclShapes(SHAPES),
            graphs: [
                { id: 'one', quads: BROKEN },
                { id: 'two', quads: BROKEN },
            ],
            maxResults: 5,
            omitShapesText: true,
        });
        const line = JSON.parse(request.line) as {
            shapes: Record<string, string>;
            graphs: { nTriples: string }[];
        };
        expect(Object.keys(line.shapes)).toEqual(['digest']);
        expect(line.graphs[0]?.nTriples).toContain('_:d0 ');
        expect(line.graphs[1]?.nTriples).toBe(line.graphs[0]?.nTriples);
        expect(request.includesShapesText).toBe(false);
    });

    it('refuses inputs v1 cannot carry', () => {
        const directional = {
            subject: DataFactory.namedNode('http://ex/s'),
            predicate: DataFactory.namedNode('http://ex/p'),
            object: { termType: 'Literal', value: 'x', language: 'ar', direction: 'rtl' },
        };
        expect(() => prepareShaclShapes([directional])).toThrow(ShaclRequestEncodingError);
        expect(() => encode(FAKE_TOOL, [])).toThrow(ShaclRequestEncodingError);
        expect(() =>
            encodeShaclRequest({
                requestId: 'has space',
                tool: FAKE_TOOL,
                shapes: prepareShaclShapes(SHAPES),
                graphs: [{ id: 'data', quads: FINE }],
                maxResults: 1,
            }),
        ).toThrow(ShaclRequestEncodingError);
    });
});

/** An answer as erden-shacl would write it for `request`, with one result per given entry. */
function answerFor(request: EncodedShaclRequest, results: unknown[] = [], conforms = results.length === 0) {
    return {
        kind: 'ShaclAnswer',
        protocolVersion: 1,
        requestId: request.requestId,
        tool: { ...request.tool },
        outcome: 'validated',
        shapesDigest: request.shapes.digest,
        reports: request.graphs.map((graph) => ({
            id: graph.id,
            digest: graph.digest,
            conforms,
            results,
            diagnostics: [],
        })),
    };
}
function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}
const RESULT = {
    focusNode: { termType: 'BlankNode', value: 'd0' },
    resultPath: { predicate: 'http://ex/age' },
    value: {
        termType: 'Literal',
        value: 'x',
        datatype: 'http://www.w3.org/2001/XMLSchema#string',
        language: '',
    },
    sourceConstraintComponent: `${SH}DatatypeConstraintComponent`,
    sourceShape: { termType: 'BlankNode', value: 's0' },
    resultSeverity: `${SH}Violation`,
    resultMessages: [],
    details: [],
};

describe('trusting an answer', () => {
    it('maps wire labels back to the caller’s own blank nodes', () => {
        const request = encode();
        const answer = decodeTrustedShaclAnswer(line(answerFor(request, [RESULT], false)), request);
        expect(answer.outcome).toBe('validated');
        if (answer.outcome !== 'validated') {
            return;
        }
        const result = answer.reports[0]?.results[0];
        expect(result?.focusNode).toBe(request.graphs[0]?.terms[0]);
        expect(result?.focusNode.value).toMatch(/^erden_data_/u);
        expect(request.shapes.terms).toContain(result?.sourceShape);
        expect(result?.resultPath).toEqual({ kind: 'predicate', iri: 'http://ex/age' });
    });

    it('returns a refusal as a refusal', () => {
        const request = encode();
        const { shapesDigest: _digest, reports: _reports, ...envelope } = answerFor(request);
        const answer = decodeTrustedShaclAnswer(
            line({
                ...envelope,
                outcome: 'refused',
                refusal: { code: 'shapes-ill-formed', message: 'm', graph: null },
            }),
            request,
        );
        expect(answer).toMatchObject({ outcome: 'refused', code: 'shapes-ill-formed', graph: null });
    });

    const request = encode();
    const valid = answerFor(request, [RESULT], false);
    const tampered: ReadonlyArray<readonly [string, unknown, string?]> = [
        ['another kind', { ...valid, kind: 'ReasonerResponse' }],
        ['another protocol', { ...valid, protocolVersion: 2 }],
        ['another request', { ...valid, requestId: 'test:other' }],
        ['another executable', { ...valid, tool: { ...valid.tool, executableDigest: `sha256:${'2'.repeat(64)}` } }],
        ['another engine', { ...valid, tool: { ...valid.tool, engineDigest: `sha256:${'3'.repeat(64)}` } }],
        ['another version', { ...valid, tool: { ...valid.tool, version: '9.9.9' } }],
        ['another shapes graph', { ...valid, shapesDigest: `sha256:${'4'.repeat(64)}` }],
        ['another data digest', { ...valid, reports: [{ ...valid.reports[0], digest: `sha256:${'5'.repeat(64)}` }] }],
        ['another graph id', { ...valid, reports: [{ ...valid.reports[0], id: 'other' }] }],
        ['a missing report', { ...valid, reports: [] }],
        ['an extra field', { ...valid, extra: true }],
        [
            'a foreign data label',
            {
                ...valid,
                reports: [
                    {
                        ...valid.reports[0],
                        results: [{ ...RESULT, focusNode: { termType: 'BlankNode', value: 'd99' } }],
                    },
                ],
            },
        ],
        [
            'an unprefixed label',
            {
                ...valid,
                reports: [
                    { ...valid.reports[0], results: [{ ...RESULT, value: { termType: 'BlankNode', value: 'b0' } }] },
                ],
            },
        ],
        [
            'a source shape outside the shapes graph',
            {
                ...valid,
                reports: [
                    {
                        ...valid.reports[0],
                        results: [{ ...RESULT, sourceShape: { termType: 'NamedNode', value: 'http://ex/Nowhere' } }],
                    },
                ],
            },
        ],
        [
            'an unknown severity',
            {
                ...valid,
                reports: [{ ...valid.reports[0], results: [{ ...RESULT, resultSeverity: 'http://ex/Severe' }] }],
            },
        ],
        ['a verdict that contradicts its results', { ...valid, reports: [{ ...valid.reports[0], conforms: true }] }],
        [
            'a conformant verdict with a warning',
            {
                ...valid,
                reports: [
                    { ...valid.reports[0], conforms: true, results: [{ ...RESULT, resultSeverity: `${SH}Warning` }] },
                ],
            },
        ],
        [
            'a result with an extra field',
            { ...valid, reports: [{ ...valid.reports[0], results: [{ ...RESULT, sourceConstraint: null }] }] },
        ],
        [
            'a literal message that is an IRI',
            {
                ...valid,
                reports: [
                    {
                        ...valid.reports[0],
                        results: [{ ...RESULT, resultMessages: [{ termType: 'NamedNode', value: 'http://ex/m' }] }],
                    },
                ],
            },
        ],
        [
            'an unknown path kind',
            {
                ...valid,
                reports: [{ ...valid.reports[0], results: [{ ...RESULT, resultPath: { mystery: 'http://ex/p' } }] }],
            },
        ],
        [
            'a refusal for another request',
            {
                ...valid,
                outcome: 'refused',
                shapesDigest: undefined,
                reports: undefined,
                requestId: 'x',
                refusal: { code: 'c', message: 'm', graph: null },
            },
        ],
        [
            'a refusal naming an unsent graph',
            {
                kind: 'ShaclAnswer',
                protocolVersion: 1,
                requestId: null,
                tool: valid.tool,
                outcome: 'refused',
                refusal: { code: 'c', message: 'm', graph: 'unsent' },
            },
        ],
    ];
    for (const [label, value] of tampered) {
        it(`refuses ${label}`, () => {
            expect(() => decodeTrustedShaclAnswer(line(value), request)).toThrow(ShaclAnswerUntrustedError);
        });
    }
    it('refuses two lines, no final newline and non-JSON', () => {
        expect(() => decodeTrustedShaclAnswer(`${line(valid)}${line(valid)}`, request)).toThrow(
            ShaclAnswerUntrustedError,
        );
        expect(() => decodeTrustedShaclAnswer(JSON.stringify(valid), request)).toThrow(ShaclAnswerUntrustedError);
        expect(() => decodeTrustedShaclAnswer('not json\n', request)).toThrow(ShaclAnswerUntrustedError);
    });
});

describe('processes that do not answer', () => {
    let root: string;
    beforeAll(() => {
        root = makeTestTempRoot('erden-shacl-process-');
    });
    afterAll(() => {
        cleanupTestTempRoot(root);
    });
    function script(name: string, body: string): string {
        const path = join(root, name);
        writeFileSync(path, `#!/bin/sh\n${body}\n`);
        chmodSync(path, 0o755);
        return path;
    }
    it.skipIf(process.platform === 'win32')(
        'fails closed on a timeout, a non-zero exit and stderr output',
        async () => {
            const request = encode();
            await expect(
                runShaclRequest(script('slow', 'exec sleep 5'), request, { maxWallTimeMs: 200 }),
            ).rejects.toMatchObject({
                code: 'SHACL_BUDGET_EXHAUSTED',
                failure: 'timeout',
            });
            await expect(
                runShaclRequest(script('fails', 'cat >/dev/null; exit 2'), request, { maxWallTimeMs: 5_000 }),
            ).rejects.toMatchObject({ failure: 'exit' });
            await expect(
                runShaclRequest(script('noisy', `cat >/dev/null; echo warning >&2; printf '%s\\n' '{}'`), request, {
                    maxWallTimeMs: 5_000,
                }),
            ).rejects.toMatchObject({ failure: 'stderr' });
            await expect(
                runShaclRequest(join(root, 'missing'), request, { maxWallTimeMs: 5_000 }),
            ).rejects.toBeInstanceOf(ShaclProcessError);
        },
    );
    it.skipIf(process.platform === 'win32')('restarts a session after a deadline', async () => {
        const session = new ShaclSession(script('hang', 'exec sleep 5'), { maxWallTimeMs: 200 });
        const input = {
            requestId: 'test:3',
            tool: FAKE_TOOL,
            shapes: prepareShaclShapes(SHAPES),
            graphs: [{ id: 'data', quads: FINE }],
            maxResults: 1,
        };
        await expect(session.validate(input)).rejects.toMatchObject({ failure: 'timeout' });
        await expect(session.validate(input)).rejects.toMatchObject({ failure: 'timeout' });
        expect(session.starts).toBe(2);
        session.close();
    });
});

const BINARY = process.env.ERDEN_SHACL_BIN;
const HAVE_BINARY = BINARY !== undefined && BINARY !== '' && existsSync(BINARY);

describe.skipIf(!HAVE_BINARY)('the real erden-shacl (ERDEN_SHACL_BIN)', () => {
    const executable = BINARY ?? '';
    function tool() {
        return shaclEngineTool(`sha256:${createHash('sha256').update(readFileSync(executable)).digest('hex')}`);
    }

    it('answers with the identity this module names, and every result field', async () => {
        const answer = await runShaclRequest(
            executable,
            encode(tool(), [
                { id: 'data', quads: BROKEN },
                { id: 'fine', quads: FINE },
            ]),
            { maxWallTimeMs: 30_000 },
        );
        expect(answer.outcome).toBe('validated');
        if (answer.outcome !== 'validated') {
            return;
        }
        expect(answer.tool).toMatchObject({ name: SHACL_ENGINE_NAME, engineDigest: SHACL_ENGINE_DIGEST });
        const [broken, fine] = answer.reports;
        expect(fine?.conforms).toBe(true);
        expect(broken?.conforms).toBe(false);
        const components = (broken?.results ?? [])
            .map((result) => result.sourceConstraintComponent.replace(SH, ''))
            .sort();
        expect(components).toEqual([
            'DatatypeConstraintComponent',
            'MaxCountConstraintComponent',
            'MinCountConstraintComponent',
            'SPARQLConstraintComponent',
        ]);
        const sparql = broken?.results.find(
            (result) => result.sourceConstraintComponent === `${SH}SPARQLConstraintComponent`,
        );
        expect(sparql?.focusNode.value).toBe('http://ex/t');
        expect(sparql?.resultMessages[0]?.value).toBe('http://ex/t ends before it starts');
        const datatype = broken?.results.find(
            (result) => result.sourceConstraintComponent === `${SH}DatatypeConstraintComponent`,
        );
        expect(datatype?.focusNode.termType).toBe('BlankNode');
        expect(datatype?.focusNode.value).toMatch(/^erden_data_/u);
        const inverse = broken?.results.find(
            (result) => result.sourceConstraintComponent === `${SH}MinCountConstraintComponent`,
        );
        expect(inverse?.resultPath).toEqual({ kind: 'inverse', path: { kind: 'predicate', iri: 'http://ex/parent' } });
    });

    it('refuses a request for another executable', async () => {
        const answer = await runShaclRequest(executable, encode(FAKE_TOOL), { maxWallTimeMs: 30_000 }).catch(
            (error: unknown) => error,
        );
        // The program answers with its own identity, which the decoder refuses before reading the refusal.
        expect(answer).toBeInstanceOf(ShaclAnswerUntrustedError);
    });

    it('keeps shapes in a session and answers in order', async () => {
        const session = new ShaclSession(executable, { maxWallTimeMs: 30_000 });
        const shapes = prepareShaclShapes(SHAPES);
        const answers = await Promise.all(
            Array.from({ length: 20 }, (_, index) =>
                session.validate({
                    requestId: `session:${String(index)}`,
                    tool: tool(),
                    shapes,
                    graphs: [{ id: 'data', quads: index % 2 === 0 ? FINE : BROKEN }],
                    maxResults: 100,
                }),
            ),
        );
        expect(
            answers.map((answer) => (answer.outcome === 'validated' ? answer.reports[0]?.conforms : answer.code)),
        ).toEqual(Array.from({ length: 20 }, (_, index) => index % 2 === 0));
        expect(session.starts).toBe(1);
        session.close();
    });
});
