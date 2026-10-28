import { resolve } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import {
    EVIDENCE,
    makeOntologyService,
    PROV,
    RequiredStageUnavailableError,
    ResourceAccessError,
    SHAPE_EXTENSIONS,
    TurtleSourceParseError,
    UnsupportedSemanticFormatError,
    parseCompetencyQuestionMetadata,
    type CitationFilePort,
    type GitFileState,
    type GitPort,
    type OntologyPorts,
    type ProjectSourceOwner,
    type ShapeSourceDescriptor,
    type TextResourcePort,
    type TurtleSourceDescriptor,
} from '../src/index.js';

const ROOT: ProjectSourceOwner = Object.freeze({
    canonicalIri: 'https://example.test/root',
    role: 'root',
    ownedIriPrefixes: ['https://example.test/root#'],
});

const DEPENDENCY: ProjectSourceOwner = Object.freeze({
    canonicalIri: 'https://example.test/dependency',
    role: 'dependency',
    ownedIriPrefixes: ['https://example.test/dependency#'],
});

const ASSERTED = Object.freeze({ _tag: 'Asserted' as const });

function inferred(premises: ReadonlyArray<string> = ['root.ttl#1']): TurtleSourceDescriptor['provenance'] {
    return {
        _tag: 'Inferred',
        reasoner: 'fixture-reasoner@1',
        operation: 'classify-and-materialize',
        statementId: 'inferred:fixture',
        rule: 'subclass-type',
        premises,
        justificationDigest: `sha256:${'1'.repeat(64)}`,
        contributingSourceIds: ['root.ttl'],
        contributingOwners: [ROOT],
        certificateDigest: `sha256:${'2'.repeat(64)}`,
    };
}

function source(
    id: string,
    locator: string,
    owner: ProjectSourceOwner = ROOT,
    provenance: TurtleSourceDescriptor['provenance'] = ASSERTED,
): TurtleSourceDescriptor {
    return {
        id,
        owner,
        locator,
        baseIri: owner.canonicalIri,
        mediaType: 'text/turtle',
        provenance,
    };
}

function shape(id: string, locator: string, owner: ProjectSourceOwner = ROOT): ShapeSourceDescriptor {
    return {
        id,
        owner,
        locator,
        baseIri: owner.canonicalIri,
        mediaType: 'text/turtle',
    };
}

interface MemoryResources {
    readonly resources: TextResourcePort;
    readonly reads: ReturnType<typeof vi.fn>;
}

function memoryResources(
    texts: Readonly<Record<string, string>>,
    listings: Readonly<Record<string, ReadonlyArray<string>>> = {},
): MemoryResources {
    const reads = vi.fn<(locator: string) => void>();
    const resources: TextResourcePort = {
        readBytes: (locator: string) => {
            const text = texts[locator];
            return text === undefined
                ? Effect.fail(new ResourceAccessError(locator, 'not present in the in-memory resource port'))
                : Effect.succeed(new TextEncoder().encode(text));
        },
        readText: (locator: string) => {
            reads(locator);
            const text = texts[locator];
            return text === undefined
                ? Effect.fail(new ResourceAccessError(locator, 'not present in the in-memory resource port'))
                : Effect.succeed(text);
        },
        listFiles: (locator: string) => {
            const files = listings[locator];
            return files === undefined
                ? Effect.fail(new ResourceAccessError(locator, 'directory unavailable'))
                : Effect.succeed(files);
        },
    };
    return { resources, reads };
}

function citationPort(existing: boolean): CitationFilePort {
    return {
        exists: () => Effect.succeed(existing),
    };
}

function ports(
    texts: Readonly<Record<string, string>>,
    listings: Readonly<Record<string, ReadonlyArray<string>>> = {},
    citationFiles: CitationFilePort = citationPort(true),
    git?: GitPort,
): OntologyPorts {
    const memory = memoryResources(texts, listings);
    return {
        resources: memory.resources,
        citationFiles,
        ...(git === undefined ? {} : { git }),
    };
}

const EX_PREFIXES = `
@prefix ex: <https://example.test/root#> .
@prefix dep: <https://example.test/dependency#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
`;

const SHAPE_PREFIXES = `${EX_PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix sx: <${SHAPE_EXTENSIONS}> .
`;

const greenOntology = `${EX_PREFIXES}
ex:Thing a owl:Class .
ex:item a ex:Thing .
ex:status a owl:ObjectProperty ; rdfs:domain ex:Thing ; rdfs:range ex:Thing .
`;

