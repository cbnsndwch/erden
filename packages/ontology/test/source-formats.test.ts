import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Effect } from 'effect';
import { DataFactory } from 'n3';
import { describe, expect, it, vi } from 'vitest';

import { resolveBundledReasonerArtifact } from '@erden/reasoner-distribution';

import {
    assembleOntology,
    canonicalGraphHash,
    computeAssembledOntologySnapshotDigest,
    GRAPH_HASH_MAX_DEEP_ITERATIONS,
    identifyOntologySources,
    JSON_LD_GUARD_LIMITS,
    N3_PARSER,
    normalizeAssembledOntology,
    OntologyAssemblyLimitError,
    OntologySourceParseError,
    OntologySourceRefusedError,
    ontologyMediaTypeForLocator,
    OXIGRAPH_PARSER,
    parseOntologySource,
    parseOntologySourceText,
    parseTurtleSource,
    RDF_XML_GUARD_LIMITS,
    rdfXmlGuardRefusal,
    snapshotAssembledOntology,
    TurtleSourceEncodingError,
    TurtleSourceParseError,
    UnsupportedSemanticFormatError,
    type AssembledOntology,
    type OntologyMediaType,
    type TurtleSourceDescriptor,
} from '../src/index.js';

import { memoryResourcePort, ROOT_OWNER } from './reasoner-helpers.js';

const REQUIRED_TOOL = resolveBundledReasonerArtifact().requiredTool;

const FIXTURES = join(import.meta.dirname, 'fixtures', 'source-formats');
const ANIMALS = ['animals.ttl', 'animals.nt', 'animals.rdf', 'animals.jsonld'] as const;

function fixtureBytes(name: string): Uint8Array {
    return Uint8Array.from(readFileSync(join(FIXTURES, name)));
}

function descriptor(locator: string, id = `root:ontology:${locator}`): TurtleSourceDescriptor {
    return Object.freeze({
        id,
        owner: ROOT_OWNER,
        locator,
        baseIri: ROOT_OWNER.canonicalIri,
        mediaType: ontologyMediaTypeForLocator(locator) ?? 'text/turtle',
        provenance: Object.freeze({ _tag: 'Asserted' as const }),
    });
}

function parseFixture(name: string, maximumQuads?: number) {
    return parseOntologySource(descriptor(name), fixtureBytes(name), maximumQuads);
}

function failure(run: () => unknown): unknown {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('expected the parse to fail');
}

async function assembleFixture(name: string, id = 'root:ontology:0000'): Promise<AssembledOntology> {
    const source = descriptor(name, id);
    return Effect.runPromise(
        assembleOntology(memoryResourcePort([{ id, locator: name, bytes: fixtureBytes(name) }]), [source]),
    );
}

