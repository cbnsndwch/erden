import { Effect } from 'effect';
import { DataFactory, Parser, type Quad } from 'n3';
import { describe, expect, it } from 'vitest';

import { resolveBundledShaclEngine } from '@erden/shacl-distribution';

import {
    ResourceAccessError,
    SHACL_ENGINE,
    encodeShaclRequest,
    makeOntologyService,
    prepareShaclShapes,
    runShaclRequest,
    shaclEngineTool,
    type OntologyPorts,
    type ProjectSourceOwner,
    type ShapeSourceDescriptor,
    type TextResourcePort,
    type UnsupportedShaclConstructKind,
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

const PREFIXES = `@prefix ex: <https://example.test/root#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;
const SH = 'http://www.w3.org/ns/shacl#';
const EX = 'https://example.test/root#';

/** ex:item is an ex:Thing with one ex:p value and no ex:q value; only RDFS entailment makes it an ex:Super. */
const DATA = `${PREFIXES}
ex:Thing a owl:Class .
ex:item a ex:Thing ; ex:p ex:other .
ex:p a owl:ObjectProperty ; rdfs:domain ex:Super ; rdfs:range ex:Thing .
`;

/** Each construct the scan refuses, as a shapes graph the data breaks or that the engine cannot load. */
const CASES: ReadonlyArray<{
    readonly kind: UnsupportedShaclConstructKind;
    readonly name: string;
    readonly shapes: string;
    /** The text whose first character the refusal must point to. */
    readonly at: string;
    readonly shape: string | null;
    readonly construct: string;
    /** What erden-shacl does with it when run directly: refuses it, or validates it (the data breaks it). */
    readonly engine: { readonly refused: string } | { readonly conforms: false };
}> = [
    {
        kind: 'sparql-constraint',
        name: 'a SHACL-SPARQL constraint',
        shapes: `ex:S a sh:NodeShape ; sh:targetClass ex:Thing ;
  sh:sparql [ sh:select "SELECT $this WHERE { $this <${EX}p> ?v }" ] .`,
        at: 'sh:sparql',
        shape: `${EX}S`,
        construct: `${SH}SPARQLConstraintComponent`,
        engine: { conforms: false },
    },
    {
        kind: 'sparql-constraint',
        name: 'a SHACL-SPARQL constraint in an anonymous property shape',
        shapes: `ex:S a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property [ sh:path ex:p ;
  sh:sparql [ sh:select "SELECT $this ?value WHERE { $this $PATH ?value }" ] ] .`,
        at: 'sh:sparql',
        shape: `${EX}S`,
        construct: `${SH}SPARQLConstraintComponent`,
        engine: { conforms: false },
    },
    {
        kind: 'js-constraint',
        name: 'a SHACL-JS constraint',
        shapes: `ex:S a sh:NodeShape ; sh:targetClass ex:Thing ;
  sh:js [ a sh:JSConstraint ; sh:jsFunctionName "fail" ; sh:jsLibrary [ sh:jsLibraryURL "urn:x" ] ] .`,
        at: 'sh:js ',
        shape: `${EX}S`,
        construct: `${SH}JSConstraintComponent`,
        engine: { refused: 'unsupported-shacl-js' },
    },
    {
        kind: 'expression-constraint',
        name: 'a SHACL-AF node expression constraint',
        shapes: `ex:S a sh:NodeShape ; sh:targetClass ex:Thing ;
  sh:expression [ sh:path ex:q ] .`,
        at: 'sh:expression',
        shape: `${EX}S`,
        construct: `${SH}ExpressionConstraintComponent`,
        engine: { conforms: false },
    },
    {
        kind: 'custom-target',
        name: 'a SHACL-SPARQL target',
        shapes: `ex:S a sh:NodeShape ;
  sh:target [ a sh:SPARQLTarget ; sh:select "SELECT ?this WHERE { ?this a <${EX}Thing> }" ] ;
  sh:property [ sh:path ex:q ; sh:minCount 1 ] .`,
        at: 'sh:target',
        shape: `${EX}S`,
        construct: `${SH}SPARQLTarget`,
        engine: { conforms: false },
    },
    {
        kind: 'custom-target',
        name: 'a SPARQL-based target type',
        shapes: `ex:InstancesOf a sh:SPARQLTargetType ; rdfs:subClassOf sh:Target ;
  sh:parameter [ sh:path ex:type ] ; sh:select "SELECT ?this WHERE { ?this a $type }" .
ex:S a sh:NodeShape ;
  sh:target [ a ex:InstancesOf ; ex:type ex:Thing ] ;
  sh:property [ sh:path ex:q ; sh:minCount 1 ] .`,
        at: 'sh:target',
        shape: `${EX}S`,
        construct: `${EX}InstancesOf`,
        engine: { conforms: false },
    },
    {
        kind: 'constraint-component',
        name: 'a constraint component with a SPARQL ASK validator',
        shapes: `ex:NoP a sh:ConstraintComponent ; sh:parameter [ sh:path ex:forbidden ] ;
  sh:validator [ a sh:SPARQLAskValidator ; sh:ask "ASK { FILTER NOT EXISTS { $this $forbidden ?any } }" ] .
ex:S a sh:NodeShape ; sh:targetClass ex:Thing ;
  ex:forbidden ex:p .`,
        at: 'ex:forbidden ex:p',
        shape: `${EX}S`,
        construct: `${EX}NoP`,
        engine: { conforms: false },
    },
    {
        kind: 'constraint-component',
        name: 'a constraint component with a SPARQL SELECT node validator',
        shapes: `ex:NoP a sh:ConstraintComponent ; sh:parameter [ sh:path ex:forbidden ] ;
  sh:nodeValidator [ a sh:SPARQLSelectValidator ; sh:select "SELECT $this WHERE { $this $forbidden ?any }" ] .
ex:S a sh:NodeShape ; sh:targetClass ex:Thing ;
  ex:forbidden ex:p .`,
        at: 'ex:forbidden ex:p',
        shape: `${EX}S`,
        construct: `${EX}NoP`,
        engine: { conforms: false },
    },
    {
        kind: 'constraint-component',
        name: 'a constraint component with a SPARQL SELECT property validator, in a property shape',
        shapes: `ex:NoValues a sh:ConstraintComponent ; sh:parameter [ sh:path ex:none ] ;
  sh:propertyValidator [ a sh:SPARQLSelectValidator ;
    sh:select "SELECT $this ?value WHERE { $this $PATH ?value . FILTER ($none) }" ] .
ex:S a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property [ sh:path ex:p ;
  ex:none true ] .`,
        at: 'ex:none true',
        shape: `${EX}S`,
        construct: `${EX}NoValues`,
        engine: { conforms: false },
    },
    {
        kind: 'constraint-component',
        name: 'a constraint component with a SHACL-JS validator',
        shapes: `ex:Js a sh:ConstraintComponent ; sh:parameter [ sh:path ex:jsParam ] ;
  sh:validator [ a sh:JSValidator ; sh:jsFunctionName "fail" ; sh:jsLibrary [ sh:jsLibraryURL "urn:x" ] ] .
ex:S a sh:NodeShape ; sh:targetClass ex:Thing ;
  ex:jsParam true .`,
        at: 'ex:jsParam true',
        shape: `${EX}S`,
        construct: `${EX}Js`,
        engine: { refused: 'shapes-ill-formed' },
    },
    {
        kind: 'owl-imports',
        name: 'an import in the shapes graph',
        shapes: `<https://example.test/root/shapes> a owl:Ontology ;
  owl:imports <https://example.test/elsewhere> .
ex:S a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property [ sh:path ex:p ; sh:minCount 1 ] .`,
        at: 'owl:imports',
        shape: null,
        construct: 'http://www.w3.org/2002/07/owl#imports',
        engine: { refused: 'shapes-imports' },
    },
    {
        kind: 'entailment',
        name: 'an entailment regime',
        shapes: `<https://example.test/root/shapes>
  sh:entailment <http://www.w3.org/ns/entailment/RDFS> .
ex:S a sh:NodeShape ; sh:targetClass ex:Super ; sh:property [ sh:path ex:q ; sh:minCount 1 ] .`,
        at: 'sh:entailment',
        shape: null,
        construct: `${SH}entailment`,
        engine: { refused: 'shapes-invalid' },
    },
];

function memory(texts: Readonly<Record<string, string>>): OntologyPorts {
    const resources: TextResourcePort = {
        readBytes: (locator: string) => {
            const text = texts[locator];
            return text === undefined
                ? Effect.fail(new ResourceAccessError(locator, 'not present'))
                : Effect.succeed(new TextEncoder().encode(text));
        },
        readText: (locator: string) => {
            const text = texts[locator];
            return text === undefined
                ? Effect.fail(new ResourceAccessError(locator, 'not present'))
                : Effect.succeed(text);
        },
        listFiles: () => Effect.succeed([]),
    };
    return { resources, citationFiles: { exists: () => Effect.succeed(true) } };
}

function shapeSource(id: string, owner: ProjectSourceOwner = ROOT): ShapeSourceDescriptor {
    return { id, owner, locator: `${id}.ttl`, baseIri: owner.canonicalIri, mediaType: 'text/turtle' };
}

async function validate(
    shapes: Readonly<Record<string, string>>,
    owners: Readonly<Record<string, ProjectSourceOwner>> = {},
) {
    const texts: Record<string, string> = { 'data.ttl': DATA };
    for (const [id, text] of Object.entries(shapes)) {
        texts[`${id}.ttl`] = text;
    }
    const service = makeOntologyService(memory(texts));
    const graph = await Effect.runPromise(
        service.assemble([
            {
                id: 'data',
                owner: ROOT,
                locator: 'data.ttl',
                baseIri: ROOT.canonicalIri,
                mediaType: 'text/turtle',
                provenance: { _tag: 'Asserted' },
            },
        ]),
    );
    return Effect.runPromise(
        service.shacl(
            graph,
            Object.keys(shapes).map((id) => shapeSource(id, owners[id])),
            true,
        ),
    );
}

/** The 1-based line and column where `text` first appears in `source`. */
function positionOf(source: string, text: string) {
    const index = source.indexOf(text);
    expect(index).toBeGreaterThanOrEqual(0);
    const before = source.slice(0, index).split('\n');
    return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}

function parse(text: string): ReadonlyArray<Quad> {
    return new Parser({ format: 'text/turtle', factory: DataFactory }).parse(text);
}

/** Runs the bundled erden-shacl on the shapes and DATA, with no Erden check code in between. */
async function runEngine(shapes: string): Promise<{ readonly refused: string } | { readonly conforms: boolean }> {
    const engine = resolveBundledShaclEngine();
    const request = encodeShaclRequest({
        requestId: 'support',
        tool: shaclEngineTool(engine.tool.executableDigest),
        shapes: prepareShaclShapes(parse(shapes)),
        graphs: [{ id: 'data', quads: parse(DATA) }],
        maxResults: 1_000,
    });
    const answer = await runShaclRequest(engine.path, request, { maxWallTimeMs: 30_000 });
    return answer.outcome === 'refused' ? { refused: answer.code } : { conforms: answer.reports[0]?.conforms ?? true };
}

describe('what the bundled SHACL engine cannot run', () => {
    it('names the engine the rules were checked against', () => {
        expect(SHACL_ENGINE).toEqual({ name: 'erden-shacl', version: '0.1.0+purrdf.3.0.1' });
    });

    // If one of these fails after an engine change, the engine now runs or refuses that construct differently: check
    // it, then change UNSUPPORTED_BY_ENGINE in src/shacl-support.ts to match, instead of changing the expectation.
    it.each(CASES)('the engine itself refuses or validates $name', async (item) => {
        expect(await runEngine(`${PREFIXES}${item.shapes}`)).toEqual(item.engine);
    });

    it('the engine runs the Core control case, so ignoring is not a broken harness', async () => {
        expect(
            await runEngine(
                `${PREFIXES}ex:S a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property [ sh:path ex:q ; sh:minCount 1 ] .`,
            ),
        ).toEqual({ conforms: false });
    });
});

const REFUSED = CASES.filter((item) => 'refused' in item.engine);
const VALIDATED = CASES.filter((item) => !('refused' in item.engine));

describe('refusing the SHACL step', () => {
    it.each(VALIDATED)('validates $name and reports the result the data breaks', async (item) => {
        const result = await validate({ shapes: `${PREFIXES}${item.shapes}` });
        expect(result).not.toHaveProperty('unsupported');
        expect(result?.conforms).toBe(false);
        expect(result?.findings.map((finding) => [finding.shape, finding.focus])).toEqual([[item.shape, `${EX}item`]]);
        expect(result?.engine?.name).toBe('erden-shacl');
    });

    it.each(REFUSED)('refuses $name, naming the shape, the construct and where it is written', async (item) => {
        const text = `${PREFIXES}${item.shapes}`;
        const result = await validate({ shapes: text });
        expect(result).toMatchObject({
            conforms: false,
            findings: [],
            shapes: [],
            selfTest: [],
            counts: { violation: 0, warning: 0, info: 0 },
        });
        expect(result?.sourceDigests.map((digest) => digest.sourceId)).toEqual(['shapes']);
        expect(result?.unsupported).toEqual([
            {
                kind: item.kind,
                shape: item.shape,
                construct: item.construct,
                message: expect.stringContaining('the bundled SHACL engine (erden-shacl 0.1.0+purrdf.3.0.1)') as string,
                sourceId: 'shapes',
                position: positionOf(text, item.at),
            },
        ]);
    });

    it('validates a shape with a Core constraint and a SPARQL-based component: the component decides', async () => {
        const text = `${PREFIXES}
ex:NoP a sh:ConstraintComponent ; sh:parameter [ sh:path ex:forbidden ] ;
  sh:validator [ a sh:SPARQLAskValidator ; sh:ask "ASK { FILTER NOT EXISTS { $this $forbidden ?any } }" ] .
ex:S a sh:NodeShape ; sh:targetClass ex:Thing ; ex:forbidden ex:p ;
  sh:property [ sh:path ex:p ; sh:minCount 1 ] .`;
        // rdf-validate-shacl passed this data: it ran the Core minCount and ignored the component the data breaks.
        expect(await runEngine(text)).toEqual({ conforms: false });
        const result = await validate({ shapes: text });
        expect(result).not.toHaveProperty('unsupported');
        expect(result?.conforms).toBe(false);
        expect(result?.findings.map((finding) => [finding.shape, finding.component, finding.value])).toEqual([
            [`${EX}S`, `${EX}NoP`, `<${EX}item>`],
        ]);
    });

    it('lists every construct of every shape source, in source order and then file order', async () => {
        const first = `${PREFIXES}
ex:A a sh:NodeShape ; sh:targetClass ex:Thing ;
  sh:js [ a sh:JSConstraint ; sh:jsFunctionName "fail" ; sh:jsLibrary [ sh:jsLibraryURL "urn:x" ] ] .
ex:B a sh:NodeShape ;
  sh:target [ a sh:SPARQLTarget ; sh:select "SELECT ?this WHERE { }" ] ;
  sh:sparql [ sh:select "SELECT $this WHERE { }" ] ;
  sh:property [ sh:path ex:q ; sh:minCount 1 ] .`;
        const second = `${PREFIXES}<https://example.test/root/more> owl:imports <https://example.test/elsewhere> .`;
        const result = await validate({ second, first });
        // The SPARQL target and constraint are not listed: the engine runs them.
        expect(result?.unsupported?.map((item) => [item.sourceId, item.kind, item.position])).toEqual([
            ['second', 'owl-imports', positionOf(second, 'owl:imports')],
            ['first', 'js-constraint', positionOf(first, 'sh:js ')],
        ]);
    });

    it('attributes a parameter use to the file that uses it, when a dependency declares the component', async () => {
        const declared = `${PREFIXES}
ex:Js a sh:ConstraintComponent ; sh:parameter [ sh:path ex:jsParam ] ;
  sh:validator [ a sh:JSValidator ; sh:jsFunctionName "fail" ; sh:jsLibrary [ sh:jsLibraryURL "urn:x" ] ] .`;
        const used = `${PREFIXES}
ex:S a sh:NodeShape ; sh:targetClass ex:Thing ;
  ex:jsParam true .`;
        const result = await validate({ declared, used }, { declared: DEPENDENCY });
        expect(result?.unsupported?.map((item) => [item.sourceId, item.shape, item.position])).toEqual([
            ['used', `${EX}S`, positionOf(used, 'ex:jsParam true')],
        ]);
    });

    it('names no shape for a construct in a shape with no name of its own', async () => {
        const text = `${PREFIXES}
[] a sh:NodeShape ; sh:targetClass ex:Thing ;
  sh:js [ a sh:JSConstraint ; sh:jsFunctionName "fail" ; sh:jsLibrary [ sh:jsLibraryURL "urn:x" ] ] .`;
        const result = await validate({ shapes: text });
        expect(result?.unsupported?.map((item) => [item.shape, item.position])).toEqual([
            [null, positionOf(text, 'sh:js ')],
        ]);
    });

    it('runs SHACL Core, SHACL-AF rules, unused components and SHACL vocabulary, with no refusal', async () => {
        const text = `${PREFIXES}
sh:MinCountConstraintComponent a sh:ConstraintComponent ; sh:parameter [ sh:path sh:minCount ] .
ex:Unused a sh:ConstraintComponent ; sh:parameter [ sh:path ex:neverUsed ] ;
  sh:validator [ a sh:SPARQLAskValidator ; sh:ask "ASK { }" ] .
ex:S a sh:NodeShape ; sh:targetClass ex:Thing ;
  sh:rule [ a sh:TripleRule ; sh:subject sh:this ; sh:predicate ex:q ; sh:object ex:z ] ;
  sh:property [ sh:path ex:q ; sh:minCount 1 ; sh:message "q is required" ] .`;
        const result = await validate({ shapes: text });
        expect(result).not.toHaveProperty('unsupported');
        expect(result).toMatchObject({ conforms: false, counts: { violation: 1 } });
        expect(result?.findings.map((finding) => finding.message)).toEqual(['q is required']);
        expect(result?.selfTest.map((test) => [test.shape, test.fired])).toEqual([[`${EX}S`, true]]);
    });
});