describe('ordered Turtle ingestion and provenance', () => {
    it('preserves caller order, isolates blank nodes, and retains every asserted/inferred contributor', async () => {
        const texts = {
            'b.ttl': `${EX_PREFIXES}
ex:item ex:shared ex:value .
ex:item ex:shared ex:value .
ex:b ex:blank [ ex:value ex:b ] .`,
            'a.ttl': `${EX_PREFIXES} ex:item ex:shared ex:value . ex:a ex:blank [ ex:value ex:a ] .`,
            'inferred.ttl': `${EX_PREFIXES} ex:item ex:shared ex:value .`,
        };
        const service = makeOntologyService(ports(texts));
        const graph = await Effect.runPromise(
            service.assemble([
                source('b', 'b.ttl'),
                source('a', 'a.ttl'),
                source('inferred', 'inferred.ttl', DEPENDENCY, inferred()),
            ]),
        );

        expect(graph.sources.map(({ descriptor }) => descriptor.id)).toEqual(['b', 'a', 'inferred']);
        expect(
            graph.dataset
                .getQuads(null, null, null, null)
                .filter((quad) => quad.subject.termType === 'BlankNode')
                .map((quad) => quad.subject.value),
        ).toHaveLength(2);
        const shared = graph.provenance.find((entry) => entry.quad.predicate.value.endsWith('#shared'));
        expect(shared?.asserted.map(({ sourceId }) => sourceId)).toEqual(['b', 'a']);
        expect(shared?.inferred.map(({ sourceId }) => sourceId)).toEqual(['inferred']);
        expect(shared?.inferred[0]?.provenance).toMatchObject({
            _tag: 'Inferred',
            reasoner: 'fixture-reasoner@1',
            premises: ['root.ttl#1'],
        });
    });

    it('sorts filesystem enumeration within each ordered selector deterministically', async () => {
        const memory = memoryResources(
            {
                'd/z.ttl': greenOntology,
                'd/a.ttl': greenOntology,
                'first.ttl': greenOntology,
            },
            {
                d: ['d/z.ttl', 'd/readme.md', 'd/a.ttl'],
            },
        );
        const service = makeOntologyService({
            resources: memory.resources,
            citationFiles: citationPort(true),
        });
        const discovered = await Effect.runPromise(
            service.discoverDataSources([
                {
                    idPrefix: 'first',
                    owner: ROOT,
                    selector: { kind: 'file', locator: 'first.ttl' },
                    baseIri: ROOT.canonicalIri,
                    provenance: ASSERTED,
                },
                {
                    idPrefix: 'dir',
                    owner: ROOT,
                    selector: { kind: 'directory', locator: 'd' },
                    baseIri: ROOT.canonicalIri,
                    provenance: ASSERTED,
                },
            ]),
        );
        expect(discovered.map(({ locator }) => locator)).toEqual(['first.ttl', 'd/a.ttl', 'd/z.ttl']);
    });

    it('produces the same discovered order when the port enumerates differently on repeats', async () => {
        let reverse = false;
        const texts = { 'd/a.ttl': greenOntology, 'd/z.ttl': greenOntology };
        const resources: TextResourcePort = {
            readBytes: (locator) => Effect.succeed(new TextEncoder().encode(texts[locator as keyof typeof texts])),
            readText: (locator) => Effect.succeed(texts[locator as keyof typeof texts]),
            listFiles: () => {
                reverse = !reverse;
                return Effect.succeed(reverse ? ['d/z.ttl', 'd/a.ttl'] : ['d/a.ttl', 'd/z.ttl']);
            },
        };
        const service = makeOntologyService({ resources, citationFiles: citationPort(true) });
        const locations = [
            {
                idPrefix: 'dir',
                owner: ROOT,
                selector: { kind: 'directory' as const, locator: 'd' },
                baseIri: ROOT.canonicalIri,
                provenance: ASSERTED,
            },
        ];
        const first = await Effect.runPromise(service.discoverDataSources(locations));
        const second = await Effect.runPromise(service.discoverDataSources(locations));
        expect(first).toEqual(second);
        expect(first.map(({ locator }) => locator)).toEqual(['d/a.ttl', 'd/z.ttl']);
    });

    it('returns a typed malformed-Turtle error with file, line, and column', async () => {
        const service = makeOntologyService(
            ports({
                'bad.ttl': '@prefix ex: <https://example.test/root#> .\nex:a ex:p [ .',
            }),
        );
        const failure = await Effect.runPromise(Effect.flip(service.assemble([source('bad', 'bad.ttl')])));
        expect(failure).toBeInstanceOf(TurtleSourceParseError);
        expect(failure).toMatchObject({
            sourceId: 'bad',
            location: { file: 'bad.ttl', line: 2, column: 13 },
        });
    });
});