describe('source format port', () => {
    it('chooses the parser and media type by extension', () => {
        expect(
            ['a.ttl', 'b.nt', 'c.rdf', 'd.owl', 'e.jsonld', 'F.TTL', 'g.nq'].map(ontologyMediaTypeForLocator),
        ).toEqual<ReadonlyArray<OntologyMediaType | undefined>>([
            'text/turtle',
            'application/n-triples',
            'application/rdf+xml',
            'application/rdf+xml',
            'application/ld+json',
            'text/turtle',
            undefined,
        ]);
    });

    it('keeps the parser identities in step with the pinned dependencies', () => {
        const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
            readonly dependencies: Readonly<Record<string, string>>;
        };
        expect(manifest.dependencies.n3).toBe(N3_PARSER.version);
        expect(manifest.dependencies.oxigraph).toBe(OXIGRAPH_PARSER.version);
    });

    it.each(['graph.nq', 'graph.trig', 'rules.n3'])('refuses %s by name with the supported extensions', (name) => {
        const error = failure(() => parseOntologySource(descriptor(name), new TextEncoder().encode('')));
        expect(error).toBeInstanceOf(UnsupportedSemanticFormatError);
        expect(error).toMatchObject({
            code: 'UNSUPPORTED_SEMANTIC_FORMAT',
            supportedExtensions: ['.ttl', '.nt', '.rdf', '.owl', '.jsonld'],
        });
        expect((error as Error).message).toContain('one of .ttl, .nt, .rdf, .owl, .jsonld');
    });

    it('refuses a descriptor whose media type disagrees with its extension', () => {
        const mismatched = { ...descriptor('animals.rdf'), mediaType: 'text/turtle' as const };
        expect(() => parseOntologySource(mismatched, fixtureBytes('animals.rdf'))).toThrow(
            UnsupportedSemanticFormatError,
        );
    });

    it('reads the same graph from Turtle, N-Triples, RDF/XML with FIBO-style entities and inline JSON-LD', async () => {
        const hashes = await Promise.all(ANIMALS.map((name) => canonicalGraphHash(parseFixture(name).quads)));
        expect(hashes[0]).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(new Set(hashes).size).toBe(1);
        expect(ANIMALS.map((name) => parseFixture(name).quads.length)).toEqual([26, 26, 26, 26]);
    });

    it('labels blank nodes deterministically with the source prefix in parser order', () => {
        for (const name of ANIMALS) {
            const first = parseFixture(name).quads;
            const second = parseFixture(name).quads;
            expect(first).toEqual(second);
            const labels = first.flatMap((quad) =>
                [quad.subject, quad.object].filter((term) => term.termType === 'BlankNode').map((term) => term.value),
            );
            expect(labels.length).toBeGreaterThan(0);
            expect(labels.every((label) => label.startsWith(`erden_`))).toBe(true);
        }
        const rdfXml = new Set(
            parseFixture('animals.rdf').quads.flatMap((quad) =>
                [quad.subject, quad.object].filter((term) => term.termType === 'BlankNode').map((term) => term.value),
            ),
        );
        expect([...rdfXml].map((label) => label.replace(/^erden_[0-9a-f]{64}_/u, ''))).toEqual(['1', '2', '3']);
    });

    it('gives identical snapshot digests and reasoner requests for two assemblies of the same bytes', async () => {
        for (const name of ANIMALS) {
            const first = await assembleFixture(name);
            const second = await assembleFixture(name);
            expect(computeAssembledOntologySnapshotDigest(first)).toBe(computeAssembledOntologySnapshotDigest(second));
            expect(computeAssembledOntologySnapshotDigest(snapshotAssembledOntology(first))).toBe(
                computeAssembledOntologySnapshotDigest(first),
            );
            expect(normalizeAssembledOntology(first, REQUIRED_TOOL).wire).toBe(
                normalizeAssembledOntology(second, REQUIRED_TOOL).wire,
            );
        }
    });

    it('normalizes every format to the same V1 axioms, which differ only in their source binding', async () => {
        const semantic = await Promise.all(
            ANIMALS.map(async (name) => {
                const request = normalizeAssembledOntology(await assembleFixture(name), REQUIRED_TOOL).request;
                return request.ontology.axioms
                    .map(({ id: _id, provenance: _provenance, ...axiom }) => JSON.stringify(axiom))
                    .sort();
            }),
        );
        for (const axioms of semantic.slice(1)) {
            expect(axioms).toEqual(semantic[0]);
        }
    });

    it('identifies each source by media type, parser and canonical graph hash', async () => {
        const identities = await Promise.all(
            ANIMALS.map(
                async (name) => (await Effect.runPromise(identifyOntologySources(await assembleFixture(name))))[0],
            ),
        );
        expect(identities.map((identity) => [identity?.mediaType, identity?.parser])).toEqual([
            ['text/turtle', 'n3@2.1.1'],
            ['application/n-triples', 'n3@2.1.1'],
            ['application/rdf+xml', 'oxigraph@0.5.9'],
            ['application/ld+json', 'oxigraph@0.5.9'],
        ]);
        expect(new Set(identities.map((identity) => identity?.graphHash)).size).toBe(1);
    });

    it('bounds the canonical graph hash by a count of deep iterations, not by the blank nodes it must compare', async () => {
        // A blank-node chain makes every interior node non-unique; the work factor allowed one deep iteration per
        // node, each copying an issuer as long as the chain, and a 20,000-node chain exhausted the heap.
        const RDFC10 = createRequire(import.meta.url)('rdf-canonize/lib/RDFC10.js') as {
            prototype: { hashNDegreeQuads: (...args: unknown[]) => unknown };
        };
        const run = vi.spyOn(RDFC10.prototype, 'hashNDegreeQuads');
        try {
            const p = DataFactory.namedNode('https://example.test/p');
            const chain = [
                DataFactory.quad(DataFactory.namedNode('https://example.test/s'), p, DataFactory.blankNode('b1')),
            ];
            for (let index = 1; index < 5_000; index += 1) {
                chain.push(
                    DataFactory.quad(
                        DataFactory.blankNode(`b${String(index)}`),
                        p,
                        DataFactory.blankNode(`b${String(index + 1)}`),
                    ),
                );
            }
            expect(await canonicalGraphHash(chain)).toBeUndefined();
            expect(run.mock.calls.length).toBeLessThanOrEqual(GRAPH_HASH_MAX_DEEP_ITERATIONS + 1);
            run.mockClear();
            // A graph inside the bound still hashes, the same from every format.
            expect(await canonicalGraphHash(parseFixture('animals.ttl').quads)).toMatch(/^sha256:[0-9a-f]{64}$/u);
        } finally {
            run.mockRestore();
        }
    });

    it('routes Turtle through the unchanged n3 path', () => {
        const text = readFileSync(join(FIXTURES, 'animals.ttl'), 'utf8');
        expect(parseOntologySourceText(descriptor('animals.ttl'), text)).toEqual(
            parseTurtleSource(descriptor('animals.ttl'), text),
        );
    });

    it.each(ANIMALS)('applies the statement limit to %s', (name) => {
        expect(() => parseFixture(name, 25)).toThrow(OntologyAssemblyLimitError);
        expect(parseFixture(name, 26).quads).toHaveLength(26);
    });

    it('accepts UTF-8 only', () => {
        const utf16 = Buffer.from(`﻿${readFileSync(join(FIXTURES, 'animals.nt'), 'utf8')}`, 'utf16le');
        for (const name of ANIMALS) {
            expect(failure(() => parseOntologySource(descriptor(name), utf16))).toBeInstanceOf(
                TurtleSourceEncodingError,
            );
        }
        const declared = failure(() => parseFixture('latin1-declared.rdf'));
        expect(declared).toBeInstanceOf(OntologySourceRefusedError);
        expect(declared).toMatchObject({ reason: 'xml-encoding-declaration', locator: 'latin1-declared.rdf' });
    });

    it('locates syntax errors by file, and by line and column where the parser reports them', () => {
        expect(failure(() => parseFixture('malformed.jsonld'))).toMatchObject({
            code: 'ONTOLOGY_SOURCE_PARSE_ERROR',
            location: { file: 'malformed.jsonld', line: 5, column: 1 },
        });
        const nTriples = failure(() =>
            parseOntologySource(
                descriptor('bad.nt'),
                new TextEncoder().encode('<urn:a> <urn:p> <urn:b> .\n<urn:a> .\n'),
            ),
        );
        expect(nTriples).toBeInstanceOf(TurtleSourceParseError);
        expect(nTriples).toMatchObject({ location: { file: 'bad.nt', line: 2 } });
        const rdfXml = failure(() =>
            parseOntologySource(
                descriptor('bad.rdf'),
                new TextEncoder().encode('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><x:y/>'),
            ),
        );
        expect(rdfXml).toBeInstanceOf(OntologySourceParseError);
        expect(rdfXml).toMatchObject({ location: { file: 'bad.rdf' } });
    });

    it('refuses JSON-LD named graphs, which are outside V1', () => {
        expect(failure(() => parseFixture('named-graph.jsonld'))).toMatchObject({ reason: 'named-graph' });
    });
});

