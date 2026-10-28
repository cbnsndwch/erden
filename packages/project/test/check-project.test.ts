import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    CheckProjectOperationalError,
    CurrentToolchainError,
    REASONER_PROTOCOL_VERSION,
    decodeCheckProjectReport,
    encodeCheckProjectReport,
    makeEmptyLockfile,
    makeNodeCurrentToolchainService,
    normalizeManifestV1,
    nodeCurrentToolchainService,
    serializeLockfile,
    serializeManifestV1,
    type LoadedManifestV1,
} from '@erden/contracts';
import {
    ReasonerProcessError,
    TrustedNegativeReasonerOutcomeError,
    makeNodeOntologyPorts,
    makeOntologyService,
    nodeReasonerService,
    type OntologyServiceShape,
    type ReasonerServiceShape,
} from '@erden/ontology';
import { encodePackage } from '@erden/package-format';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    makeCheckProjectService,
    makeDependencyResolver,
    makeFixtureDependencyRegistry,
    makeInstalledClosureReader,
    makeManifestService,
    makeNodeInstallProjectService,
    nodeProjectDependencyStateService,
    REASONER_SOURCE_BUILD_GUIDANCE,
    renderCheckProjectError,
    renderCheckProjectReport,
    type InstalledClosureReaderShape,
} from '../src/index.js';

const tempRoots: string[] = [];

function makeTempRoot(): string {
    const root = makeTestTempRoot('erden-check-project-');
    tempRoots.push(root);
    return root;
}

function writeFixtureFile(path: string, contents: string): void {
    writeFileSync(path, contents, { encoding: 'utf8', mode: 0o644 });
}

async function onArchitecture<A>(arch: string, body: () => Promise<A>): Promise<A> {
    const original = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'arch', { ...original, value: arch });
    try {
        return await body();
    } finally {
        Object.defineProperty(process, 'arch', original ?? { value: 'x64' });
    }
}

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