describe('competency-question discovery and root execution', () => {
    function question(expectation: string, query: string, extra = ''): string {
        return `# @ask     What is present?
# @expect  ${expectation}
# @from    A concrete missing-answer incident that this question preserves.
${extra}${query}`;
    }

    it('sorts .rq files, preserves metadata, executes root CQs, and keeps dependency CQs dormant', async () => {
        const texts = {
            'root.ttl': `${EX_PREFIXES} ex:item ex:status ex:value .`,
            'root/b.rq': question(
                'rows == 0',
                'PREFIX ex: <https://example.test/root#> SELECT ?s WHERE { ?s ex:absent ex:value }',
            ),
            'root/a.rq': question(
                'rows >= 1',
                'PREFIX ex: <https://example.test/root#> SELECT ?s WHERE { ?s ex:status ex:value }',
            ),
            'dependency/z.rq': question('rows == 999', 'THIS IS NOT VALID SPARQL'),
        };
        const service = makeOntologyService(
            ports(texts, {
                root: ['root/b.rq', 'root/ignore.txt', 'root/a.rq'],
                dependency: ['dependency/z.rq'],
            }),
        );
        const questions = await Effect.runPromise(
            service.discoverCompetencyQuestions(
                [
                    { idPrefix: 'root', owner: ROOT, selector: { kind: 'directory', locator: 'root' } },
                    { idPrefix: 'dep', owner: DEPENDENCY, selector: { kind: 'directory', locator: 'dependency' } },
                ],
                true,
            ),
        );
        expect(questions.map(({ locator }) => locator)).toEqual(['root/a.rq', 'root/b.rq', 'dependency/z.rq']);
        expect(questions[0]?.metadata).toMatchObject({
            ask: 'What is present?',
            expect: 'rows >= 1',
            from: 'A concrete missing-answer incident that this question preserves.',
        });
        expect(questions[0]?.diagnostics).toEqual([]);

        const graph = await Effect.runPromise(service.assemble([source('root', 'root.ttl')]));
        const validation = await Effect.runPromise(service.competencyQuestions(graph, questions));
        expect(validation).toMatchObject({ conforms: true, executed: 2, dormant: 1 });
        expect(validation.questions.map(({ execution }) => execution)).toEqual([
            'executed',
            'executed',
            'dormant-dependency',
        ]);
        expect(validation.questions[2]).toMatchObject({ rows: null, ok: null, blocking: false });
    });

    it('returns deterministic metadata diagnostics and enforces expected-failure documentation', async () => {
        expect(
            parseCompetencyQuestionMetadata(`# @expect nope
# @status EXPECTED TO FAIL
SELECT * WHERE { ?s ?p ?o }`).diagnostics.map(({ code }) => code),
        ).toEqual(['missing-ask', 'invalid-expectation', 'missing-from', 'missing-closes']);

        const texts = {
            'root.ttl': greenOntology,
            'documented.rq': question(
                'rows >= 1',
                'SELECT ?s WHERE { ?s <https://example.test/root#absent> ?o }',
                '# @status EXPECTED TO FAIL\n# @closes  https://example.test/issues/1\n',
            ),
            'orphan.rq': question(
                'rows >= 1',
                'SELECT ?s WHERE { ?s <https://example.test/root#absent> ?o }',
                '# @status EXPECTED TO FAIL\n',
            ),
        };
        const service = makeOntologyService(ports(texts));
        const questions = await Effect.runPromise(
            service.discoverCompetencyQuestions(
                [
                    { idPrefix: 'documented', owner: ROOT, selector: { kind: 'file', locator: 'documented.rq' } },
                    { idPrefix: 'orphan', owner: ROOT, selector: { kind: 'file', locator: 'orphan.rq' } },
                ],
                true,
            ),
        );
        const graph = await Effect.runPromise(service.assemble([source('root', 'root.ttl')]));
        const validation = await Effect.runPromise(service.competencyQuestions(graph, questions));
        expect(validation.questions[0]).toMatchObject({
            expectedToFail: true,
            ok: false,
            blocking: false,
        });
        expect(validation.questions[1]).toMatchObject({
            expectedToFail: true,
            ok: false,
            blocking: true,
            metadataDiagnostics: [{ code: 'missing-closes' }],
        });
        expect(validation.conforms).toBe(false);
    });
});