describe('RDF/XML entity guard', () => {
    const oxigraph = createRequire(import.meta.url)('oxigraph') as { parse: (...args: unknown[]) => unknown };

    it.each([
        ['xxe.rdf', 'xml-external-entity'],
        ['billion-laughs.rdf', 'xml-entity-reference-in-value'],
        ['parameter-entity.rdf', 'xml-parameter-entity'],
    ])('refuses %s in under 50 ms without calling Oxigraph', (name, reason) => {
        const parse = vi.spyOn(oxigraph, 'parse');
        try {
            const started = performance.now();
            const error = failure(() => parseFixture(name));
            const elapsed = performance.now() - started;
            expect(error).toBeInstanceOf(OntologySourceRefusedError);
            expect(error).toMatchObject({ reason, locator: name });
            expect(elapsed).toBeLessThan(50);
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
    });

    it('does call Oxigraph for a document the guard admits', () => {
        const parse = vi.spyOn(oxigraph, 'parse');
        try {
            expect(parseFixture('animals.rdf').quads).toHaveLength(26);
            expect(parse).toHaveBeenCalledTimes(1);
        } finally {
            parse.mockRestore();
        }
    });

    it('refuses an internal subset over 64 KiB and entities that would expand past the bound', () => {
        const big = `<!DOCTYPE rdf:RDF [\n${'<!-- padding -->\n'.repeat(4_200)}]>\n<rdf:RDF/>`;
        expect(rdfXmlGuardRefusal(big)).toMatchObject({ reason: 'internal-subset-too-large' });
        const value = 'x'.repeat(60_000);
        const amplified = `<!DOCTYPE r [<!ENTITY e "${value}">]><r>${'&e;'.repeat(600)}</r>`;
        expect(rdfXmlGuardRefusal(amplified)).toMatchObject({ reason: 'entity-expansion-too-large' });
    });

    it('refuses external DTDs, second document types and stray entity declarations', () => {
        expect(rdfXmlGuardRefusal('<!DOCTYPE r SYSTEM "r.dtd"><r/>')).toMatchObject({ reason: 'external-dtd' });
        expect(rdfXmlGuardRefusal('<!DOCTYPE r PUBLIC "-//x" "r.dtd"><r/>')).toMatchObject({ reason: 'external-dtd' });
        expect(rdfXmlGuardRefusal('<!DOCTYPE r []><!doctype r []><r/>')).toMatchObject({
            reason: 'malformed-document-type',
        });
        expect(rdfXmlGuardRefusal('<!DOCTYPE r [<!ENTITY a "b">]><r><!ENTITY c "d"></r>')).toMatchObject({
            reason: 'malformed-document-type',
        });
        expect(rdfXmlGuardRefusal('<!DOCTYPE r [<!ENTITY a PUBLIC "-//x" "y">]><r/>')).toMatchObject({
            reason: 'external-entity',
        });
        expect(rdfXmlGuardRefusal('<!DOCTYPE r [<!ATTLIST r a CDATA "&b;">]><r/>')).toMatchObject({
            reason: 'entity-reference-in-value',
        });
    });

    it('lets plain internal entities, comments and declarations through', () => {
        expect(rdfXmlGuardRefusal(readFileSync(join(FIXTURES, 'animals.rdf'), 'utf8'))).toBeUndefined();
        expect(
            rdfXmlGuardRefusal(
                '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE r [<?pi x?><!ELEMENT r ANY><!ENTITY a \'b\'>]><r>&a;</r>',
            ),
        ).toBeUndefined();
        expect(rdfXmlGuardRefusal('<r/>')).toBeUndefined();
    });

    // Oxigraph reads every `<!ENTITY` in the document type's raw text and keeps the last of two declarations.
    it.each([
        ['a comment', '<!-- <!ENTITY lol1 "&lol;&lol;&lol;"> -->'],
        ['a processing instruction', '<?x <!ENTITY lol1 "&lol;&lol;&lol;"> ?>'],
        ['a quoted attribute default', `<!ATTLIST r a CDATA "<!ENTITY lol1 'lol'>">`],
        ['a second declaration of the same name', '<!ENTITY lol1 "lol"><!ENTITY lol1 "lollol">'],
        ['a name run into its value', '<!ENTITY lol1"lol">'],
    ])('refuses an entity declaration in %s', (_label, subset) => {
        expect(rdfXmlGuardRefusal(`<!DOCTYPE r [<!ENTITY lol "lol">${subset}]><r>&lol1;</r>`)).toMatchObject({
            reason: 'malformed-document-type',
        });
    });

    it('refuses the nested-entity fixture with its declarations hidden in comments, without calling Oxigraph', () => {
        const hidden = readFileSync(join(FIXTURES, 'billion-laughs.rdf'), 'utf8').replace(
            /(<!ENTITY lol\d [^>]*>)/gu,
            '<!-- $1 -->',
        );
        const parse = vi.spyOn(oxigraph, 'parse');
        try {
            const started = performance.now();
            const error = failure(() =>
                parseOntologySource(descriptor('hidden.rdf'), new TextEncoder().encode(hidden)),
            );
            expect(performance.now() - started).toBeLessThan(50);
            expect(error).toMatchObject({ reason: 'xml-malformed-document-type', locator: 'hidden.rdf' });
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
    });

    it('refuses a later, larger declaration that would expand past the bound', () => {
        // The guard kept the first, one-byte value; Oxigraph keeps the second and built a 120,000,000-character literal.
        const text = `<!DOCTYPE r [<!ENTITY e "x"><!ENTITY e "${'A'.repeat(60_000)}">]><r>${'&e;'.repeat(2_000)}</r>`;
        expect(rdfXmlGuardRefusal(text)).toMatchObject({
            reason: 'malformed-document-type',
            detail: 'entity e is declared more than once',
        });
    });

    it('refuses elements nested past the bound before the parser slows down', () => {
        function nested(depth: number): string {
            return `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:e="https://example.test/e#"><rdf:Description rdf:about="https://example.test/s">${'<e:p rdf:parseType="Resource">'.repeat(depth)}${'</e:p>'.repeat(depth)}</rdf:Description></rdf:RDF>`;
        }
        // rdf:RDF and rdf:Description are two of the levels.
        const deepest = RDF_XML_GUARD_LIMITS.maxElementDepth - 2;
        expect(
            parseOntologySource(descriptor('deep.rdf'), new TextEncoder().encode(nested(deepest))).quads,
        ).toHaveLength(deepest);
        const parse = vi.spyOn(oxigraph, 'parse');
        try {
            const started = performance.now();
            const error = failure(() =>
                parseOntologySource(descriptor('deeper.rdf'), new TextEncoder().encode(nested(100_000))),
            );
            expect(performance.now() - started).toBeLessThan(1_000);
            expect(error).toMatchObject({ reason: 'xml-nesting-too-deep', locator: 'deeper.rdf' });
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
        // Self-closing elements, comments, CDATA and quoted '>' do not count as levels.
        const flat = `<r>${'<e a="x>y"/><!-- <a> --><![CDATA[<b>]]><?p <c>?>'.repeat(1_000)}</r>`;
        expect(rdfXmlGuardRefusal(flat)).toBeUndefined();
    });
});

describe('JSON-LD contexts', () => {
    it('refuses a remote context by URL without any network access', () => {
        const fetch = vi.spyOn(globalThis, 'fetch');
        try {
            const error = failure(() => parseFixture('remote-context.jsonld'));
            expect(error).toBeInstanceOf(OntologySourceRefusedError);
            expect(error).toMatchObject({ reason: 'jsonld-remote-context' });
            expect((error as Error).message).toContain('"https://schema.org/"');
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            fetch.mockRestore();
        }
    });

    it.each([
        ['an array entry', { '@context': [{ ex: 'urn:ex#' }, 'ctx.jsonld'], '@id': 'urn:a' }, 'ctx.jsonld'],
        [
            'an import',
            { '@context': { '@import': 'https://example.test/c' }, '@id': 'urn:a' },
            'https://example.test/c',
        ],
        [
            'a scoped context',
            { '@context': { p: { '@id': 'urn:p', '@context': 'https://example.test/s' } }, '@id': 'urn:a' },
            'https://example.test/s',
        ],
    ])('refuses a remote context in %s', (_label, document, url) => {
        const error = failure(() =>
            parseOntologySource(descriptor('remote.jsonld'), new TextEncoder().encode(JSON.stringify(document))),
        );
        expect(error).toMatchObject({ reason: 'jsonld-remote-context' });
        expect((error as Error).message).toContain(JSON.stringify(url));
    });
});

describe('JSON-LD structure', () => {
    const oxigraph = createRequire(import.meta.url)('oxigraph') as { parse: (...args: unknown[]) => unknown };

    function nested(depth: number): string {
        return `{"@context":{"p":{"@id":"https://example.test/p"}},"@id":"https://example.test/s",${'"p":{'.repeat(depth)}"@id":"https://example.test/o"${'}'.repeat(depth)}}`;
    }

    it('refuses nesting past the bound before Oxigraph, which traps from about 750 levels', () => {
        // The outer object is one level.
        const deepest = JSON_LD_GUARD_LIMITS.maxNestingDepth - 1;
        expect(
            parseOntologySource(descriptor('deep.jsonld'), new TextEncoder().encode(nested(deepest))).quads,
        ).toHaveLength(deepest);
        const parse = vi.spyOn(oxigraph, 'parse');
        try {
            for (const depth of [deepest + 1, 800]) {
                const error = failure(() =>
                    parseOntologySource(descriptor('deeper.jsonld'), new TextEncoder().encode(nested(depth))),
                );
                expect(error).toMatchObject({ reason: 'jsonld-nesting-too-deep', locator: 'deeper.jsonld' });
            }
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
        expect(parseFixture('animals.jsonld').quads).toHaveLength(26);
    });

    it.each([
        [
            'a remote context hidden by an inline one',
            '{"@context":"https://remote.example/ctx","@context":{"p":"https://example.test/p"},"@id":"https://example.test/s","p":"v"}',
            '"@context"',
        ],
        ['an escaped key', '{"@id":"https://example.test/s","\\u0040id":"https://example.test/t"}', '"@id"'],
        [
            'a nested object',
            '{"@id":"https://example.test/s","https://example.test/p":{"@value":"a","@value":"b"}}',
            '"@value"',
        ],
    ])('refuses an object that repeats a key: %s', (_label, text, key) => {
        const error = failure(() => parseOntologySource(descriptor('repeat.jsonld'), new TextEncoder().encode(text)));
        expect(error).toMatchObject({ reason: 'jsonld-duplicate-key' });
        expect((error as Error).message).toContain(key);
    });

    it('reads the same key in sibling objects, and braces and quotes inside strings', () => {
        const text =
            '{"@context":{"p":{"@id":"https://example.test/p"}},"@graph":[{"@id":"https://example.test/a","p":"{\\"x\\":["},{"@id":"https://example.test/b","p":"]}"}]}';
        expect(parseOntologySource(descriptor('siblings.jsonld'), new TextEncoder().encode(text)).quads).toHaveLength(
            2,
        );
    });
});

describe('the outside-profile census in every format', () => {
    const CENSUS = ['census.ttl', 'census.rdf', 'census.jsonld'] as const;
    const EXPECTED = [
        ['annotation', 'owl:versionInfo', 1],
        ['unreasoned', 'owl:AsymmetricProperty', 1],
        ['unreasoned', 'owl:propertyDisjointWith', 1],
        ['unreasoned', 'owl:Restriction', 4],
    ];

    async function reportMode(name: string): Promise<AssembledOntology> {
        const source = Object.freeze({ ...descriptor(name, 'root:ontology:0000'), outsideProfile: 'report' as const });
        return Effect.runPromise(
            assembleOntology(memoryResourcePort([{ id: source.id, locator: name, bytes: fixtureBytes(name) }]), [
                source,
            ]),
        );
    }

    it.each(CENSUS)('partitions %s the same way, with the same graph hash', async (name) => {
        const graph = await reportMode(name);
        const normalized = normalizeAssembledOntology(graph, REQUIRED_TOOL);
        const findings = normalized.partition.findings
            .map((finding) => [finding.group, finding.construct, finding.statementKeys.length] as const)
            .sort((left, right) => `${left[0]} ${left[1]}`.localeCompare(`${right[0]} ${right[1]}`));
        expect(findings).toEqual(EXPECTED);
        expect(normalized.partition.findings.every((finding) => finding.policy === 'report')).toBe(true);
        // dct:title is used without a declaration: accepted as an annotation, with a warning, in every format.
        expect(
            normalized.partition.undeclaredAnnotationProperties.map((item) => [item.property, item.statementCount]),
        ).toEqual([['http://purl.org/dc/terms/title', 1]]);
        const [identity] = await Effect.runPromise(identifyOntologySources(graph));
        const [reference] = await Effect.runPromise(identifyOntologySources(await reportMode('census.ttl')));
        expect(identity?.graphHash).toBe(reference?.graphHash);
    });

    it.each(CENSUS)('refuses %s in refuse mode, listing every finding', async (name) => {
        const graph = await assembleFixture(name);
        const error = failure(() => normalizeAssembledOntology(graph, REQUIRED_TOOL)) as {
            code: string;
            details: { findings: ReadonlyArray<unknown> };
        };
        expect(error.code).toBe('OUTSIDE_PROFILE');
        expect(error.details.findings).toHaveLength(EXPECTED.length);
    });
});