const PREFIXES = `
@prefix ex: <https://example.test/root#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;

function sha256(bytes: Uint8Array): string {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const CURRENT_TOOLCHAIN = Effect.runSync(nodeCurrentToolchainService.inspect());

function writeEmptyLock(root: string, manifest: LoadedManifestV1['manifest']): void {
    writeFixtureFile(join(root, 'erden.lock'), serializeLockfile(makeEmptyLockfile(manifest, CURRENT_TOOLCHAIN)));
}

interface ProjectFixture {
    readonly ontology: string;
    readonly shape?: string;
    readonly question?: string;
    readonly citationRoots?: Readonly<Record<string, string>>;
    readonly dependencies?: Readonly<Record<string, string>>;
}

function writeProject(fixture: ProjectFixture): {
    readonly root: string;
    readonly manifestPath: string;
} {
    const root = makeTempRoot();
    writeFixtureFile(join(root, 'ontology.ttl'), fixture.ontology);
    if (fixture.shape !== undefined) {
        writeFixtureFile(join(root, 'shapes.ttl'), fixture.shape);
    }
    if (fixture.question !== undefined) {
        writeFixtureFile(join(root, 'question.rq'), fixture.question);
    }
    const manifestPath = join(root, 'erden.config.json');
    const manifest: LoadedManifestV1['manifest'] = {
        schemaVersion: 1,
        canonicalIri: 'https://example.test/root',
        alias: '@example/root',
        ownedIriPrefixes: ['https://example.test/root#'],
        title: 'Root ontology',
        sources: {
            ontology: ['ontology.ttl'],
            shapes: fixture.shape === undefined ? [] : ['shapes.ttl'],
            competencyQuestions: fixture.question === undefined ? [] : ['question.rq'],
        },
        citationRoots: fixture.citationRoots ?? {},
        dependencies: fixture.dependencies ?? {},
    };
    writeFixtureFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (Object.keys(manifest.dependencies).length === 0) {
        writeEmptyLock(root, manifest);
    }
    return { root, manifestPath };
}

function nodeCheckService() {
    return makeCheckProjectService(
        makeManifestService(),
        makeOntologyService(makeNodeOntologyPorts()),
        nodeReasonerService,
    );
}

async function runNodeProject(fixture: ProjectFixture, offline = true) {
    const project = writeProject(fixture);
    const report = await Effect.runPromise(
        nodeCheckService().check({
            manifestPath: project.manifestPath,
            from: project.root,
            offline,
        }),
    );
    return { project, report };
}

interface LeafDependencyFixtureInput {
    readonly dependencySources: LoadedManifestV1['manifest']['sources'];
    readonly dependencyFiles: ReadonlyArray<
        Readonly<{
            readonly path: string;
            readonly bytes: string;
        }>
    >;
    readonly rootCitationRoots?: Readonly<Record<string, string>>;
    readonly dependencyOutsideProfile?: 'refuse' | 'report';
    readonly rootOutsideProfile?: 'refuse' | 'report';
    readonly rootOntology?: string;
}

async function installLeafDependency(input: LeafDependencyFixtureInput) {
    const workspace = makeTempRoot();
    const projectRoot = join(workspace, 'consumer');
    const storeRoot = join(workspace, 'store');
    mkdirSync(projectRoot, { recursive: true });
    const dependencyManifest = normalizeManifestV1({
        schemaVersion: 1,
        canonicalIri: 'https://example.test/fixture-dependency',
        alias: '@example/fixture-dependency',
        ownedIriPrefixes: ['https://example.test/fixture-dependency#'],
        dependencies: {},
        sources: input.dependencySources,
        ...(input.dependencyOutsideProfile === undefined ? {} : { outsideProfile: input.dependencyOutsideProfile }),
    });
    const dependencyLock = makeEmptyLockfile(dependencyManifest, CURRENT_TOOLCHAIN);
    const encoded = encodePackage({
        canonicalIri: dependencyManifest.canonicalIri,
        version: '1.0.0',
        dependencies: [],
        validator: CURRENT_TOOLCHAIN.validator,
        reasoner: CURRENT_TOOLCHAIN.reasoner,
        files: [
            { path: 'erden.config.json', bytes: serializeManifestV1(dependencyManifest, 'json'), executable: false },
            { path: 'erden.lock', bytes: serializeLockfile(dependencyLock), executable: false },
            ...input.dependencyFiles.map((file) => ({ ...file, executable: false as const })),
        ],
    });
    const registry = makeFixtureDependencyRegistry({
        registryOrigin: 'https://registry.example',
        aliases: [{ alias: '@example/fixture-dependency', canonicalIri: dependencyManifest.canonicalIri }],
        packages: [
            {
                canonicalIri: dependencyManifest.canonicalIri,
                version: '1.0.0',
                archiveSha256: encoded.archiveSha256,
                manifest: encoded.manifest,
                archive: encoded.archiveBytes,
            },
        ],
    });
    const rootManifest = normalizeManifestV1({
        schemaVersion: 1,
        canonicalIri: 'https://example.test/fixture-consumer',
        alias: '@example/fixture-consumer',
        ownedIriPrefixes: ['https://example.test/fixture-consumer#'],
        registry: 'https://registry.example',
        dependencies: { '@example/fixture-dependency': '^1.0.0' },
        sources: { ontology: ['ontology.ttl'] },
        citationRoots: input.rootCitationRoots ?? {},
        ...(input.rootOutsideProfile === undefined ? {} : { outsideProfile: input.rootOutsideProfile }),
    });
    writeFixtureFile(join(projectRoot, 'erden.config.json'), serializeManifestV1(rootManifest, 'json'));
    writeFixtureFile(
        join(projectRoot, 'ontology.ttl'),
        input.rootOntology ??
            '@prefix root: <https://example.test/fixture-consumer#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\nroot:A a owl:Class .\n',
    );
    await Effect.runPromise(makeNodeInstallProjectService(registry).install({ from: projectRoot, storeRoot }));
    return { projectRoot, storeRoot, encoded };
}

describe('CheckProject deterministic orchestration', () => {
    it('names the refused runtime and the supported platforms when no bundled reasoner exists for this one', async () => {
        // An architecture no Erden reasoner package will ever target.
        const failure = await onArchitecture('s390x', () =>
            Effect.runPromise(
                Effect.flip(
                    makeCheckProjectService(
                        makeManifestService(),
                        makeOntologyService(makeNodeOntologyPorts()),
                        nodeReasonerService,
                        nodeProjectDependencyStateService,
                        makeNodeCurrentToolchainService(),
                    ).check({ from: makeTempRoot() }),
                ),
            ),
        );
        expect(failure).toMatchObject({ stage: 'dependencies', code: 'CHECK_TOOLCHAIN_UNAVAILABLE' });
        const rendered = renderCheckProjectError(failure);
        expect(rendered).toContain(`No qualified bundled reasoner exists for this runtime (${process.platform}/s390x`);
        expect(rendered).toContain('UNSUPPORTED_PLATFORM');
        expect(rendered).toContain(
            'Supported platforms: linux x64 (glibc), linux arm64 (glibc), darwin arm64, win32 x64. Run Erden on one of them.',
        );
        expect(rendered).not.toContain('Repair the local Erden runtime');
    });

    it('names the next step when this source checkout has no reasoner build', async () => {
        const failure = await Effect.runPromise(
            Effect.flip(
                makeCheckProjectService(
                    makeManifestService(),
                    makeOntologyService(makeNodeOntologyPorts()),
                    nodeReasonerService,
                    nodeProjectDependencyStateService,
                    {
                        inspect: () =>
                            Effect.fail(new CurrentToolchainError(undefined, undefined, 'SOURCE_BUILD_MISSING')),
                    },
                ).check({ from: makeTempRoot() }),
            ),
        );
        expect(failure).toMatchObject({ stage: 'dependencies', code: 'CHECK_TOOLCHAIN_UNAVAILABLE' });
        const rendered = renderCheckProjectError(failure);
        expect(rendered).toContain(
            'The bundled reasoner is not built in this Erden source checkout (SOURCE_BUILD_MISSING)',
        );
        expect(rendered).toContain(REASONER_SOURCE_BUILD_GUIDANCE);
        expect(rendered).not.toContain('Repair the local Erden runtime');
    });

    it('treats a canonical empty lock as complete evidence and makes zero store calls', async () => {
        const project = writeProject({ ontology: `${PREFIXES} ex:A a owl:Class .` });
        let storeAccesses = 0;
        const store = new Proxy({} as InstalledClosureReaderShape, {
            get: () => {
                storeAccesses += 1;
                return undefined;
            },
        });
        const report = await Effect.runPromise(
            makeCheckProjectService(
                makeManifestService(),
                makeOntologyService(makeNodeOntologyPorts()),
                nodeReasonerService,
                nodeProjectDependencyStateService,
                nodeCurrentToolchainService,
                store,
            ).check({ from: project.root, offline: true }),
        );
        expect(report.outcome).toBe('passed');
        expect(storeAccesses).toBe(0);
    });

    it('reasons once, validates inferred data with root SHACL/CQ, and emits portable byte-identical output', async () => {
        const fixture: ProjectFixture = {
            ontology: `${PREFIXES}
ex:A a owl:Class ; rdfs:subClassOf ex:B .
ex:B a owl:Class .
ex:alice a ex:A .
`,
            shape: `${PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .
ex:InferredTypeShape a sh:NodeShape ;
  sh:targetClass ex:A ;
  sh:property [ sh:path rdf:type ; sh:hasValue ex:B ; sh:message "inferred superclass type is required" ] .
`,
            question: `# @ask     Is the inferred superclass type queryable?
# @expect  rows == 1
# @from    The reasoner-to-validation seam must retain inferred triples.
SELECT ?s WHERE { ?s a <https://example.test/root#B> }
`,
        };
        const first = await runNodeProject(fixture, true);
        const secondService = nodeCheckService();
        const second = await Effect.runPromise(
            secondService.check({
                manifestPath: first.project.manifestPath,
                from: tmpdir(),
                offline: false,
            }),
        );
        expect(first.report.outcome).toBe('passed');
        expect(first.report.reasoning.protocolVersion).toBe(REASONER_PROTOCOL_VERSION);
        expect(first.report.stages.shacl.status).toBe('passed');
        expect(first.report.stages.competencyQuestions.details?.questions[0]).toMatchObject({
            execution: 'executed',
            rows: 1,
            ok: true,
        });
        expect(
            first.report.reasoning.inferred.some(
                (item) => item.subject.endsWith('#alice') && item.object.endsWith('#B'),
            ),
        ).toBe(true);
        expect(first.report.sources.files.every((item) => item.contentDigest.startsWith('sha256:'))).toBe(true);
        expect(encodeCheckProjectReport(first.report)).toBe(encodeCheckProjectReport(second));
        expect(renderCheckProjectReport(first.report)).toBe(renderCheckProjectReport(second));
        expect(encodeCheckProjectReport(first.report)).not.toContain(first.project.root.replaceAll('\\', '/'));
        expect(renderCheckProjectReport(first.report)).not.toContain(first.project.root);
    });

    it('reports global inconsistency and trusted unsupported refusal without running validation', async () => {
        const inconsistent = await runNodeProject({
            ontology: `${PREFIXES}
ex:A a owl:Class ; owl:disjointWith ex:B .
ex:B a owl:Class .
ex:alice a ex:A, ex:B .
`,
            shape: PREFIXES,
        });
        expect(inconsistent.report).toMatchObject({
            outcome: 'failed',
            reasoning: { outcome: 'decided', consistency: 'inconsistent' },
            stages: { reasoning: { status: 'failed' }, core: { status: 'not-run' } },
        });
        // The disjointness and both class assertions, where they are written.
        expect(inconsistent.report.reasoning.diagnostics.map((item) => item.locations)).toEqual([
            [
                { file: 'ontology.ttl', line: 7, column: 20 },
                { file: 'ontology.ttl', line: 9, column: 12 },
                { file: 'ontology.ttl', line: 9, column: 18 },
            ],
        ]);
        expect(renderCheckProjectReport(inconsistent.report)).toContain(
            '[reasoning/disjoint-class-assertions] An individual is asserted in two disjoint classes (at ontology.ttl:7:20, ontology.ttl:9:12, ontology.ttl:9:18)',
        );
        expect(inconsistent.report.sources.files.find((item) => item.stage === 'shapes')?.contentDigest).toBe(
            sha256(readFileSync(join(inconsistent.project.root, 'shapes.ttl'))),
        );

        // Outside the profile, refuse mode stops before reasoning and lists every finding.
        const outsideProject = writeProject({
            ontology: `${PREFIXES}
ex:p a owl:ObjectProperty, owl:AsymmetricProperty .
`,
            shape: PREFIXES,
        });
        const outside = await Effect.runPromise(
            Effect.flip(
                nodeCheckService().check({
                    manifestPath: outsideProject.manifestPath,
                    from: outsideProject.root,
                    offline: true,
                }),
            ),
        );
        expect(outside).toMatchObject({
            code: 'CHECK_OUTSIDE_PROFILE',
            stage: 'reasoning',
            diagnostics: [expect.objectContaining({ code: 'OUTSIDE_PROFILE', file: 'ontology.ttl' })],
        });

        // Inside the profile, the reasoner itself still refuses a known divergence with a failed report.
        const refused = await runNodeProject({
            ontology: `${PREFIXES}
ex:s owl:bottomObjectProperty ex:o .
`,
            shape: PREFIXES,
        });
        expect(refused.report).toMatchObject({
            outcome: 'failed',
            reasoning: { outcome: 'refused', consistency: null },
            stages: { reasoning: { status: 'failed' }, shacl: { status: 'not-run' } },
        });
        expect(refused.report.reasoning.tool.executableDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(refused.report.sources.files.find((item) => item.stage === 'shapes')?.contentDigest).toBe(
            sha256(readFileSync(join(refused.project.root, 'shapes.ttl'))),
        );
        expect(renderCheckProjectReport(refused.report)).toContain('[reasoning/');
    });

    it('names and locates each literal outside the range of its property in the refusal', async () => {
        // An ontology header that dates itself with a plain string under a property ranged xsd:dateTime: the value is
        // not a dateTime, so the ontology has no model, and the proof checker cannot certify that yet.
        const refused = await runNodeProject({
            ontology: `${PREFIXES}@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<https://example.test/root> a owl:Ontology ;
    ex:modified "2026-09-03" .
ex:modified a owl:DatatypeProperty ;
    rdfs:range xsd:dateTime .
ex:summary ex:modified "2026-09-03T00:00:00"^^xsd:dateTime .
`,
        });
        expect(refused.report).toMatchObject({
            outcome: 'failed',
            reasoning: { outcome: 'refused', negativeOutcome: { reason: 'incomplete-certificate' } },
        });
        expect(refused.report.reasoning.diagnostics).toEqual([
            {
                severity: 'error',
                code: 'uncheckable-inconsistency',
                message:
                    '<https://example.test/root> <https://example.test/root#modified> "2026-09-03"^^xsd:string, but <https://example.test/root#modified> has range xsd:dateTime, and "2026-09-03"^^xsd:string is not a value of xsd:dateTime, so the ontology is inconsistent; Erden\'s proof checker cannot certify this kind of inconsistency yet, so reasoning is refused',
                axiomIds: [expect.stringMatching(/^axiom:/u), expect.stringMatching(/^axiom:/u)],
                locations: [
                    { file: 'ontology.ttl', line: 8, column: 5 },
                    { file: 'ontology.ttl', line: 10, column: 5 },
                ],
            },
        ]);
        expect(renderCheckProjectReport(refused.report)).toContain(
            'so reasoning is refused (at ontology.ttl:8:5, ontology.ttl:10:5)',
        );
    });

    it('fails before materialization on trusted consistent error diagnostics and canonicalizes duplicates', async () => {
        const project = writeProject({ ontology: `${PREFIXES} ex:A a owl:Class .` });
        const ontologyBase = makeOntologyService(makeNodeOntologyPorts());
        const validateAssembled = vi.fn(ontologyBase.validateAssembled);
        const ontology: OntologyServiceShape = { ...ontologyBase, validateAssembled };
        const diagnostic = {
            severity: 'warning' as const,
            code: 'duplicate-warning',
            message: 'same warning',
            axiomIds: [] as string[],
        };
        const reasoner: ReasonerServiceShape = {
            ...nodeReasonerService,
            decideAndMaterialize: (graph, options) =>
                nodeReasonerService.decideAndMaterialize(graph, options).pipe(
                    Effect.map(({ decision }) => ({
                        reasoned: null,
                        decision: {
                            ...decision,
                            response: {
                                ...decision.response,
                                result: {
                                    ...decision.response.result,
                                    diagnostics: [
                                        diagnostic,
                                        { ...diagnostic },
                                        {
                                            severity: 'error' as const,
                                            code: 'adapter-error',
                                            message: 'trusted diagnostic error',
                                            axiomIds: [],
                                        },
                                    ],
                                },
                            },
                        },
                    })),
                ),
        };
        const report = await Effect.runPromise(
            makeCheckProjectService(makeManifestService(), ontology, reasoner).check({
                manifestPath: project.manifestPath,
            }),
        );
        expect(report).toMatchObject({
            outcome: 'failed',
            reasoning: { outcome: 'decided', consistency: 'consistent' },
            stages: {
                reasoning: { status: 'failed', failureCodes: ['reasoner-error-diagnostic'] },
                core: { status: 'not-run' },
                shacl: { status: 'not-run' },
                competencyQuestions: { status: 'not-run' },
                citations: { status: 'not-run' },
            },
        });
        expect(report.reasoning.diagnostics).toHaveLength(2);
        expect(report.warnings).toEqual([expect.objectContaining({ code: 'duplicate-warning' })]);
        expect(validateAssembled).not.toHaveBeenCalled();
        expect(renderCheckProjectReport(report)).toContain('trusted diagnostic error');
    });

    it('preserves authenticated incompatibility expected/actual evidence in the failed report', async () => {
        const project = writeProject({ ontology: `${PREFIXES} ex:A a owl:Class .` });
        const reasoner: ReasonerServiceShape = {
            ...nodeReasonerService,
            decideAndMaterialize: (graph, options) =>
                nodeReasonerService.decideAndMaterialize(graph, options).pipe(
                    Effect.flatMap(({ decision }) =>
                        Effect.fail(
                            new TrustedNegativeReasonerOutcomeError({
                                outcome: 'incompatible',
                                reason: 'input-digest',
                                protocolVersion: decision.response.protocolVersion,
                                expected: 'expected digest',
                                actual: 'actual digest',
                                requestId: decision.normalization.request.requestId,
                                profile: decision.response.profile,
                                tool: decision.response.tool,
                                inputDigest: decision.response.inputDigest,
                                diagnostics: [
                                    { severity: 'error', code: 'input-digest', message: 'incompatible', axiomIds: [] },
                                ],
                            }),
                        ),
                    ),
                ),
        };
        const report = await Effect.runPromise(
            makeCheckProjectService(
                makeManifestService(),
                makeOntologyService(makeNodeOntologyPorts()),
                reasoner,
            ).check({ manifestPath: project.manifestPath }),
        );
        expect(report.reasoning.negativeOutcome).toEqual({
            outcome: 'incompatible',
            reason: 'input-digest',
            expected: 'expected digest',
            actual: 'actual digest',
        });
        expect(report.reasoning.protocolVersion).toBe(REASONER_PROTOCOL_VERSION);
        expect(report.stages.reasoning.failureCodes).toEqual(['input-digest']);
    });

    it('keeps consistent unsatisfiable named classes visible and nonblocking', async () => {
        const { report } = await runNodeProject({
            ontology: `${PREFIXES}
ex:Impossible a owl:Class ; rdfs:subClassOf ex:Person, ex:Machine .
ex:Person a owl:Class ; owl:disjointWith ex:Machine .
ex:Machine a owl:Class .
`,
        });
        expect(report.outcome).toBe('passed');
        expect(report.reasoning.unsatisfiableClasses.map((item) => item.classIri)).toContain(
            'https://example.test/root#Impossible',
        );
        expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'unsatisfiable-class' }));
    });

    it('binds ontology, shape, and question reports to exact raw bytes including BOM, CRLF, and Unicode', async () => {
        const ontology = `${PREFIXES.replaceAll('\n', '\r\n')}# café\r\nex:A a owl:Class .\r\nex:alice a ex:A .\r\n`;
        const shape = `\uFEFF${PREFIXES.replaceAll('\n', '\r\n')}@prefix sh: <http://www.w3.org/ns/shacl#> .\r\nex:Shape a sh:NodeShape ; sh:targetClass ex:A .\r\n`;
        const question = `# @ask     Café instances?\r\n# @expect  rows == 1\r\n# @from    Exact octets, not re-encoded text.\r\nSELECT ?s WHERE { ?s a <https://example.test/root#A> }\r\n`;
        const { project, report } = await runNodeProject({ ontology, shape, question });
        const expected = new Map([
            ['ontology.ttl', sha256(readFileSync(join(project.root, 'ontology.ttl')))],
            ['shapes.ttl', sha256(readFileSync(join(project.root, 'shapes.ttl')))],
            ['question.rq', sha256(readFileSync(join(project.root, 'question.rq')))],
        ]);
        expect(report.sources.files.map((item) => [item.file, item.contentDigest])).toEqual([
            ['question.rq', expected.get('question.rq')],
            ['ontology.ttl', expected.get('ontology.ttl')],
            ['shapes.ttl', expected.get('shapes.ttl')],
        ]);
    });

    it('validates captured shape and question artifacts without rereading mutated files', async () => {
        const fixture: ProjectFixture = {
            ontology: `${PREFIXES} ex:A a owl:Class ; rdfs:subClassOf ex:B . ex:B a owl:Class . ex:alice a ex:A .`,
            shape: `${PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .
ex:Shape a sh:NodeShape ; sh:targetClass ex:A ;
  sh:property [ sh:path rdf:type ; sh:hasValue ex:B ] .`,
            question: `# @ask     One instance?
# @expect  rows == 1
# @from    Captured CQ source bytes are authoritative.
SELECT ?s WHERE { ?s a <https://example.test/root#B> }
`,
        };
        const project = writeProject(fixture);
        const originalShape = readFileSync(join(project.root, 'shapes.ttl'));
        const originalQuestion = readFileSync(join(project.root, 'question.rq'));
        const ontologyBase = makeOntologyService(makeNodeOntologyPorts());
        const ontology: OntologyServiceShape = {
            ...ontologyBase,
            discoverShapeSources: (locations, required) =>
                ontologyBase.discoverShapeSources(locations, required).pipe(
                    Effect.tap((sources) =>
                        Effect.sync(() => {
                            for (const source of sources) {
                                writeFileSync(source.locator, 'not valid Turtle {', 'utf8');
                            }
                        }),
                    ),
                ),
            discoverCompetencyQuestions: (locations, required) =>
                ontologyBase.discoverCompetencyQuestions(locations, required).pipe(
                    Effect.tap((questions) =>
                        Effect.sync(() => {
                            for (const question of questions) {
                                writeFileSync(question.locator, 'not valid SPARQL {', 'utf8');
                            }
                        }),
                    ),
                ),
        };
        const report = await Effect.runPromise(
            makeCheckProjectService(makeManifestService(), ontology, nodeReasonerService).check({
                manifestPath: project.manifestPath,
            }),
        );
        expect(report.outcome).toBe('passed');
        expect(report.sources.files.find((item) => item.stage === 'shapes')?.contentDigest).toBe(sha256(originalShape));
        expect(report.sources.files.find((item) => item.stage === 'competency-questions')?.contentDigest).toBe(
            sha256(originalQuestion),
        );
    });

    it('fails closed when a discovered competency-question byte snapshot is mutated', async () => {
        const project = writeProject({
            ontology: `${PREFIXES} ex:A a owl:Class . ex:alice a ex:A .`,
            question: `# @ask     One instance?
# @expect  rows == 1
# @from    Mutation must be detected.
SELECT ?s WHERE { ?s a <https://example.test/root#A> }
`,
        });
        const ontologyBase = makeOntologyService(makeNodeOntologyPorts());
        const ontology: OntologyServiceShape = {
            ...ontologyBase,
            discoverCompetencyQuestions: (locations, required) =>
                ontologyBase.discoverCompetencyQuestions(locations, required).pipe(
                    Effect.tap((questions) =>
                        Effect.sync(() => {
                            const first = questions[0]?.bytes;
                            if (first !== undefined && first.length > 0) {
                                first[0] = 0xff;
                            }
                        }),
                    ),
                ),
        };
        const failure = await Effect.runPromise(
            Effect.flip(
                makeCheckProjectService(makeManifestService(), ontology, nodeReasonerService).check({
                    manifestPath: project.manifestPath,
                }),
            ),
        );
        expect(failure).toMatchObject({
            code: 'CHECK_COMPETENCY_QUESTION_ARTIFACT_MISMATCH',
            stage: 'validation',
        });
    });

    it('preserves hostile SHACL message text in JSON and terminal-escapes it in human output', async () => {
        const turtleMessage = 'danger\\u0000\\r\\u001B\\\\n';
        const expectedMessage = `danger\u0000\r\u001b\\n`;
        const { report } = await runNodeProject({
            ontology: `${PREFIXES} ex:A a owl:Class . ex:alice a ex:A .`,
            shape: `${PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .
ex:Shape a sh:NodeShape ; sh:targetClass ex:A ;
  sh:property [ sh:path ex:missing ; sh:minCount 1 ; sh:message "${turtleMessage}" ] .`,
        });
        const message = report.stages.shacl.details?.findings[0]?.message;
        expect(message).toBe(expectedMessage);
        expect(
            decodeCheckProjectReport(JSON.parse(encodeCheckProjectReport(report))).stages.shacl.details?.findings[0]
                ?.message,
        ).toBe(expectedMessage);
        const human = renderCheckProjectReport(report);
        expect(human).toContain('danger\\u0000\\r\\u001b\\\\n');
        expect(human).not.toMatch(/[\u0000\r\u001b]/u);
    });

    it.each(['Warning', 'Info'] as const)(
        'surfaces nonblocking SHACL %s findings as report warnings',
        async (severity) => {
            const { report } = await runNodeProject({
                ontology: `${PREFIXES} ex:A a owl:Class . ex:alice a ex:A .`,
                shape: `${PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .
ex:Shape a sh:NodeShape ; sh:targetClass ex:A ;
  sh:property [ sh:path ex:missing ; sh:minCount 1 ; sh:severity sh:${severity} ; sh:message "nonblocking finding" ] .`,
            });
            expect(report.outcome).toBe('passed');
            expect(report.warnings).toContainEqual(
                expect.objectContaining({
                    stage: 'shacl',
                    code: severity === 'Warning' ? 'shacl-warning' : 'shacl-info',
                }),
            );
            expect(renderCheckProjectReport(report)).toContain('nonblocking finding');
        },
    );

    it('reports citation metadata ambiguity as actionable semantic failure', async () => {
        const { report } = await runNodeProject({
            ontology: `${PREFIXES}
@prefix ev: <https://erden.cbnsndwch.dev/onto/evidence#> .
ev:sourcePath a owl:AnnotationProperty .
ev:sourceRoot a owl:AnnotationProperty .
ex:observation ev:sourcePath "evidence.txt" ; ev:sourceRoot "a", "b" .`,
        });
        expect(report).toMatchObject({
            outcome: 'failed',
            stages: { citations: { status: 'failed', details: { conforms: false } } },
        });
        expect(report.stages.citations.details?.citations[0]).toMatchObject({
            status: 'ambiguous-metadata',
            blocking: true,
            metadataDiagnostics: [expect.objectContaining({ values: ['a', 'b'] })],
        });
        expect(renderCheckProjectReport(report)).toContain(
            'ambiguous https://erden.cbnsndwch.dev/onto/evidence#sourceRoot',
        );
    });

    it('surfaces no-root and no-Git citation checks as deterministic nonblocking warnings', async () => {
        const ontologyText = `${PREFIXES}
@prefix ev: <https://erden.cbnsndwch.dev/onto/evidence#> .
ev:sourcePath a owl:AnnotationProperty .
ex:observation ev:sourcePath "evidence.txt" .`;
        const noRoot = await runNodeProject({ ontology: ontologyText });
        expect(noRoot.report.warnings).toContainEqual(expect.objectContaining({ code: 'no-source-root' }));
        expect(renderCheckProjectReport(noRoot.report)).toContain('could not be fully checked');

        const project = writeProject({ ontology: ontologyText, citationRoots: { default: '.' } });
        writeFileSync(join(project.root, 'evidence.txt'), 'evidence', 'utf8');
        const nodePorts = makeNodeOntologyPorts();
        const report = await Effect.runPromise(
            makeCheckProjectService(
                makeManifestService(),
                makeOntologyService({ resources: nodePorts.resources, citationFiles: nodePorts.citationFiles }),
                nodeReasonerService,
            ).check({ manifestPath: project.manifestPath }),
        );
        expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'git-unavailable' }));
        expect(renderCheckProjectReport(report)).toContain('git-unavailable');
    });

    it('truthfully represents empty well-formed citation literals without a construction defect', async () => {
        const { report } = await runNodeProject({
            ontology: `${PREFIXES}
@prefix ev: <https://erden.cbnsndwch.dev/onto/evidence#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
ev:sourcePath a owl:AnnotationProperty . ev:sourceRoot a owl:AnnotationProperty .
ev:atCommit a owl:AnnotationProperty . ev:inRepository a owl:AnnotationProperty .
rdfs:label a owl:AnnotationProperty . prov:wasGeneratedBy a owl:ObjectProperty .
ex:observation ev:sourcePath "evidence.txt" ; ev:sourceRoot "" ; ev:atCommit "" ; ev:inRepository "" .
ex:fact prov:wasGeneratedBy ex:observation ; rdfs:label "" .`,
        });
        expect(report.stages.citations.details?.citations[0]).toMatchObject({
            commit: '',
            repository: '',
            root: '',
            affectedFacts: [''],
            status: 'no-source-root',
        });
    });

    it.each([
        [
            'core',
            {
                ontology: `${PREFIXES} ex:p a owl:ObjectProperty .`,
            },
            'core',
        ],
        [
            'SHACL',
            {
                ontology: `${PREFIXES} ex:A a owl:Class . ex:alice a ex:A .`,
                shape: `${PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .
ex:FailingShape a sh:NodeShape ; sh:targetClass ex:A ;
  sh:property [ sh:path ex:missing ; sh:minCount 1 ; sh:message "missing value" ] .`,
            },
            'shacl',
        ],
        [
            'competency question',
            {
                ontology: `${PREFIXES} ex:A a owl:Class . ex:alice a ex:A .`,
                question: `# @ask     Are there two instances?
# @expect  rows >= 2
# @from    A deliberately failing conformance fixture.
SELECT ?s WHERE { ?s a <https://example.test/root#A> }
`,
            },
            'competencyQuestions',
        ],
        [
            'citation',
            {
                ontology: `${PREFIXES}
@prefix ev: <https://erden.cbnsndwch.dev/onto/evidence#> .
ev:sourcePath a owl:AnnotationProperty .
ex:observation ev:sourcePath "missing.txt" .
`,
                citationRoots: { default: '.' },
            },
            'citations',
        ],
    ] as const)('returns a deterministic failed report for %s conformance', async (_label, fixture, stage) => {
        const { report } = await runNodeProject(fixture);
        expect(report.outcome).toBe('failed');
        expect(report.stages[stage].status).toBe('failed');
        expect(renderCheckProjectReport(report)).toContain('Failures:');
    });

    it('requires a canonical lock before any ontology or reasoner operation is accessed', async () => {
        const root = makeTempRoot();
        const loaded: LoadedManifestV1 = {
            format: 'json',
            filePath: join(root, 'erden.config.json'),
            projectRoot: root,
            manifest: {
                schemaVersion: 1,
                canonicalIri: 'https://example.test/root',
                alias: '@example/root',
                ownedIriPrefixes: ['https://example.test/root#'],
                sources: { ontology: ['ontology.ttl'], shapes: [], competencyQuestions: [] },
                citationRoots: {},
                dependencies: { '@example/dependency': '^1.0.0' },
            },
            resolvedSources: { ontology: [join(root, 'ontology.ttl')], shapes: [], competencyQuestions: [] },
            resolvedCitationRoots: {},
        };
        writeFixtureFile(loaded.filePath, serializeManifestV1(loaded.manifest, 'json'));
        let ontologyAccesses = 0;
        let reasonerAccesses = 0;
        const ontology = new Proxy({} as OntologyServiceShape, {
            get: () => {
                ontologyAccesses += 1;
                return undefined;
            },
        });
        const reasoner = new Proxy({} as ReasonerServiceShape, {
            get: () => {
                reasonerAccesses += 1;
                return undefined;
            },
        });
        const failure = await Effect.runPromise(
            Effect.flip(
                makeCheckProjectService(makeManifestService(), ontology, reasoner).check({ from: root, offline: true }),
            ),
        );
        expect(failure).toMatchObject({ code: 'CHECK_LOCK_MISSING', stage: 'dependencies' });
        expect(ontologyAccesses).toBe(0);
        expect(reasonerAccesses).toBe(0);
    });

    it.each([
        ['exact duplicate', ['ontology.ttl', 'ontology.ttl']],
        ['normalized duplicate', ['ontology.ttl', './ontology.ttl']],
        ['portable case-collision duplicate', ['ontology.ttl', 'ONTOLOGY.TTL']],
        ['overlapping directory and file selectors', ['ontologies', 'ontologies/ontology.ttl']],
    ] as const)('rejects %s discovered sources before assembly or reasoning', async (_label, selectors) => {
        const root = makeTempRoot();
        mkdirSync(join(root, 'ontologies'), { recursive: true });
        writeFixtureFile(join(root, 'ontology.ttl'), `${PREFIXES} ex:A a owl:Class .`);
        writeFixtureFile(join(root, 'ONTOLOGY.TTL'), `${PREFIXES} ex:A a owl:Class .`);
        writeFixtureFile(join(root, 'ontologies', 'ontology.ttl'), `${PREFIXES} ex:A a owl:Class .`);
        const manifestPath = join(root, 'erden.config.json');
        writeFixtureFile(
            manifestPath,
            `${JSON.stringify({
                schemaVersion: 1,
                canonicalIri: 'https://example.test/root',
                alias: '@example/root',
                ownedIriPrefixes: ['https://example.test/root#'],
                sources: { ontology: selectors },
            })}\n`,
        );
        const loaded = Effect.runSync(makeManifestService().load({ explicitPath: manifestPath, from: root }));
        writeEmptyLock(root, loaded.manifest);
        const decideAndMaterialize = vi.fn(nodeReasonerService.decideAndMaterialize);
        const reasoner: ReasonerServiceShape = { ...nodeReasonerService, decideAndMaterialize };
        const failure = await Effect.runPromise(
            Effect.flip(
                makeCheckProjectService(
                    makeManifestService(),
                    makeOntologyService(makeNodeOntologyPorts()),
                    reasoner,
                ).check({ manifestPath }),
            ),
        );
        expect(failure).toMatchObject({
            code: 'CHECK_DUPLICATE_DISCOVERED_SOURCE',
            stage: 'sources',
        });
        expect(decideAndMaterialize).not.toHaveBeenCalled();
        expect(renderCheckProjectError(failure)).not.toContain(root);
    });

    it('keeps colliding portable selector labels distinct through stable declared-entry IDs', async () => {
        const root = makeTempRoot();
        const external = makeTempRoot();
        mkdirSync(join(root, 'external', 'ontology', '0000'), { recursive: true });
        const externalFile = join(external, 'outside.ttl');
        writeFileSync(externalFile, `${PREFIXES} ex:A a owl:Class .`, 'utf8');
        writeFileSync(
            join(root, 'external', 'ontology', '0000', 'inside.ttl'),
            `${PREFIXES} ex:B a owl:Class .`,
            'utf8',
        );
        const loaded: LoadedManifestV1 = {
            format: 'json',
            filePath: join(root, 'erden.config.json'),
            projectRoot: root,
            manifest: {
                schemaVersion: 1,
                canonicalIri: 'https://example.test/root',
                alias: '@example/root',
                ownedIriPrefixes: ['https://example.test/root#'],
                sources: {
                    ontology: [externalFile, 'external/ontology/0000'],
                    shapes: [],
                    competencyQuestions: [],
                },
                citationRoots: {},
                dependencies: {},
            },
            resolvedSources: {
                ontology: [externalFile, join(root, 'external', 'ontology', '0000')],
                shapes: [],
                competencyQuestions: [],
            },
            resolvedCitationRoots: {},
        };
        const manifestBase = makeManifestService();
        const lock = makeEmptyLockfile(loaded.manifest, CURRENT_TOOLCHAIN);
        const state = Object.freeze({
            inspect: () =>
                Effect.succeed(
                    Object.freeze({
                        project: loaded,
                        manifestBytes: new TextEncoder().encode('{}\n'),
                        lockInspection: Object.freeze({
                            status: 'available' as const,
                            lock,
                            canonicalBytes: new TextEncoder().encode(serializeLockfile(lock)),
                            reasons: Object.freeze([]),
                        }),
                        revision: Object.freeze({ schema: 'erden.project-dependency-state-revision/v1' as const }),
                    }),
                ),
            recheck: () => Effect.void,
        });
        const report = await Effect.runPromise(
            makeCheckProjectService(
                { ...manifestBase, load: () => Effect.succeed(loaded) },
                makeOntologyService(makeNodeOntologyPorts()),
                nodeReasonerService,
                state,
            ).check({ from: tmpdir() }),
        );
        expect(report.sources.selectors.map((item) => item.selector)).toEqual([
            'external/ontology/0000',
            'external/ontology/0000',
        ]);
        expect(new Set(report.sources.selectors.map((item) => item.id)).size).toBe(2);
    });

    it.each(['BUNDLED_REASONER_UNAVAILABLE', 'UNTRUSTED_RESPONSE'] as const)(
        'keeps %s as a typed operational failure rather than a partial report',
        async (code) => {
            const project = writeProject({ ontology: `${PREFIXES} ex:A a owl:Class .` });
            const base = nodeReasonerService;
            const reasoner: ReasonerServiceShape = {
                ...base,
                decideAndMaterialize: () => Effect.fail(new ReasonerProcessError(code, 'injected failure')),
            };
            const failure = await Effect.runPromise(
                Effect.flip(
                    makeCheckProjectService(
                        makeManifestService(),
                        makeOntologyService(makeNodeOntologyPorts()),
                        reasoner,
                    ).check({ manifestPath: project.manifestPath }),
                ),
            );
            expect(failure).toBeInstanceOf(CheckProjectOperationalError);
            expect(failure).toMatchObject({ stage: 'reasoning', code: `CHECK_${code}` });
            expect(renderCheckProjectError(failure)).not.toContain(project.root);
            expect(JSON.stringify(failure)).not.toContain(project.root);
            expect(Object.keys(failure)).not.toContain('cause');
        },
    );

    it('checks one installed dependency closure with inference, dependency SHACL, dormant dependency CQ, and executed root CQ', async () => {
        const workspace = makeTempRoot();
        const projectRoot = join(workspace, 'project-b');
        const storeRoot = join(workspace, 'store');
        mkdirSync(projectRoot, { recursive: true });
        const leafManifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/package-b',
            alias: '@example/package-b',
            ownedIriPrefixes: ['https://example.test/package-b#'],
            dependencies: {},
            sources: { ontology: ['ontology.ttl'] },
        });
        const leafLock = makeEmptyLockfile(leafManifest, CURRENT_TOOLCHAIN);
        const leafEncoded = encodePackage({
            canonicalIri: leafManifest.canonicalIri,
            version: '1.0.0',
            dependencies: [],
            validator: CURRENT_TOOLCHAIN.validator,
            reasoner: CURRENT_TOOLCHAIN.reasoner,
            files: [
                { path: 'erden.config.json', bytes: serializeManifestV1(leafManifest, 'json'), executable: false },
                { path: 'erden.lock', bytes: serializeLockfile(leafLock), executable: false },
                {
                    path: 'ontology.ttl',
                    bytes: '@prefix dep: <https://example.test/package-a#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\ndep:B a owl:Class ; rdfs:subClassOf dep:C .\ndep:C a owl:Class .\n',
                    executable: false,
                },
            ],
        });
        const dependencyManifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/package-a',
            alias: '@example/package-a',
            ownedIriPrefixes: ['https://example.test/package-a#'],
            registry: 'https://registry.example',
            dependencies: { '@example/package-b': '^1.0.0' },
            sources: {
                ontology: ['ontology.ttl'],
                shapes: ['shapes.ttl'],
                competencyQuestions: ['dependency-question.rq'],
            },
        });
        const dependencyLock = (
            await Effect.runPromise(
                makeDependencyResolver(
                    Object.freeze({
                        resolveAlias: (_origin: string, alias: string) =>
                            Promise.resolve(
                                alias === '@example/package-b'
                                    ? { alias, canonicalIri: leafManifest.canonicalIri }
                                    : null,
                            ),
                        listPublished: (_origin: string, canonicalIri: string) =>
                            Promise.resolve(
                                canonicalIri === leafManifest.canonicalIri
                                    ? [
                                          {
                                              canonicalIri: leafManifest.canonicalIri,
                                              version: '1.0.0',
                                              archiveSha256: leafEncoded.archiveSha256,
                                              manifest: leafEncoded.manifest,
                                          },
                                      ]
                                    : [],
                            ),
                    }),
                ).resolve({ manifest: dependencyManifest, toolchain: CURRENT_TOOLCHAIN }),
            )
        ).lock;
        const encoded = encodePackage({
            canonicalIri: dependencyManifest.canonicalIri,
            version: '1.0.0',
            dependencies: dependencyLock.directDependencies.map(
                ({ canonicalIri, requested, version, archiveSha256 }) => ({
                    canonicalIri,
                    requested,
                    version,
                    archiveSha256,
                }),
            ),
            validator: CURRENT_TOOLCHAIN.validator,
            reasoner: CURRENT_TOOLCHAIN.reasoner,
            files: [
                {
                    path: 'erden.config.json',
                    bytes: serializeManifestV1(dependencyManifest, 'json'),
                    executable: false,
                },
                { path: 'erden.lock', bytes: serializeLockfile(dependencyLock), executable: false },
                {
                    path: 'ontology.ttl',
                    bytes: `@prefix dep: <https://example.test/package-a#> .\n@prefix ev: <https://w3id.org/erden/vocab/evidence#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\nev:sourcePath a owl:AnnotationProperty .\ndep:A a owl:Class ; rdfs:subClassOf dep:B .\ndep:dependencyObservation ev:sourcePath "missing-dependency-only.txt" .\n`,
                    executable: false,
                },
                {
                    path: 'shapes.ttl',
                    bytes: `@prefix dep: <https://example.test/package-a#> .\n@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n@prefix sh: <http://www.w3.org/ns/shacl#> .\ndep:InheritedTypeShape a sh:NodeShape ; sh:targetClass dep:A ; sh:property [ sh:path rdf:type ; sh:hasValue dep:C ; sh:message "transitive dependency inference is required" ] .\n`,
                    executable: false,
                },
                {
                    path: 'dependency-question.rq',
                    bytes: '# @ask Dependency guidance\n# @expect rows >= 1\n# @from Dependency questions are dormant in consumers.\nSELECT ?s WHERE { ?s a <https://example.test/package-a#B> }\n',
                    executable: false,
                },
            ],
        });
        const registry = makeFixtureDependencyRegistry({
            registryOrigin: 'https://registry.example',
            aliases: [{ alias: '@example/package-a', canonicalIri: dependencyManifest.canonicalIri }],
            packages: [
                {
                    canonicalIri: dependencyManifest.canonicalIri,
                    version: '1.0.0',
                    archiveSha256: encoded.archiveSha256,
                    manifest: encoded.manifest,
                    archive: encoded.archiveBytes,
                },
                {
                    canonicalIri: leafManifest.canonicalIri,
                    version: '1.0.0',
                    archiveSha256: leafEncoded.archiveSha256,
                    manifest: leafEncoded.manifest,
                    archive: leafEncoded.archiveBytes,
                },
            ],
        });
        const rootManifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/project-b',
            alias: '@example/project-b',
            ownedIriPrefixes: ['https://example.test/project-b#'],
            registry: 'https://registry.example',
            dependencies: { '@example/package-a': '^1.0.0' },
            sources: { ontology: ['ontology.ttl'], competencyQuestions: ['root-question.rq'] },
        });
        const manifestPath = join(projectRoot, 'erden.config.json');
        writeFixtureFile(manifestPath, serializeManifestV1(rootManifest, 'json'));
        writeFileSync(
            join(projectRoot, 'ontology.ttl'),
            `@prefix dep: <https://example.test/package-a#> .\n@prefix root: <https://example.test/project-b#> .\nroot:alice a dep:A .\n`,
            'utf8',
        );
        writeFileSync(
            join(projectRoot, 'root-question.rq'),
            '# @ask Inherited transitive dependency type\n# @expect rows == 1\n# @from The complete dependency closure is reasoned once with the root.\nSELECT ?s WHERE { ?s a <https://example.test/package-a#C> }\n',
            'utf8',
        );

        await Effect.runPromise(
            makeNodeInstallProjectService(registry).install({
                from: projectRoot,
                storeRoot,
            }),
        );
        registry.clearTrace();
        const normal = await Effect.runPromise(nodeCheckService().check({ from: projectRoot }));
        const offline = await Effect.runPromise(nodeCheckService().check({ from: projectRoot, offline: true }));
        expect(normal.outcome).toBe('passed');
        expect(encodeCheckProjectReport(normal)).toBe(encodeCheckProjectReport(offline));
        expect(registry.trace()).toEqual([]);
        expect(
            normal.reasoning.inferred.some(
                (item) =>
                    item.subject === 'https://example.test/project-b#alice' &&
                    item.object === 'https://example.test/package-a#C' &&
                    item.contributingOwners.some((owner) => owner.role === 'dependency'),
            ),
        ).toBe(true);
        expect(
            normal.stages.shacl.details?.shapes.some((shape) =>
                shape.owners.some((owner) => owner.role === 'dependency'),
            ),
        ).toBe(true);
        expect(normal.stages.competencyQuestions.details).toMatchObject({ executed: 1, dormant: 1 });
        expect(normal.stages.competencyQuestions.details?.questions.map(({ execution }) => execution).sort()).toEqual([
            'dormant-dependency',
            'executed',
        ]);
        expect(
            normal.sources.files.some((file) => file.file.startsWith(`dependencies/${encoded.archiveSha256}/`)),
        ).toBe(true);
        expect(encodeCheckProjectReport(normal)).not.toContain(projectRoot.replaceAll('\\', '/'));
        expect(encodeCheckProjectReport(normal)).not.toContain(storeRoot.replaceAll('\\', '/'));
    });

    it.each(['C:/outside/ontology.ttl', '../outside.ttl', 'ontology\\outside.ttl'])(
        'rejects noncanonical dependency selector %s before reading outside the authenticated file index',
        async (selector) => {
            const fixture = await installLeafDependency({
                dependencySources: { ontology: [selector], shapes: [], competencyQuestions: [] },
                dependencyFiles: [
                    {
                        path: 'ontology.ttl',
                        bytes: '@prefix dep: <https://example.test/fixture-dependency#> . dep:A a dep:Class .\n',
                    },
                ],
            });
            const failure = await Effect.runPromise(
                Effect.flip(nodeCheckService().check({ from: fixture.projectRoot })),
            );
            expect(failure).toMatchObject({ stage: 'dependencies', code: 'CHECK_DEPENDENCY_SOURCE_INVALID' });
            expect(JSON.stringify(failure)).not.toContain(fixture.projectRoot);
            expect(JSON.stringify(failure)).not.toContain(fixture.storeRoot);
        },
    );

    it.each([
        { stage: 'ontology', valid: 'ontology.ttl', empty: 'empty-ontology' },
        { stage: 'shapes', valid: 'shapes.ttl', empty: 'empty-shapes' },
        { stage: 'competencyQuestions', valid: 'question.rq', empty: 'empty-questions' },
    ] as const)(
        'rejects each empty root $stage directory selector even beside a valid selector',
        async ({ stage, valid, empty }) => {
            const project = writeProject({
                ontology: `${PREFIXES} ex:A a owl:Class .`,
                shape: `${PREFIXES}\n@prefix sh: <http://www.w3.org/ns/shacl#> .\nex:S a sh:NodeShape ; sh:targetClass ex:A .\n`,
                question: '# @ask Root question\n# @expect rows >= 0\nSELECT ?s WHERE { ?s ?p ?o }\n',
            });
            mkdirSync(join(project.root, empty));
            const manifest = JSON.parse(readFileSync(project.manifestPath, 'utf8')) as {
                readonly sources: Record<string, ReadonlyArray<string>>;
            };
            manifest.sources[stage] = [valid, empty];
            writeFileSync(project.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
            const failure = await Effect.runPromise(Effect.flip(nodeCheckService().check({ from: project.root })));
            expect(failure).toMatchObject({ stage: 'sources' });
            expect(failure.diagnostics[0]?.file).toBe(empty);
        },
    );

    it.each([
        { stage: 'ontology', empty: 'empty-ontology' },
        { stage: 'shapes', empty: 'empty-shapes' },
        { stage: 'competencyQuestions', empty: 'empty-questions' },
    ] as const)(
        'rejects each empty dependency $stage selector against the authenticated file index',
        async ({ stage, empty }) => {
            const sources = {
                ontology: ['ontology.ttl'],
                shapes: [] as string[],
                competencyQuestions: [] as string[],
            };
            const files = [
                {
                    path: 'ontology.ttl',
                    bytes: '@prefix dep: <https://example.test/fixture-dependency#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\ndep:A a owl:Class .\n',
                },
            ];
            if (stage === 'ontology') {
                sources.ontology.push(empty);
            }
            if (stage === 'shapes') {
                sources.shapes.push('shapes.ttl', empty);
                files.push({
                    path: 'shapes.ttl',
                    bytes: '@prefix dep: <https://example.test/fixture-dependency#> .\n@prefix sh: <http://www.w3.org/ns/shacl#> .\ndep:S a sh:NodeShape ; sh:targetClass dep:A .\n',
                });
            }
            if (stage === 'competencyQuestions') {
                sources.competencyQuestions.push('question.rq', empty);
                files.push({
                    path: 'question.rq',
                    bytes: '# @ask Dependency question\n# @expect rows >= 0\nSELECT ?s WHERE { ?s ?p ?o }\n',
                });
            }
            const fixture = await installLeafDependency({ dependencySources: sources, dependencyFiles: files });
            const failure = await Effect.runPromise(
                Effect.flip(nodeCheckService().check({ from: fixture.projectRoot })),
            );
            expect(failure).toMatchObject({ stage: 'dependencies', code: 'CHECK_DEPENDENCY_SOURCE_INVALID' });
            expect(failure.diagnostics[0]?.file).toBe(`dependencies/${fixture.encoded.archiveSha256}/${empty}`);
        },
    );

    it('reports dependency parse locations only through deterministic logical package paths', async () => {
        const fixture = await installLeafDependency({
            dependencySources: { ontology: ['ontology.ttl'], shapes: [], competencyQuestions: [] },
            dependencyFiles: [{ path: 'ontology.ttl', bytes: '@prefix broken' }],
        });
        const failure = await Effect.runPromise(Effect.flip(nodeCheckService().check({ from: fixture.projectRoot })));
        expect(failure).toBeInstanceOf(CheckProjectOperationalError);
        expect(failure).toMatchObject({ stage: 'sources' });
        expect(failure.diagnostics[0]?.file).toBe(`dependencies/${fixture.encoded.archiveSha256}/ontology.ttl`);
        expect(JSON.stringify(failure)).not.toContain(fixture.projectRoot);
        expect(JSON.stringify(failure)).not.toContain(fixture.storeRoot);
    });

    it('reads an installed dependency published as RDF/XML through the same source port', async () => {
        const rdfXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE rdf:RDF [<!ENTITY dep "https://example.test/fixture-dependency#">]>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:owl="http://www.w3.org/2002/07/owl#"
    xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
    <owl:Class rdf:about="&dep;Thing"/>
    <owl:Class rdf:about="&dep;Widget"><rdfs:subClassOf rdf:resource="&dep;Thing"/></owl:Class>
</rdf:RDF>
`;
        const fixture = await installLeafDependency({
            dependencySources: { ontology: ['upstream/core.rdf'], shapes: [], competencyQuestions: [] },
            dependencyFiles: [{ path: 'upstream/core.rdf', bytes: rdfXml }],
        });
        const report = await Effect.runPromise(nodeCheckService().check({ from: fixture.projectRoot }));
        expect(report.outcome).toBe('passed');
        expect(report.sources.files.find((file) => file.id.startsWith('dependency:'))).toMatchObject({
            file: `dependencies/${fixture.encoded.archiveSha256}/upstream/core.rdf`,
            mediaType: 'application/rdf+xml',
            parser: 'oxigraph@0.5.9',
        });
        expect(report.sources.selectors.find((selector) => selector.id.startsWith('dependency:'))).toMatchObject({
            kind: 'file',
        });
    });

    it('applies each project its own outside-profile mode, from its own manifest', async () => {
        const upstream = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:owl="http://www.w3.org/2002/07/owl#"
    xmlns:dct="http://purl.org/dc/terms/">
    <owl:Ontology rdf:about="https://example.test/fixture-dependency"><dct:title>Upstream</dct:title></owl:Ontology>
    <owl:Class rdf:about="https://example.test/fixture-dependency#Thing"/>
    <owl:ObjectProperty rdf:about="https://example.test/fixture-dependency#near">
        <rdf:type rdf:resource="http://www.w3.org/2002/07/owl#AsymmetricProperty"/>
    </owl:ObjectProperty>
</rdf:RDF>
`;
        const dependency = {
            dependencySources: { ontology: ['upstream.rdf'], shapes: [], competencyQuestions: [] },
            dependencyFiles: [{ path: 'upstream.rdf', bytes: upstream }],
        };
        const refused = await installLeafDependency(dependency);
        const failure = await Effect.runPromise(Effect.flip(nodeCheckService().check({ from: refused.projectRoot })));
        expect(failure).toMatchObject({ code: 'CHECK_OUTSIDE_PROFILE' });
        // dct:title is read as an undeclared annotation property, so only the asymmetric property is refused.
        expect(failure.diagnostics.map((item) => [item.file, item.line, item.message.split(' ')[0]])).toEqual([
            [`dependencies/${refused.encoded.archiveSha256}/upstream.rdf`, 7, '[unreasoned/owl:AsymmetricProperty]'],
        ]);

        // Both report, and the consumer's import of the mirror by canonical IRI is satisfied by the closure.
        const reported = await installLeafDependency({
            ...dependency,
            dependencyOutsideProfile: 'report',
            rootOutsideProfile: 'report',
            rootOntology: `@prefix owl: <http://www.w3.org/2002/07/owl#> .
<https://example.test/fixture-consumer> a owl:Ontology ; owl:imports <https://example.test/fixture-dependency> .
`,
        });
        const report = await Effect.runPromise(nodeCheckService().check({ from: reported.projectRoot }));
        expect(report.outcome).toBe('passed');
        const file = `dependencies/${reported.encoded.archiveSha256}/upstream.rdf`;
        expect(report.unreasoned?.constructs.map((item) => [item.construct, item.examples[0]?.files])).toEqual([
            ['owl:AsymmetricProperty', [file]],
            ['owl:imports', ['ontology.ttl']],
        ]);
        expect(report.undeclaredAnnotationProperties).toEqual([
            {
                property: 'http://purl.org/dc/terms/title',
                statementCount: 1,
                files: [file],
                firstUse: { file, line: 4, column: 71 },
            },
        ]);
        expect(report.unreasoned?.imports).toEqual([
            {
                ontology: 'https://example.test/fixture-consumer',
                iri: 'https://example.test/fixture-dependency',
                status: 'satisfied',
                files: ['ontology.ttl'],
            },
        ]);

        // A consumer in refuse mode still refuses its own import, though the mirror below it reports.
        const mixed = await installLeafDependency({
            ...dependency,
            dependencyOutsideProfile: 'report',
            rootOntology: `@prefix owl: <http://www.w3.org/2002/07/owl#> .
<https://example.test/fixture-consumer> a owl:Ontology ; owl:imports <https://example.test/fixture-dependency> .
`,
        });
        const mixedFailure = await Effect.runPromise(
            Effect.flip(nodeCheckService().check({ from: mixed.projectRoot })),
        );
        expect(mixedFailure.diagnostics.map((item) => [item.file, item.message.split(' ')[0]])).toEqual([
            ['ontology.ttl', '[unreasoned/owl:imports]'],
        ]);
    }, 60_000);

    it('lists a literal value of a property another layer declares an object property, by the policy of its owner', async () => {
        // One layer gives dct:creator a literal value, as SKOS does; another declares it an object property.
        const dependency = {
            dependencySources: { ontology: ['vocabulary.ttl'], shapes: [], competencyQuestions: [] },
            dependencyFiles: [
                {
                    path: 'vocabulary.ttl',
                    bytes: `@prefix dct: <http://purl.org/dc/terms/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
<https://example.test/fixture-dependency> a owl:Ontology ; dct:creator "Someone" .
<https://example.test/fixture-dependency#Concept> a owl:Class .
`,
                },
            ],
        };
        const rootOntology = `@prefix dct: <http://purl.org/dc/terms/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
<https://example.test/fixture-consumer> a owl:Ontology .
dct:creator a owl:ObjectProperty .
`;

        // The layer that makes the statement reports, so the statement is set aside and listed; the consumer refuses.
        const reported = await installLeafDependency({
            ...dependency,
            dependencyOutsideProfile: 'report',
            rootOntology,
        });
        const report = await Effect.runPromise(nodeCheckService().check({ from: reported.projectRoot }));
        expect(report.outcome).toBe('passed');
        const file = `dependencies/${reported.encoded.archiveSha256}/vocabulary.ttl`;
        expect(report.unreasoned?.constructs).toEqual([
            expect.objectContaining({
                group: 'unreasoned',
                construct: 'malformed-rdf',
                findingCount: 1,
                statementCount: 1,
                examples: [
                    expect.objectContaining({
                        subject: 'https://example.test/fixture-dependency',
                        predicate: 'http://purl.org/dc/terms/creator',
                        files: [file],
                        location: { file, line: 3, column: 60 },
                        description: expect.stringContaining(
                            'http://purl.org/dc/terms/creator is declared an owl:ObjectProperty in the checked ontologies',
                        ) as unknown,
                    }),
                ],
            }),
        ]);
        expect(renderCheckProjectReport(report)).toContain(`[unreasoned/malformed-rdf] 1 finding, 1 statement`);

        // The layer that makes the statement refuses: a located refusal that says why and what to change.
        const refused = await installLeafDependency({ ...dependency, rootOntology, rootOutsideProfile: 'report' });
        const failure = await Effect.runPromise(Effect.flip(nodeCheckService().check({ from: refused.projectRoot })));
        expect(failure).toMatchObject({ code: 'CHECK_UNREPRESENTABLE_RDF_TERM', stage: 'reasoning' });
        expect(failure.diagnostics).toEqual([
            expect.objectContaining({
                code: 'UNREPRESENTABLE_RDF_TERM',
                file: `dependencies/${refused.encoded.archiveSha256}/vocabulary.ttl`,
                line: 3,
                column: 60,
            }),
        ]);
        const rendered = renderCheckProjectError(failure);
        expect(rendered).toContain(
            'http://purl.org/dc/terms/creator is declared an owl:ObjectProperty in the checked ontologies, so this literal value cannot be read as an assertion',
        );
        expect(rendered).toContain('set outsideProfile to report in the project that makes this statement');
    }, 60_000);

    it('authenticates every consumed dependency byte and never exposes a mutating store capability to Check', async () => {
        const fixture = await installLeafDependency({
            dependencySources: { ontology: ['ontology.ttl'], shapes: [], competencyQuestions: [] },
            dependencyFiles: [
                {
                    path: 'ontology.ttl',
                    bytes: '@prefix dep: <https://example.test/fixture-dependency#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\ndep:A a owl:Class .\n',
                },
            ],
        });
        const base = makeInstalledClosureReader();
        let mutated = false;
        const reader: InstalledClosureReaderShape = Object.freeze({
            resolve: (request: Parameters<InstalledClosureReaderShape['resolve']>[0]) =>
                base.resolve(request).pipe(
                    Effect.tap((closure) =>
                        Effect.sync(() => {
                            const layer = closure.layers[0];
                            if (layer === undefined) {
                                throw new Error('missing fixture layer');
                            }
                            const path = join(layer.root, 'ontology.ttl');
                            chmodSync(path, 0o666);
                            writeFileSync(path, '@prefix changed: <https://changed.invalid/> .\n', 'utf8');
                            mutated = true;
                        }),
                    ),
                ),
            readFile: (request: Parameters<InstalledClosureReaderShape['readFile']>[0]) => base.readFile(request),
        });
        expect(Object.keys(reader).sort()).toEqual(['readFile', 'resolve']);
        expect('put' in reader || 'repair' in reader || 'materialize' in reader).toBe(false);
        const failure = await Effect.runPromise(
            Effect.flip(
                makeCheckProjectService(
                    makeManifestService(),
                    makeOntologyService(makeNodeOntologyPorts()),
                    nodeReasonerService,
                    nodeProjectDependencyStateService,
                    nodeCurrentToolchainService,
                    reader,
                ).check({ from: fixture.projectRoot }),
            ),
        );
        expect(mutated).toBe(true);
        expect(failure).toMatchObject({ stage: 'dependencies', code: 'CHECK_DEPENDENCY_SOURCE_INVALID' });
    });

    it('uses an authenticated byte snapshot even if the installed path changes and is restored after the read', async () => {
        const original =
            '@prefix dep: <https://example.test/fixture-dependency#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\ndep:A a owl:Class .\n';
        const fixture = await installLeafDependency({
            dependencySources: { ontology: ['ontology.ttl'], shapes: [], competencyQuestions: [] },
            dependencyFiles: [{ path: 'ontology.ttl', bytes: original }],
        });
        const base = makeInstalledClosureReader();
        let changedAndRestored = false;
        const reader: InstalledClosureReaderShape = Object.freeze({
            resolve: (request: Parameters<InstalledClosureReaderShape['resolve']>[0]) => base.resolve(request),
            readFile: (request: Parameters<InstalledClosureReaderShape['readFile']>[0]) =>
                base.readFile(request).pipe(
                    Effect.tap((file) =>
                        Effect.sync(() => {
                            if (request.path !== 'ontology.ttl') {
                                return;
                            }
                            const layer = request.closure.layers.find(
                                (item) => item.canonicalIri === request.canonicalIri,
                            );
                            if (layer === undefined) {
                                throw new Error('missing fixture layer');
                            }
                            const path = join(layer.root, request.path);
                            chmodSync(path, 0o666);
                            writeFileSync(path, '@prefix transient: <https://transient.invalid/> .\n', 'utf8');
                            writeFileSync(path, original, 'utf8');
                            chmodSync(path, 0o444);
                            changedAndRestored = true;
                            expect(file.bytes).toEqual(new TextEncoder().encode(original));
                        }),
                    ),
                ),
        });
        const report = await Effect.runPromise(
            makeCheckProjectService(
                makeManifestService(),
                makeOntologyService(makeNodeOntologyPorts()),
                nodeReasonerService,
                nodeProjectDependencyStateService,
                nodeCurrentToolchainService,
                reader,
            ).check({ from: fixture.projectRoot }),
        );
        expect(changedAndRestored).toBe(true);
        expect(report.outcome).toBe('passed');
    });

    it('rejects an embedded dependency lock whose complete transitive graph differs from the consumer lock', async () => {
        const registryOrigin = 'https://registry.example';
        function packageManifest(name: 'a' | 'b' | 'c', dependencies: Readonly<Record<string, string>>) {
            return normalizeManifestV1({
                schemaVersion: 1,
                canonicalIri: `https://example.test/graph-${name}`,
                alias: `@example/graph-${name}`,
                ownedIriPrefixes: [`https://example.test/graph-${name}#`],
                ...(Object.keys(dependencies).length === 0 ? {} : { registry: registryOrigin }),
                dependencies,
                sources: { ontology: ['ontology.ttl'] },
            });
        }
        const manifestC = packageManifest('c', {});
        const lockC = makeEmptyLockfile(manifestC, CURRENT_TOOLCHAIN);
        const encodedC = encodePackage({
            canonicalIri: manifestC.canonicalIri,
            version: '1.0.0',
            dependencies: [],
            validator: CURRENT_TOOLCHAIN.validator,
            reasoner: CURRENT_TOOLCHAIN.reasoner,
            files: [
                { path: 'erden.config.json', bytes: serializeManifestV1(manifestC, 'json'), executable: false },
                { path: 'erden.lock', bytes: serializeLockfile(lockC), executable: false },
                {
                    path: 'ontology.ttl',
                    bytes: '@prefix c: <https://example.test/graph-c#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\nc:C a owl:Class .\n',
                    executable: false,
                },
            ],
        });
        async function resolveFixtureLock(
            manifest: LoadedManifestV1['manifest'],
            aliases: Readonly<Record<string, string>>,
            records: ReadonlyArray<
                Readonly<{
                    readonly canonicalIri: string;
                    readonly version: string;
                    readonly archiveSha256: string;
                    readonly manifest: ReturnType<typeof encodePackage>['manifest'];
                }>
            >,
        ) {
            return (
                await Effect.runPromise(
                    makeDependencyResolver(
                        Object.freeze({
                            resolveAlias: (_origin: string, alias: string) => {
                                const canonicalIri = aliases[alias];
                                return Promise.resolve(canonicalIri === undefined ? null : { alias, canonicalIri });
                            },
                            listPublished: (_origin: string, canonicalIri: string) =>
                                Promise.resolve(records.filter((record) => record.canonicalIri === canonicalIri)),
                        }),
                    ).resolve({ manifest, toolchain: CURRENT_TOOLCHAIN }),
                )
            ).lock;
        }
        const manifestB = packageManifest('b', { '@example/graph-c': '^1.0.0' });
        const recordC = {
            canonicalIri: manifestC.canonicalIri,
            version: '1.0.0',
            archiveSha256: encodedC.archiveSha256,
            manifest: encodedC.manifest,
        };
        const lockB = await resolveFixtureLock(manifestB, { '@example/graph-c': manifestC.canonicalIri }, [recordC]);
        const encodedB = encodePackage({
            canonicalIri: manifestB.canonicalIri,
            version: '1.0.0',
            dependencies: lockB.directDependencies,
            validator: CURRENT_TOOLCHAIN.validator,
            reasoner: CURRENT_TOOLCHAIN.reasoner,
            files: [
                { path: 'erden.config.json', bytes: serializeManifestV1(manifestB, 'json'), executable: false },
                { path: 'erden.lock', bytes: serializeLockfile(lockB), executable: false },
                {
                    path: 'ontology.ttl',
                    bytes: '@prefix b: <https://example.test/graph-b#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\nb:B a owl:Class .\n',
                    executable: false,
                },
            ],
        });
        const manifestA = packageManifest('a', { '@example/graph-b': '^1.0.0' });
        const leafBManifest = encodePackage({
            canonicalIri: manifestB.canonicalIri,
            version: '1.0.0',
            dependencies: [],
            validator: CURRENT_TOOLCHAIN.validator,
            reasoner: CURRENT_TOOLCHAIN.reasoner,
            files: [],
        }).manifest;
        const lockAWithWrongSubgraph = await resolveFixtureLock(
            manifestA,
            { '@example/graph-b': manifestB.canonicalIri },
            [
                {
                    canonicalIri: manifestB.canonicalIri,
                    version: '1.0.0',
                    archiveSha256: encodedB.archiveSha256,
                    manifest: leafBManifest,
                },
            ],
        );
        const encodedA = encodePackage({
            canonicalIri: manifestA.canonicalIri,
            version: '1.0.0',
            dependencies: lockAWithWrongSubgraph.directDependencies,
            validator: CURRENT_TOOLCHAIN.validator,
            reasoner: CURRENT_TOOLCHAIN.reasoner,
            files: [
                { path: 'erden.config.json', bytes: serializeManifestV1(manifestA, 'json'), executable: false },
                { path: 'erden.lock', bytes: serializeLockfile(lockAWithWrongSubgraph), executable: false },
                {
                    path: 'ontology.ttl',
                    bytes: '@prefix a: <https://example.test/graph-a#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\na:A a owl:Class .\n',
                    executable: false,
                },
            ],
        });
        const root = makeTempRoot();
        const rootManifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/graph-root',
            alias: '@example/graph-root',
            ownedIriPrefixes: ['https://example.test/graph-root#'],
            registry: registryOrigin,
            dependencies: { '@example/graph-a': '^1.0.0' },
            sources: { ontology: ['ontology.ttl'] },
        });
        const records = [
            {
                canonicalIri: manifestA.canonicalIri,
                version: '1.0.0',
                archiveSha256: encodedA.archiveSha256,
                manifest: encodedA.manifest,
            },
            {
                canonicalIri: manifestB.canonicalIri,
                version: '1.0.0',
                archiveSha256: encodedB.archiveSha256,
                manifest: encodedB.manifest,
            },
            recordC,
        ];
        const rootLock = await resolveFixtureLock(
            rootManifest,
            { '@example/graph-a': manifestA.canonicalIri },
            records,
        );
        writeFixtureFile(join(root, 'erden.config.json'), serializeManifestV1(rootManifest, 'json'));
        writeFixtureFile(join(root, 'erden.lock'), serializeLockfile(rootLock));
        writeFileSync(
            join(root, 'ontology.ttl'),
            '@prefix root: <https://example.test/graph-root#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\nroot:Root a owl:Class .\n',
            'utf8',
        );

        const artifacts = new Map([
            [manifestA.canonicalIri, { encoded: encodedA, manifest: manifestA, lock: lockAWithWrongSubgraph }],
            [manifestB.canonicalIri, { encoded: encodedB, manifest: manifestB, lock: lockB }],
            [manifestC.canonicalIri, { encoded: encodedC, manifest: manifestC, lock: lockC }],
        ]);
        const byteMaps = new Map<string, Map<string, Uint8Array>>();
        const closure = Object.freeze({
            lockSha256: '0'.repeat(64),
            manifestDependencySha256: rootLock.manifestDependencySha256,
            toolchain: CURRENT_TOOLCHAIN,
            layers: Object.freeze(
                rootLock.packages.map((node) => {
                    const artifact = artifacts.get(node.canonicalIri);
                    if (artifact === undefined) {
                        throw new Error('missing graph artifact');
                    }
                    const bytes = new Map<string, Uint8Array>([
                        ['erden.config.json', new TextEncoder().encode(serializeManifestV1(artifact.manifest, 'json'))],
                        ['erden.lock', new TextEncoder().encode(serializeLockfile(artifact.lock))],
                        [
                            'ontology.ttl',
                            new TextEncoder().encode(
                                `@prefix graph: <${node.canonicalIri}#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\ngraph:Class a owl:Class .\n`,
                            ),
                        ],
                        ['.erden/package-manifest.json', artifact.encoded.manifestBytes],
                    ]);
                    byteMaps.set(node.canonicalIri, bytes);
                    return Object.freeze({
                        canonicalIri: node.canonicalIri,
                        version: node.version,
                        archiveSha256: node.archiveSha256,
                        identifiers: Object.freeze([node.canonicalIri]),
                        root: join(root, '.synthetic', node.archiveSha256),
                        files: Object.freeze(
                            [...bytes]
                                .map(([path, value]) =>
                                    Object.freeze({
                                        path,
                                        byteSize: value.byteLength,
                                        sha256: createHash('sha256').update(value).digest('hex'),
                                        logicalMode: 0o644 as const,
                                    }),
                                )
                                .sort((left, right) => left.path.localeCompare(right.path, 'en')),
                        ),
                    });
                }),
            ),
        });
        const reader: InstalledClosureReaderShape = Object.freeze({
            resolve: () => Effect.succeed(closure),
            readFile: ({ canonicalIri, path }: Parameters<InstalledClosureReaderShape['readFile']>[0]) => {
                const bytes = byteMaps.get(canonicalIri)?.get(path);
                const file = closure.layers
                    .find((layer) => layer.canonicalIri === canonicalIri)
                    ?.files.find((item) => item.path === path);
                if (bytes === undefined || file === undefined) {
                    return Effect.die(new Error('missing synthetic graph file'));
                }
                return Effect.succeed(Object.freeze({ ...file, bytes: Uint8Array.from(bytes) }));
            },
        });
        const failure = await Effect.runPromise(
            Effect.flip(
                makeCheckProjectService(
                    makeManifestService(),
                    makeOntologyService(makeNodeOntologyPorts()),
                    nodeReasonerService,
                    nodeProjectDependencyStateService,
                    nodeCurrentToolchainService,
                    reader,
                ).check({ from: root }),
            ),
        );
        expect(failure).toMatchObject({ stage: 'dependencies', code: 'CHECK_DEPENDENCY_EDGE_MISMATCH' });
    });

    it.each(['manifest-parse', 'manifest-ambiguity', 'source-io'] as const)(
        'returns portable typed diagnostics for %s failures',
        async (scenario) => {
            const root = makeTempRoot();
            if (scenario === 'manifest-parse') {
                writeFixtureFile(join(root, 'erden.config.json'), '{ invalid json');
            } else {
                const manifest = {
                    schemaVersion: 1,
                    canonicalIri: 'https://example.test/root',
                    alias: '@example/root',
                    ownedIriPrefixes: ['https://example.test/root#'],
                    sources: { ontology: ['missing.ttl'] },
                };
                writeFixtureFile(join(root, 'erden.config.json'), JSON.stringify(manifest));
                if (scenario === 'manifest-ambiguity') {
                    writeFixtureFile(join(root, 'erden.config.jsonc'), JSON.stringify(manifest));
                }
            }
            const failure = await Effect.runPromise(Effect.flip(nodeCheckService().check({ from: root })));
            expect(failure).toBeInstanceOf(CheckProjectOperationalError);
            if (scenario === 'manifest-parse') {
                expect(failure.code).toBe('CHECK_MANIFEST_INVALID');
            }
            if (scenario === 'manifest-ambiguity') {
                expect(failure.code).toBe('CHECK_MANIFEST_AMBIGUOUS');
            }
            const human = renderCheckProjectError(failure);
            expect(human).not.toContain(root);
            expect(JSON.stringify(failure)).not.toContain(root);
            expect(failure.diagnostics.every((item) => item.file === null || !item.file.includes('..'))).toBe(true);
        },
    );

    it.each([
        ['empty-root', 'CHECK_MANIFEST_UNAVAILABLE'],
        ['malformed-lock', 'CHECK_LOCK_INVALID'],
        ['active-transaction', 'CHECK_LOCK_INVALID'],
    ] as const)('classifies project dependency state %s precisely', async (scenario, expectedCode) => {
        const root = makeTempRoot();
        if (scenario !== 'empty-root') {
            const manifest = normalizeManifestV1({
                schemaVersion: 1,
                canonicalIri: 'https://example.test/state-classification',
                alias: '@example/state-classification',
                ownedIriPrefixes: ['https://example.test/state-classification#'],
                sources: { ontology: ['ontology.ttl'] },
            });
            writeFixtureFile(join(root, 'erden.config.json'), serializeManifestV1(manifest, 'json'));
            writeFileSync(join(root, 'ontology.ttl'), '<urn:s> <urn:p> <urn:o> .\n', 'utf8');
            if (scenario === 'malformed-lock') {
                writeFixtureFile(join(root, 'erden.lock'), 'not: canonical\n');
            } else {
                writeFixtureFile(join(root, '.erden.dependencies.transaction.json'), '{}\n');
            }
        }
        const failure = await Effect.runPromise(nodeCheckService().check({ from: root }).pipe(Effect.flip));
        expect(failure).toMatchObject({ code: expectedCode });
        expect(renderCheckProjectError(failure)).not.toContain(root);
    });
});