describe('borrowed terms and property schema checks', () => {
    it('passes declared borrowed terms and complete property domains/ranges', async () => {
        const text = `${EX_PREFIXES}
@prefix ext: <https://external.test/vocab#> .
ext:related a owl:ObjectProperty .
ex:Thing a owl:Class .
ex:related a owl:ObjectProperty ; rdfs:domain ex:Thing ; rdfs:range ex:Thing .
ex:a ext:related ex:b .`;
        const service = makeOntologyService(ports({ 'good.ttl': text }));
        const report = await Effect.runPromise(
            service.check({
                dataSources: [source('good', 'good.ttl')],
                shapeSources: [],
                competencyQuestions: [],
                shacl: { required: false },
                cq: { required: false },
            }),
        );
        expect(report.borrowedTerms).toMatchObject({ conforms: true, missing: [] });
        expect(report.propertyDomainRange).toMatchObject({ conforms: true, findings: [] });
    });

    it('reports undeclared borrowed terms and each missing domain/range combination deterministically', async () => {
        const text = `${EX_PREFIXES}
@prefix ext: <https://external.test/vocab#> .
ex:Thing a owl:Class .
ex:a ext:related ex:b .
ex:both a owl:ObjectProperty .
ex:domainOnly a owl:ObjectProperty ; rdfs:domain ex:Thing .
ex:rangeOnly a owl:DatatypeProperty ; rdfs:range ex:Thing .`;
        const service = makeOntologyService(ports({ 'bad.ttl': text }));
        const report = await Effect.runPromise(
            service.check({
                dataSources: [source('bad', 'bad.ttl')],
                shapeSources: [],
                competencyQuestions: [],
                shacl: { required: false },
                cq: { required: false },
            }),
        );
        expect(report.borrowedTerms.missing).toEqual(['https://external.test/vocab#related']);
        expect(report.propertyDomainRange.findings).toEqual([
            { property: 'https://example.test/root#both', missing: 'domain+range' },
            { property: 'https://example.test/root#domainOnly', missing: 'range' },
            { property: 'https://example.test/root#rangeOnly', missing: 'domain' },
        ]);
        expect(report.conforms).toBe(false);
    });
});

