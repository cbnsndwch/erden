import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
    CheckProjectOperationalError,
    makeEmptyLockfile,
    nodeCurrentToolchainService,
    serializeLockfile,
    type LoadedManifestV1,
} from '@erden/contracts';
import {
    makeNodeOntologyPorts,
    makeOntologyService,
    nodeReasonerService,
    type OntologyServiceShape,
} from '@erden/ontology';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    CHECK_DIAGNOSTIC_TEXT_BYTES,
    DEFAULT_REASONER_LIMITS,
    makeCheckProjectService,
    makeManifestService,
    nodeCheckProjectService,
    renderCheckProjectError,
    renderCheckProjectReport,
    type ReasonerLimits,
} from '../src/index.js';

// Reproductions from the 2026-10-05 reasoner bug report, run through the real check and the bundled reasoner.

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

const HEADER = `@prefix x: <https://repro.example/onto#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://repro.example/onto> a owl:Ontology ; rdfs:label "repro" .
`;

const QUESTION = `# @ask     Is there an A?
# @expect  rows >= 1
# @from    x:i is asserted to be an A.
PREFIX x: <https://repro.example/onto#>
SELECT ?i WHERE { ?i a x:A }
`;

interface Fixture {
    readonly ontology: string;
    readonly question?: string;
}