describe('complete-closure SHACL and self-testing', () => {
    it('locates malformed shape Turtle at its source line and column', async () => {
        const service = makeOntologyService(
            ports({
                'root.ttl': greenOntology,
                'bad-shape.ttl': '@prefix sh: <http://www.w3.org/ns/shacl#> .\n<urn:bad> a sh:NodeShape ; [ .',
            }),
        );
        const graph = await Effect.runPromise(service.assemble([source('root', 'root.ttl')]));
        const failure = await Effect.runPromise(
            Effect.flip(service.shacl(graph, [shape('bad-shape', 'bad-shape.ttl')], true)),
        );
        expect(failure).toBeInstanceOf(TurtleSourceParseError);
        expect(failure).toMatchObject({
            sourceId: 'bad-shape',
            location: { file: 'bad-shape.ttl', line: 2 },
        });
        if (!(failure instanceof TurtleSourceParseError)) {
            throw new Error('Expected shape parse error');
        }
        expect(failure.location.column).toBeGreaterThan(1);
    });

    it('uses an inferred dependency fact in a root shape', async () => {
        const rootShape = `${SHAPE_PREFIXES}
ex:ReadyShape a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property [
  sh:path ex:status ; sh:hasValue dep:Ready ; sh:message "status must be inferred"
] .`;
        const dependencyShape = `${SHAPE_PREFIXES}
dep:ReadyClosureShape a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property [
  sh:path ex:status ; sh:hasValue dep:Ready ; sh:message "dependency also requires inferred status"
] .`;
        const texts = {
            'root.ttl': greenOntology,
            'inferred.ttl': `${EX_PREFIXES} ex:item ex:status dep:Ready .`,
            'root-shapes.ttl': rootShape,
            'dependency-shapes.ttl': dependencyShape,
        };
        const service = makeOntologyService(ports(texts));
        const explicit = await Effect.runPromise(service.assemble([source('root', 'root.ttl')]));
        const before = await Effect.runPromise(
            service.shacl(
                explicit,
                [
                    shape('root-shape', 'root-shapes.ttl'),
                    shape('dependency-shape', 'dependency-shapes.ttl', DEPENDENCY),
                ],
                true,
            ),
        );
        expect(before?.counts.violation).toBe(2);

        const complete = await Effect.runPromise(
            service.assemble([
                source('root', 'root.ttl'),
                source('reasoned-dependency', 'inferred.ttl', DEPENDENCY, inferred()),
            ]),
        );
        const after = await Effect.runPromise(
            service.shacl(
                complete,
                [
                    shape('root-shape', 'root-shapes.ttl'),
                    shape('dependency-shape', 'dependency-shapes.ttl', DEPENDENCY),
                ],
                true,
            ),
        );
        expect(after).toMatchObject({ conforms: true, counts: { violation: 0 } });
        expect(after?.shapes.flatMap(({ owners }) => owners.map(({ role }) => role))).toEqual(['dependency', 'root']);
    });

    it('lets a dependency shape block the consumer and reports dependency ownership', async () => {
        const dependencyShape = `${SHAPE_PREFIXES}
dep:ConsumerConstraint a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property [
  sh:path ex:required ; sh:minCount 1 ; sh:message "consumer requirement missing"
] .`;
        const service = makeOntologyService(
            ports({
                'root.ttl': greenOntology,
                'dependency-shapes.ttl': dependencyShape,
            }),
        );
        const graph = await Effect.runPromise(service.assemble([source('root', 'root.ttl')]));
        const result = await Effect.runPromise(
            service.shacl(graph, [shape('dependency-shape', 'dependency-shapes.ttl', DEPENDENCY)], true),
        );
        expect(result?.conforms).toBe(false);
        expect(result?.findings[0]).toMatchObject({
            severity: 'Violation',
            shape: 'https://example.test/dependency#ConsumerConstraint',
            shapeSourceIds: ['dependency-shape'],
        });
        expect(result?.findings[0]?.shapeOwners.map(({ role }) => role)).toEqual(['dependency']);
    });

    it('keeps warnings nonblocking and proves every shape can fail, including maxCount fixtures', async () => {
        const warningShapes = `${SHAPE_PREFIXES}
ex:WarningShape a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property [
  sh:path ex:optional ; sh:minCount 1 ; sh:severity sh:Warning ; sh:message "designed warning"
] .
ex:SingleStatusShape a sh:NodeShape ; sh:targetClass ex:Thing ;
  sx:selftestFixture """t:bad ex:status ex:first, ex:second .""" ;
  sh:property [ sh:path ex:status ; sh:maxCount 1 ; sh:message "too many statuses" ] .`;
        const service = makeOntologyService(
            ports({
                'root.ttl': greenOntology,
                'warning-shapes.ttl': warningShapes,
            }),
        );
        const graph = await Effect.runPromise(service.assemble([source('root', 'root.ttl')]));
        const result = await Effect.runPromise(
            service.shacl(graph, [shape('warning-shapes', 'warning-shapes.ttl')], true),
        );
        expect(result).toMatchObject({
            conforms: true,
            counts: { violation: 0, warning: 1 },
        });
        expect(result?.selfTest).toHaveLength(2);
        expect(result?.selfTest.every(({ fired }) => fired)).toBe(true);
    });

    it('uses each declaring source prefix map when root and dependency shapes reuse a prefix', async () => {
        function collidingShape(namespace: string, shapeName: string): string {
            return `
@prefix ex: <${namespace}> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix sx: <${SHAPE_EXTENSIONS}> .
ex:${shapeName} a sh:NodeShape ; sh:targetClass ex:Thing ;
  sx:selftestFixture """t:bad ex:property ex:first, ex:second .""" ;
  sh:property [ sh:path ex:property ; sh:maxCount 1 ; sh:message "too many values" ] .`;
        }
        const service = makeOntologyService(
            ports({
                'root.ttl': `${EX_PREFIXES} ex:item a ex:Thing . dep:item a dep:Thing .`,
                'root-collision.ttl': collidingShape('https://example.test/root#', 'RootShape'),
                'dependency-collision.ttl': collidingShape('https://example.test/dependency#', 'DependencyShape'),
            }),
        );
        const graph = await Effect.runPromise(service.assemble([source('root', 'root.ttl')]));
        const result = await Effect.runPromise(
            service.shacl(
                graph,
                [
                    shape('root-collision', 'root-collision.ttl'),
                    shape('dependency-collision', 'dependency-collision.ttl', DEPENDENCY),
                ],
                true,
            ),
        );
        expect(result?.selfTest).toEqual([
            { shape: 'https://example.test/dependency#DependencyShape', fired: true, reason: null },
            { shape: 'https://example.test/root#RootShape', fired: true, reason: null },
        ]);
        expect(result?.conforms).toBe(true);
    });

    it('self-tests, attributes, and summarizes a standalone targeted PropertyShape', async () => {
        const standalonePropertyShape = `${SHAPE_PREFIXES}
dep:StandalonePropertyShape a sh:PropertyShape ;
  sh:targetSubjectsOf ex:trigger ;
  sh:path ex:required ;
  sh:minCount 1 ;
  sh:message "triggered subjects require ex:required" .`;
        const service = makeOntologyService(
            ports({
                'root.ttl': `${greenOntology} ex:item ex:trigger ex:value .`,
                'standalone-property-shape.ttl': standalonePropertyShape,
            }),
        );
        const graph = await Effect.runPromise(service.assemble([source('root', 'root.ttl')]));
        const result = await Effect.runPromise(
            service.shacl(graph, [shape('standalone-property', 'standalone-property-shape.ttl', DEPENDENCY)], true),
        );
        expect(result?.selfTest).toEqual([
            {
                shape: 'https://example.test/dependency#StandalonePropertyShape',
                fired: true,
                reason: null,
            },
        ]);
        expect(result?.shapes).toEqual([
            expect.objectContaining({
                shape: 'https://example.test/dependency#StandalonePropertyShape',
                targetKind: 'targetSubjectsOf',
                targetTerm: 'https://example.test/root#trigger',
                targetCount: 1,
                resultCount: 1,
                sourceIds: ['standalone-property'],
                owners: [DEPENDENCY],
            }),
        ]);
        expect(result?.findings).toEqual([
            expect.objectContaining({
                shape: 'https://example.test/dependency#StandalonePropertyShape',
                shapeSourceIds: ['standalone-property'],
                shapeOwners: [DEPENDENCY],
                severity: 'Violation',
            }),
        ]);
        expect(result?.conforms).toBe(false);
    });

    it('fails closed when an individual NodeShape is inert', async () => {
        const inertShape = `${SHAPE_PREFIXES}
ex:InertShape a sh:NodeShape ; sh:message "has no target and no fixture" .`;
        const service = makeOntologyService(
            ports({
                'root.ttl': greenOntology,
                'inert-shape.ttl': inertShape,
            }),
        );
        const graph = await Effect.runPromise(service.assemble([source('root', 'root.ttl')]));
        const result = await Effect.runPromise(service.shacl(graph, [shape('inert', 'inert-shape.ttl')], true));
        expect(result?.selfTest).toEqual([
            {
                shape: 'https://example.test/root#InertShape',
                fired: false,
                reason: 'no SHACL Core target and no self-test fixture',
            },
        ]);
        expect(result?.conforms).toBe(false);
    });

    it('integrates root/dependency shapes and root-only CQs through service.check', async () => {
        function closureShape(iri: string): string {
            return `${SHAPE_PREFIXES}
<${iri}> a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property [
  sh:path ex:status ; sh:minCount 1 ; sh:message "closure status required"
] .`;
        }
        const rootQuestion = `# @ask     Does the complete closure contain status?
# @expect  rows >= 1
# @from    A consumer check once ignored inferred dependency facts.
PREFIX ex: <https://example.test/root#>
SELECT ?s WHERE { ?s ex:status ?status }`;
        const texts = {
            'root.ttl': greenOntology,
            'inferred.ttl': `${EX_PREFIXES} ex:item ex:status dep:Ready .`,
            'root-shape.ttl': closureShape('https://example.test/root#RootClosureShape'),
            'dep-shape.ttl': closureShape('https://example.test/dependency#DependencyClosureShape'),
            'root.rq': rootQuestion,
            'dep.rq': 'THIS DEPENDENCY QUERY MUST NEVER EXECUTE',
        };
        const service = makeOntologyService(ports(texts));
        const questions = await Effect.runPromise(
            service.discoverCompetencyQuestions(
                [
                    { idPrefix: 'root-cq', owner: ROOT, selector: { kind: 'file', locator: 'root.rq' } },
                    { idPrefix: 'dep-cq', owner: DEPENDENCY, selector: { kind: 'file', locator: 'dep.rq' } },
                ],
                true,
            ),
        );
        const report = await Effect.runPromise(
            service.check({
                dataSources: [source('root', 'root.ttl'), source('inferred', 'inferred.ttl', DEPENDENCY, inferred())],
                shapeSources: [shape('root-shape', 'root-shape.ttl'), shape('dep-shape', 'dep-shape.ttl', DEPENDENCY)],
                competencyQuestions: questions,
                shacl: { required: true },
                cq: { required: true },
            }),
        );
        expect(report.conforms).toBe(true);
        expect(report.shacl?.shapes).toHaveLength(2);
        expect(report.competencyQuestions).toMatchObject({
            conforms: true,
            executed: 1,
            dormant: 1,
        });
    });
});

describe('citation paths and optional Git staleness', () => {
    const citationOntology = `${EX_PREFIXES}
@prefix ev: <${EVIDENCE}> .
@prefix prov: <${PROV}> .
ev:observation ev:sourcePath "src/a.ts" ; ev:sourceRoot "default" ;
  ev:atCommit "abc123" ; ev:inRepository "example/repository" .
ex:item prov:wasGeneratedBy ev:observation .`;

    async function validateWith(fileExists: boolean, git?: GitPort) {
        const service = makeOntologyService(
            ports({ 'citation.ttl': citationOntology }, {}, citationPort(fileExists), git),
        );
        const graph = await Effect.runPromise(service.assemble([source('citation', 'citation.ttl')]));
        return Effect.runPromise(service.citations(graph, { default: resolve('fixture-repository') }));
    }

    function fakeGit(state: GitFileState): GitPort {
        return {
            inspect: () => Effect.succeed({ state, repositoryRoot: resolve('fixture-repository') }),
        };
    }

    it('passes a present citation when Git is absent because Git is optional', async () => {
        const result = await validateWith(true);
        expect(result).toMatchObject({ conforms: true, warnings: 0 });
        expect(result.citations[0]).toMatchObject({ status: 'git-unavailable', blocking: false });
    });

    it('blocks a missing citation path', async () => {
        const result = await validateWith(false);
        expect(result.citations[0]).toMatchObject({ status: 'missing-source-path', blocking: true });
        expect(result.conforms).toBe(false);
    });

    it.each(['../secret.txt', '/etc/passwd', 'C:\\secret.txt', 'C:secret.txt', 'src/../secret.txt', 'src\\secret.txt'])(
        'blocks invalid citation source path %s before filesystem or Git access',
        async (sourcePath) => {
            const exists = vi.fn(() => Effect.succeed(true));
            const inspect = vi.fn(() => Effect.succeed({ state: 'unchanged' as const }));
            const text = `${EX_PREFIXES}
@prefix ev: <${EVIDENCE}> .
ev:observation ev:sourcePath ${JSON.stringify(sourcePath)} ; ev:sourceRoot "default" .`;
            const service = makeOntologyService(ports({ 'invalid-citation.ttl': text }, {}, { exists }, { inspect }));
            const graph = await Effect.runPromise(
                service.assemble([source('invalid-citation', 'invalid-citation.ttl')]),
            );
            const result = await Effect.runPromise(
                service.citations(graph, { default: resolve('fixture-repository') }),
            );
            expect(result).toMatchObject({ conforms: false });
            expect(result.citations[0]).toMatchObject({ status: 'unsafe-source-path', blocking: true });
            expect(exists).not.toHaveBeenCalled();
            expect(inspect).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['unchanged', true, false, false],
        ['changed-since', true, true, false],
        ['commit-not-in-repo', false, false, true],
    ] as const)('classifies Git state %s', async (state, conforms, warning, blocking) => {
        const result = await validateWith(true, fakeGit(state));
        expect(result.conforms).toBe(conforms);
        expect(result.citations[0]).toMatchObject({ status: state, warning, blocking });
    });

    it.each([
        ['sourceRoot', 'ev:sourceRoot "a", "b"'],
        ['commit', 'ev:atCommit "a", "b"'],
        ['repository', 'ev:inRepository "a", "b"'],
        ['observation label', 'rdfs:label "a", "b"'],
        [
            'affected fact label',
            'rdfs:label "observation" . ex:item prov:wasGeneratedBy ev:observation ; rdfs:label "a", "b"',
        ],
    ] as const)(
        'reports and sorts ambiguous singular citation %s values as blocking semantics',
        async (_label, statement) => {
            function makeText(reverse: boolean) {
                return `${EX_PREFIXES}
@prefix ev: <${EVIDENCE}> .
@prefix prov: <${PROV}> .
ev:observation ev:sourcePath "src/a.ts" ; ${reverse ? statement.replace('"a", "b"', '"b", "a"') : statement} .`;
            }
            const results = [];
            for (const [index, reverse] of [false, true].entries()) {
                const locator = `ambiguous-${String(index)}.ttl`;
                const service = makeOntologyService(ports({ [locator]: makeText(reverse) }));
                const graph = await Effect.runPromise(
                    service.assemble([source(`ambiguous-${String(index)}`, locator)]),
                );
                results.push(await Effect.runPromise(service.citations(graph, {})));
            }
            expect(results[0]).toMatchObject({ conforms: false });
            expect(results[0]?.citations[0]).toMatchObject({
                status: 'ambiguous-metadata',
                blocking: true,
                metadataDiagnostics: [expect.objectContaining({ values: ['a', 'b'] })],
            });
            expect(results[1]?.citations[0]?.metadataDiagnostics).toEqual(
                results[0]?.citations[0]?.metadataDiagnostics,
            );
        },
    );
});