function writeProject(fixture: Fixture): string {
    const root = makeTestTempRoot('erden-check-reported-');
    tempRoots.push(root);
    writeFileSync(join(root, 'ontology.ttl'), fixture.ontology, 'utf8');
    if (fixture.question !== undefined) {
        writeFileSync(join(root, 'question.rq'), fixture.question, 'utf8');
    }
    const manifest: LoadedManifestV1['manifest'] = {
        schemaVersion: 1,
        canonicalIri: 'https://repro.example/cq',
        alias: '@repro/cq',
        ownedIriPrefixes: ['https://repro.example/onto#'],
        sources: {
            ontology: ['ontology.ttl'],
            shapes: [],
            competencyQuestions: fixture.question === undefined ? [] : ['question.rq'],
        },
        citationRoots: {},
        dependencies: {},
    };
    writeFileSync(join(root, 'erden.config.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
    const toolchain = Effect.runSync(nodeCurrentToolchainService.inspect());
    writeFileSync(join(root, 'erden.lock'), serializeLockfile(makeEmptyLockfile(manifest, toolchain)), 'utf8');
    return root;
}

async function check(fixture: Fixture, reasonerLimits?: ReasonerLimits) {
    return Effect.runPromise(
        nodeCheckProjectService.check({
            from: writeProject(fixture),
            offline: true,
            ...(reasonerLimits === undefined ? {} : { reasonerLimits }),
        }),
    );
}

async function failure(fixture: Fixture): Promise<CheckProjectOperationalError> {
    const caught = await Effect.runPromise(
        Effect.flip(nodeCheckProjectService.check({ from: writeProject(fixture), offline: true })),
    );
    expect(caught).toBeInstanceOf(CheckProjectOperationalError);
    return caught;
}

describe('bug report issue 3: competency questions over a union domain', () => {
    it('passes with a union domain and one question', async () => {
        const report = await check({
            ontology: `${HEADER}x:A a owl:Class ; rdfs:label "A" . x:B a owl:Class ; rdfs:label "B" . x:C a owl:Class ; rdfs:label "C" .
x:p a owl:ObjectProperty ; rdfs:label "p" ; rdfs:domain [ a owl:Class ; owl:unionOf ( x:A x:B ) ] ; rdfs:range x:C .
x:i a x:A ; rdfs:label "i" .
`,
            question: QUESTION,
        });
        expect(renderCheckProjectReport(report)).toContain('Competency questions: passed');
        expect(report.outcome).toBe('passed');
        expect(report.stages.competencyQuestions.details?.questions[0]).toMatchObject({ rows: 1, ok: true });
    });

    it('passes the named-domain control', async () => {
        const report = await check({
            ontology: `${HEADER}x:A a owl:Class ; rdfs:label "A" . x:B a owl:Class ; rdfs:label "B" . x:C a owl:Class ; rdfs:label "C" .
x:p a owl:ObjectProperty ; rdfs:label "p" ; rdfs:domain x:A ; rdfs:range x:C .
x:i a x:A ; rdfs:label "i" .
`,
            question: QUESTION,
        });
        expect(report.outcome).toBe('passed');
    });
});

describe('bug report issue 5: diagnostics name the term, the file and the limit', () => {
    it('renders the normalization message for an undeclared header annotation (ODRL)', async () => {
        const error = await failure({
            ontology: `${HEADER}<https://repro.example/onto> owl:versionInfo "2.2" .\n`,
        });
        expect(error.code).toBe('CHECK_OUTSIDE_PROFILE');
        expect(renderCheckProjectError(error)).toContain(
            '- ontology.ttl:3:30 [OUTSIDE_PROFILE] [annotation/owl:versionInfo] https://repro.example/onto http://www.w3.org/2002/07/owl#versionInfo is Annotation: Ontology(<https://repro.example/onto> Annotation(owl:versionInfo "2.2"))\n',
        );
        expect(renderCheckProjectError(error)).not.toContain('did not produce a trusted complete decision');
    });

    it('names the predicate and term type of an unrepresentable blank-node value (ORG)', async () => {
        const error = await failure({
            ontology: `${HEADER}@prefix dct: <http://purl.org/dc/terms/> . @prefix foaf: <http://xmlns.com/foaf/0.1/> .
dct:contributor a owl:AnnotationProperty . foaf:mbox a owl:AnnotationProperty .
<https://repro.example/onto> dct:contributor [ foaf:mbox "someone@example.test" ] .
`,
        });
        expect(error.code).toBe('CHECK_OUTSIDE_PROFILE');
        const rendered = renderCheckProjectError(error);
        expect(rendered).toContain(
            '- ontology.ttl:5:30 [OUTSIDE_PROFILE] [annotation/blank-node-annotation-value] https://repro.example/onto http://purl.org/dc/terms/contributor (2 statements) is Annotation: Ontology(<https://repro.example/onto> Annotation(<http://purl.org/dc/terms/contributor> [anonymous with <http://xmlns.com/foaf/0.1/mbox>]))\n',
        );
        expect(rendered).not.toContain('did not produce a trusted complete decision');
    });

    it('decides a bare xsd:dateTimeStamp range, and names the datatype and the subject of a value (issue 4)', async () => {
        // Under the bundled 0.2 reasoner a data range reaches PurRDF only with the values asserted under it, so the
        // range alone decides; an asserted xsd:dateTimeStamp value still cannot be decided and is refused by name.
        const ranged = `${HEADER}@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
x:E a owl:Class ; rdfs:label "E" . x:at a owl:DatatypeProperty ; rdfs:label "at" ; rdfs:domain x:E ; rdfs:range xsd:dateTimeStamp .
`;
        const report = await check({ ontology: ranged });
        expect(report.outcome).toBe('passed');
        expect(report.stages.reasoning.status).toBe('passed');
        const error = await failure({
            ontology: `${ranged}x:e a x:E ; rdfs:label "e" ; x:at "2026-10-05T00:00:00Z"^^xsd:dateTimeStamp .
`,
        });
        expect(error.code).toBe('CHECK_OUTSIDE_PROFILE');
        const rendered = renderCheckProjectError(error);
        expect(rendered).toContain('starting with unsupported-datatype http://www.w3.org/2001/XMLSchema#dateTimeStamp');
        expect(rendered).toContain('https://repro.example/onto#e');
    });

    it('names the question file and the engine message when a question cannot run', async () => {
        const root = writeProject({ ontology: `${HEADER}x:A a owl:Class ; rdfs:label "A" .\n`, question: QUESTION });
        const base = makeOntologyService(makeNodeOntologyPorts());
        const ontology: OntologyServiceShape = {
            ...base,
            discoverCompetencyQuestions: (locations, required) =>
                base.discoverCompetencyQuestions(locations, required).pipe(
                    Effect.tap((questions) =>
                        Effect.sync(() => {
                            const first = questions[0]?.bytes;
                            if (first !== undefined) {
                                first[0] = 0xff;
                            }
                        }),
                    ),
                ),
        };
        const error = await Effect.runPromise(
            Effect.flip(
                makeCheckProjectService(makeManifestService(), ontology, nodeReasonerService).check({ from: root }),
            ),
        );
        expect(error.code).toBe('CHECK_COMPETENCY_QUESTION_ARTIFACT_MISMATCH');
        const rendered = renderCheckProjectError(error);
        expect(rendered).toContain('- question.rq [COMPETENCY_QUESTION_ARTIFACT_MISMATCH] Competency question');
        expect(rendered).toContain('no longer matches its discovered byte snapshot: The encoded data was not valid');
        expect(rendered).not.toContain(root);
    });

    it('states the input-axiom count, the limit and its variable', async () => {
        const report = await check(
            { ontology: `${HEADER}x:A a owl:Class ; rdfs:label "A" .\n` },
            { ...DEFAULT_REASONER_LIMITS, maxInputAxioms: 2 },
        );
        expect(report.reasoning.negativeOutcome).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
        expect(report.reasoning.inputAxiomCount).toBeGreaterThan(2);
        expect(renderCheckProjectReport(report)).toContain(
            `[reasoning] the ontology normalized to ${String(report.reasoning.inputAxiomCount)} input axioms, over the limit of 2; ERDEN_REASONER_MAX_INPUT_AXIOMS sets it (up to 1000000)`,
        );
    });

    it('states the inference limit and its variable', async () => {
        const report = await check(
            {
                ontology: `${HEADER}x:A a owl:Class . x:B a owl:Class ; rdfs:subClassOf x:A . x:C a owl:Class ; rdfs:subClassOf x:B .
x:i a x:C . x:j a x:C .
`,
            },
            { ...DEFAULT_REASONER_LIMITS, maxInferences: 1 },
        );
        expect(report.reasoning.negativeOutcome).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
        expect(renderCheckProjectReport(report)).toContain(
            '[reasoning] reasoning reached the limit of 1 inferred statements; ERDEN_REASONER_MAX_INFERENCES sets it (up to 1000000)',
        );
    });

    it('states the wall-time budget and its variable', async () => {
        const report = await check(
            { ontology: `${HEADER}x:A a owl:Class ; rdfs:label "A" .\n` },
            { ...DEFAULT_REASONER_LIMITS, maxWallTimeMs: 1 },
        );
        expect(report.reasoning.negativeOutcome).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
        expect(renderCheckProjectReport(report)).toContain(
            '[reasoning] the wall-time budget of 1 ms elapsed; ERDEN_REASONER_MAX_WALL_TIME_MS sets it (1000 to 600000 ms)',
        );
    });

    it('bounds each diagnostic and escapes it for the terminal', async () => {
        const long = `https://repro.example/onto#${'\u202e'.repeat(3)}${'x'.repeat(6000)}`;
        // An undeclared predicate with a literal value is accepted now, so the long IRI names a refused statement.
        const error = await failure({ ontology: `${HEADER}<${long}> owl:versionInfo "v" .\n` });
        const message = error.diagnostics[0]?.message ?? '';
        expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(CHECK_DIAGNOSTIC_TEXT_BYTES);
        expect(message.endsWith('\u2026')).toBe(true);
        const rendered = renderCheckProjectError(error);
        expect(rendered).not.toContain('\u202e');
        expect(rendered).toContain('\\u202e');
    });
});

describe('bug report issue 2: a request over the ceiling names the ceiling, its variable and the largest sources', () => {
    function classes(prefix: string, count: number): string {
        const lines = ['@prefix x: <https://repro.example/onto#> .', '@prefix owl: <http://www.w3.org/2002/07/owl#> .'];
        for (let index = 0; index < count; index += 1) {
            lines.push(`x:${prefix}${String(index)} a owl:Class .`);
        }
        return `${lines.join('\n')}\n`;
    }

    it('refuses before reasoning and lists the three sources with the most axioms as project paths', async () => {
        const root = makeTestTempRoot('erden-check-ceiling-');
        tempRoots.push(root);
        const files: Readonly<Record<string, string>> = {
            'small.ttl': classes('Small', 50),
            'data/large.ttl': classes('Large', 2_500),
            'tiny.ttl': classes('Tiny', 5),
            'middle.ttl': classes('Middle', 900),
        };
        mkdirSync(join(root, 'data'));
        for (const [name, text] of Object.entries(files)) {
            writeFileSync(join(root, name), text, 'utf8');
        }
        const manifest: LoadedManifestV1['manifest'] = {
            schemaVersion: 1,
            canonicalIri: 'https://repro.example/ceiling',
            alias: '@repro/ceiling',
            ownedIriPrefixes: ['https://repro.example/onto#'],
            sources: { ontology: Object.keys(files), shapes: [], competencyQuestions: [] },
            citationRoots: {},
            dependencies: {},
        };
        writeFileSync(join(root, 'erden.config.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
        const toolchain = Effect.runSync(nodeCurrentToolchainService.inspect());
        writeFileSync(join(root, 'erden.lock'), serializeLockfile(makeEmptyLockfile(manifest, toolchain)), 'utf8');

        const error = await Effect.runPromise(
            Effect.flip(
                nodeCheckProjectService.check({
                    from: root,
                    offline: true,
                    reasonerLimits: { ...DEFAULT_REASONER_LIMITS, maxRequestBytes: 1_048_576 },
                }),
            ),
        );
        expect(error.code).toBe('CHECK_REQUEST_TOO_LARGE');
        const rendered = renderCheckProjectError(error);
        expect(rendered).toMatch(
            /\[REQUEST_TOO_LARGE\] Canonical reasoner request is \d+ bytes, over the 1048576-byte request ceiling; ERDEN_REASONER_MAX_REQUEST_BYTES sets it \(1048576 to 134217728 bytes\); the largest sources are data\/large\.ttl \(2500 axioms\), middle\.ttl \(900 axioms\), small\.ttl \(50 axioms\)/u,
        );
        expect(rendered).not.toContain(root);

        const passed = await Effect.runPromise(nodeCheckProjectService.check({ from: root, offline: true }));
        expect(passed.reasoning.limits?.maxRequestBytes).toBe(16_777_216);
    }, 60_000);
});