describe('fail-closed required stages', () => {
    it.each([
        ['source', 'bad.nq'],
        ['competency-questions', 'bad.sparql'],
    ] as const)('rejects unsupported %s semantic formats', async (stage, locator) => {
        const service = makeOntologyService(ports({ [locator]: 'content' }));
        const failure =
            stage === 'source'
                ? await Effect.runPromise(
                      Effect.flip(
                          service.discoverDataSources([
                              {
                                  idPrefix: 'bad',
                                  owner: ROOT,
                                  selector: { kind: 'file', locator },
                                  baseIri: ROOT.canonicalIri,
                                  provenance: ASSERTED,
                              },
                          ]),
                      ),
                  )
                : await Effect.runPromise(
                      Effect.flip(
                          service.discoverCompetencyQuestions(
                              [
                                  {
                                      idPrefix: 'bad',
                                      owner: ROOT,
                                      selector: { kind: 'file', locator },
                                  },
                              ],
                              true,
                          ),
                      ),
                  );
        expect(failure).toBeInstanceOf(UnsupportedSemanticFormatError);
        expect(failure).toMatchObject({ stage, locator });
    });

    it.each([
        ['source', 'source'],
        ['shacl', 'shacl'],
        ['competency-questions', 'competency-questions'],
    ] as const)('returns typed %s unavailability and never a skipped result', async (scenario, stage) => {
        const service = makeOntologyService(ports({ 'root.ttl': greenOntology }));
        const input =
            scenario === 'source'
                ? {
                      dataSources: [],
                      shapeSources: [],
                      competencyQuestions: [],
                      shacl: { required: false },
                      cq: { required: false },
                  }
                : scenario === 'shacl'
                  ? {
                        dataSources: [source('root', 'root.ttl')],
                        shapeSources: [],
                        competencyQuestions: [],
                        shacl: { required: true },
                        cq: { required: false },
                    }
                  : {
                        dataSources: [source('root', 'root.ttl')],
                        shapeSources: [],
                        competencyQuestions: [],
                        shacl: { required: false },
                        cq: { required: true },
                    };
        const failure = await Effect.runPromise(Effect.flip(service.check(input)));
        expect(failure).toBeInstanceOf(RequiredStageUnavailableError);
        expect(failure).toMatchObject({ stage });
        expect(JSON.stringify(failure)).not.toContain('skipped');
    });

    it('maps an unavailable source port to the same typed fail-closed contract', async () => {
        const service = makeOntologyService(ports({}));
        const failure = await Effect.runPromise(Effect.flip(service.assemble([source('missing', 'missing.ttl')])));
        expect(failure).toMatchObject({
            code: 'REQUIRED_STAGE_UNAVAILABLE',
            stage: 'source',
            locator: 'missing.ttl',
        });
    });

    it('maps unreadable required SHACL and CQ resources to typed stage failures', async () => {
        const service = makeOntologyService(ports({ 'root.ttl': greenOntology }));
        const graph = await Effect.runPromise(service.assemble([source('root', 'root.ttl')]));
        const shaclFailure = await Effect.runPromise(
            Effect.flip(service.shacl(graph, [shape('missing-shape', 'missing-shape.ttl')], true)),
        );
        const cqFailure = await Effect.runPromise(
            Effect.flip(
                service.discoverCompetencyQuestions(
                    [{ idPrefix: 'missing-cq', owner: ROOT, selector: { kind: 'file', locator: 'missing.rq' } }],
                    true,
                ),
            ),
        );
        expect(shaclFailure).toMatchObject({ code: 'REQUIRED_STAGE_UNAVAILABLE', stage: 'shacl' });
        expect(cqFailure).toMatchObject({
            code: 'REQUIRED_STAGE_UNAVAILABLE',
            stage: 'competency-questions',
        });
    });

    it('does not count dormant dependency CQs as an available required root CQ stage', async () => {
        const dependencyQuestion = `# @ask     Dependency-only question
# @expect  rows == 0
# @from    A dependency-local concern.
SELECT ?s WHERE { ?s ?p ?o }`;
        const service = makeOntologyService(
            ports({
                'root.ttl': greenOntology,
                'dependency.rq': dependencyQuestion,
            }),
        );
        const questions = await Effect.runPromise(
            service.discoverCompetencyQuestions(
                [
                    {
                        idPrefix: 'dependency',
                        owner: DEPENDENCY,
                        selector: { kind: 'file', locator: 'dependency.rq' },
                    },
                ],
                true,
            ),
        );
        const failure = await Effect.runPromise(
            Effect.flip(
                service.check({
                    dataSources: [source('root', 'root.ttl')],
                    shapeSources: [],
                    competencyQuestions: questions,
                    shacl: { required: false },
                    cq: { required: true },
                }),
            ),
        );
        expect(failure).toMatchObject({
            code: 'REQUIRED_STAGE_UNAVAILABLE',
            stage: 'competency-questions',
        });

        const graph = await Effect.runPromise(service.assemble([source('root', 'root.ttl')]));
        const optional = await Effect.runPromise(service.competencyQuestions(graph, questions));
        expect(optional).toMatchObject({ conforms: true, executed: 0, dormant: 1 });
    });
});
