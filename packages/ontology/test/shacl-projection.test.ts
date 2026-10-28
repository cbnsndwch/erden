import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { Effect } from 'effect';
import { DataFactory as f, Parser, Store, type Quad, type Term } from 'n3';
import { describe, expect, it, vi } from 'vitest';

import {
    normalizeRdfComparison,
    normalizeShaclEvidence,
    RDF_COMPARISON_LIMITS,
    SHACL_RDF_LIMITS,
    validateShaclWithEvidence,
    type CapturedQuad,
    type CapturedShapeSource,
    type CapturedResource,
    type ShaclEvidence,
    type ShaclEvidenceComplete,
    type ShaclRdfComplete,
} from '../src/index.js';
import { encodeShaclContexts } from '../src/shacl-evidence/project-encoding.js';

const NS = 'urn:erden:shacl-context:v1:';
const digest = `sha256:${'a'.repeat(64)}`;
function term(value: Term): CapturedQuad['object'] | CapturedQuad['graph'] {
    switch (value.termType) {
        case 'NamedNode':
        case 'BlankNode':
            return { termType: value.termType, value: value.value };
        case 'DefaultGraph':
            return { termType: 'DefaultGraph' };
        case 'Literal':
            return {
                termType: 'Literal',
                value: value.value,
                language: value.language,
                datatype: value.datatype.value,
            };
        default:
            throw new Error('Invalid fixture term');
    }
}
function quads(text: string): CapturedQuad[] {
    return new Parser({ format: 'N-Quads', blankNodePrefix: '' }).parse(text).map((quad) => ({
        subject: term(quad.subject) as CapturedResource,
        predicate: { termType: 'NamedNode', value: quad.predicate.value },
        object: term(quad.object) as CapturedQuad['object'],
        graph: term(quad.graph) as CapturedQuad['graph'],
    }));
}
function evidence(
    data = '',
    shapes: Record<string, string> = {},
    report = '',
    root: CapturedResource = { termType: 'NamedNode', value: 'urn:report' },
): ShaclEvidenceComplete {
    return {
        schema: 'erden.shacl-capture/v1',
        kind: 'complete',
        data: quads(data),
        shapes: Object.entries(shapes).map(([sourceId, text]) => ({
            sourceId,
            contentDigest: digest,
            owner: { role: 'root', canonicalIri: 'urn:owner' },
            quads: quads(text),
        })),
        report: { root, quads: quads(report) },
    };
}
async function complete(input: ShaclEvidenceComplete): Promise<ShaclRdfComplete> {
    const result = await normalizeShaclEvidence(input);
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') {
        throw new Error('Expected complete projection');
    }
    return result;
}

/** Independent inverse: reconstruct fresh component instances, then restore each mapped graph. */
function restore(projection: ShaclRdfComplete) {
    const encoded = new Store();
    for (const [index, component] of projection.rdf.components.entries()) {
        for (let instance = 0; instance < component.multiplicity; instance += 1) {
            encoded.addQuads(
                new Parser({ format: 'N-Quads', blankNodePrefix: `c${String(index)}i${String(instance)}_` }).parse(
                    component.nquads,
                ),
            );
        }
    }
    function one(subject: Quad['subject'], predicate: string): Quad['object'] {
        const matches = encoded.getObjects(subject, f.namedNode(NS + predicate), f.defaultGraph());
        expect(matches).toHaveLength(1);
        return matches[0] as Quad['object'];
    }
    const contexts = new Map<string, Store>();
    for (const node of encoded.getSubjects(f.namedNode(NS + 'kind'), null, f.defaultGraph())) {
        contexts.set(node.value, new Store());
    }
    for (const mapped of encoded.getSubjects(f.namedNode(NS + 'context'), null, f.defaultGraph())) {
        const context = one(mapped, 'context');
        const target = contexts.get(context.value);
        expect(target).toBeDefined();
        const defaultGraph = encoded.countQuads(mapped, f.namedNode(NS + 'defaultGraph'), null, f.defaultGraph()) > 0;
        if (defaultGraph) {
            expect(one(mapped, 'defaultGraph')).toEqual(f.literal('true'));
        }
        for (const quad of encoded.getQuads(null, null, null, mapped)) {
            target?.addQuad(
                f.quad(
                    quad.subject,
                    quad.predicate,
                    quad.object,
                    defaultGraph ? f.defaultGraph() : (one(mapped, 'graph') as Quad['graph']),
                ),
            );
        }
    }
    return { contexts, root: one(f.namedNode(NS + 'report'), 'root'), encoded };
}

describe('contextual SHACL RDF normalization', () => {
    it('retains empty contexts and the selected report root', async () => {
        const empty = await complete(evidence());
        expect(empty.quadCounts).toEqual({ data: 0, shapes: 0, report: 0 });
        expect(empty.rdf.quadCount).toBe(3);
        const decoded = restore(empty);
        expect([...decoded.contexts.keys()].sort()).toEqual([NS + 'data', NS + 'report']);
        expect(decoded.root).toEqual(f.namedNode('urn:report'));
        const selected = await complete(evidence('', { 'root/shapes:#0': '' }));
        expect(selected.rdf.quadCount).toBe(5);
        expect(restore(selected).contexts.has(NS + 'shape:root%2Fshapes%3A%230')).toBe(true);
        expect(selected.sources[0]?.quadCount).toBe(0);
        expect(selected.rdf).not.toEqual(empty.rdf);
        const mapped = restore(await complete(evidence('<urn:s> <urn:p> "value" .'))).encoded;
        expect(mapped.getSubjects(f.namedNode(NS + 'context'), f.namedNode(NS + 'data'), f.defaultGraph())).toEqual([
            f.namedNode(NS + 'graph:4db254426d6108b555a38f03d7d2f39eaeef8325bc289f731a36cc2a7da753ca'),
        ]);
    });

    it('ignores blank labels, quad order, and shape-source enumeration while preserving shared links', async () => {
        const first = evidence(
            '_:a <urn:p> _:b <urn:g> .',
            { z: '_:shape <urn:path> <urn:p> .', a: '<urn:S> <urn:uses> _:shape .' },
            '_:r <urn:value> _:a .\n_:r <urn:shape> _:shape .',
            { termType: 'BlankNode', value: 'r' },
        );
        const renamed = evidence(
            '_:x <urn:p> _:y <urn:g> .',
            { a: '<urn:S> <urn:uses> _:t .', z: '_:t <urn:path> <urn:p> .' },
            '_:out <urn:shape> _:t .\n_:out <urn:value> _:x .',
            { termType: 'BlankNode', value: 'out' },
        );
        expect(await complete(renamed)).toEqual(await complete(first));
        const decoded = restore(await complete(first));
        const data = decoded.contexts.get(NS + 'data') as Store;
        const report = decoded.contexts.get(NS + 'report') as Store;
        const shapes = decoded.contexts.get(NS + 'shape:z') as Store;
        expect(report.getObjects(null, f.namedNode('urn:value'), null)[0]).toEqual(
            data.getSubjects(f.namedNode('urn:p'), null, null)[0],
        );
        expect(report.getObjects(null, f.namedNode('urn:shape'), null)[0]).toEqual(
            shapes.getSubjects(f.namedNode('urn:path'), null, null)[0],
        );
        expect(report.getSubjects(f.namedNode('urn:value'), null, null)[0]).toEqual(decoded.root);
    });

    it('distinguishes broken contextual links even when each separate dataset is isomorphic', async () => {
        const first = evidence('_:a <urn:p> "data" .', {}, '_:r <urn:value> _:a .', {
            termType: 'BlankNode',
            value: 'r',
        });
        const broken = evidence('_:a <urn:p> "data" .', {}, '_:r <urn:value> _:elsewhere .', {
            termType: 'BlankNode',
            value: 'r',
        });
        expect((await complete(first)).rdf).not.toEqual((await complete(broken)).rdf);
    });

    it('deduplicates within each context and retains the same assertion in different contexts', async () => {
        const quad = '<urn:s> <urn:p> "same" .\n';
        const first = await complete(evidence(quad, { shapes: quad }, quad));
        expect(await complete(evidence(quad + quad, { shapes: quad + quad }, quad + quad))).toEqual(first);
        expect(first.quadCounts).toEqual({ data: 1, shapes: 1, report: 1 });
        expect(first.rdf.quadCount).toBe(14);
        expect((await complete(evidence(quad, { shapes: '' }, quad))).rdf).not.toEqual(first.rdf);
    });

    it('preserves named, blank, and default graphs without confusing internal vocabulary IRIs', async () => {
        const text = `<${NS}data> <${NS}context> "true" <${NS}report> .\n_:g0 <urn:p> _:g0 _:g0 .\n<urn:s> <urn:p> "default" .`;
        const baseline = await complete(evidence(text));
        expect(await complete(evidence(text.replaceAll('_:g0', '_:renamed')))).toEqual(baseline);
        const decoded = restore(baseline).contexts.get(NS + 'data') as Store;
        expect(
            decoded.countQuads(
                f.namedNode(NS + 'data'),
                f.namedNode(NS + 'context'),
                f.literal('true'),
                f.namedNode(NS + 'report'),
            ),
        ).toBe(1);
        const blank = decoded
            .getQuads(null, f.namedNode('urn:p'), null, null)
            .find((quad) => quad.subject.termType === 'BlankNode');
        expect(blank?.subject).toEqual(blank?.object);
        expect(blank?.subject).toEqual(blank?.graph);
        expect(decoded.countQuads(f.namedNode('urn:s'), null, null, f.defaultGraph())).toBe(1);
        const variants: ShaclRdfComplete[] = [];
        for (const graph of ['<urn:g>', '_:g', '']) {
            variants.push(await complete(evidence(`<urn:s> <urn:p> "value" ${graph} .`)));
        }
        expect(new Set(variants.map((value) => JSON.stringify(value.rdf))).size).toBe(3);
    });

    it('preserves literal identity and keeps hostile values inert', async () => {
        const text =
            '<urn:s> <urn:p> "01"^^<http://www.w3.org/2001/XMLSchema#integer> .\n<urn:s> <urn:q> "</script>\\n\\\"private"@EN-us .';
        const decoded = restore(await complete(evidence(text))).contexts.get(NS + 'data') as Store;
        expect(decoded.getObjects(null, f.namedNode('urn:p'), null)[0]).toEqual(
            f.literal('01', f.namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        );
        expect(decoded.getObjects(null, f.namedNode('urn:q'), null)[0]).toEqual(
            f.literal('</script>\n"private', 'en-us'),
        );
        expect(await complete(evidence(text.replace('@EN-us', '@en-US')))).toEqual(await complete(evidence(text)));
        const first = await complete(evidence('<urn:s> <urn:p> <urn:same> .'));
        expect((await complete(evidence('<urn:s> <urn:p> "urn:same" .'))).rdf).not.toEqual(first.rdf);
    });

    it('keeps repeated isomorphic components separate', async () => {
        const first = await complete(evidence('_:q0 <urn:p> "value" .\n_:v0 <urn:p> "value" .'));
        expect(first.rdf.components.find((part) => part.nquads.includes('"value"'))?.multiplicity).toBe(2);
        expect(await complete(evidence('_:renamed <urn:p> "value" .\n_:other <urn:p> "value" .'))).toEqual(first);
        const decoded = restore(first).contexts.get(NS + 'data') as Store;
        expect(decoded.size).toBe(2);
        expect(new Set(decoded.getSubjects(null, null, null).map((subject) => subject.value)).size).toBe(2);
    });

    it('preserves repeated isomorphic blank graphs as distinct graph instances', async () => {
        const result = await complete(evidence('<urn:s> <urn:p> "same" _:a .\n<urn:s> <urn:p> "same" _:b .'));
        expect(result.rdf.components.find((part) => part.nquads.includes('"same"'))?.multiplicity).toBe(2);
        const data = restore(result).contexts.get(NS + 'data') as Store;
        expect(data.size).toBe(2);
        expect(data.getGraphs(null, null, null)).toHaveLength(2);
    });

    it('normalizes ten thousand ordinary assertions without generating statement blank nodes', async () => {
        const data = Array.from({ length: 10_000 }, (_, index) => `<urn:s${String(index)}> <urn:p> "value" .`).join(
            '\n',
        );
        const result = await complete(evidence(data));
        expect(result.quadCounts.data).toBe(10_000);
        expect(result.rdf.quadCount).toBe(10_005);
        expect(result.rdf.components.every((part) => !part.nquads.includes('_:'))).toBe(true);
    });

    it('does not change an unrelated component when another fact changes', async () => {
        const first = await complete(evidence('_:a <urn:p> "old" .\n_:b <urn:q> "stable" .'));
        const second = await complete(evidence('_:x <urn:p> "new" .\n_:y <urn:q> "stable" .'));
        const stable = first.rdf.components.find((part) => part.nquads.includes('"stable"'));
        expect(second.rdf.components).toContainEqual(stable);
    });

    it('binds report-root selection and preserves source metadata separately from RDF', async () => {
        const first = evidence(
            '',
            { shapes: '<urn:s> <urn:p> "shape" .' },
            '_:a <urn:tag> "a" .\n_:b <urn:tag> "b" .',
            { termType: 'BlankNode', value: 'a' },
        );
        const baseline = await complete(first);
        const otherRoot = {
            ...first,
            report: { ...first.report, root: { termType: 'BlankNode' as const, value: 'b' } },
        };
        expect((await complete(otherRoot)).rdf).not.toEqual(baseline.rdf);
        const changed = {
            ...first,
            shapes: first.shapes.map((source) => ({
                ...source,
                contentDigest: `sha256:${'b'.repeat(64)}`,
                owner: { role: 'dependency' as const, canonicalIri: 'urn:dependency' },
            })),
        };
        const result = await complete(changed);
        expect(result.rdf).toEqual(baseline.rdf);
        expect(result.sources).not.toEqual(baseline.sources);
        expect(Object.isFrozen(result.sources[0]?.owner)).toBe(true);
    });

    it('normalizes actual typed engine evidence with complex paths and shared result values', async () => {
        const text =
            '@prefix sh: <http://www.w3.org/ns/shacl#> . <urn:S> a sh:NodeShape; sh:targetNode <urn:item>; sh:property [ sh:path (<urn:p> <urn:q>); sh:nodeKind sh:IRI ] .';
        const captured = await Effect.runPromise(
            validateShaclWithEvidence(
                {
                    readBytes: () => Effect.succeed(new TextEncoder().encode(text)),
                    readText: () => Effect.succeed(text),
                    listFiles: () => Effect.succeed([]),
                },
                {
                    dataset: new Store(
                        new Parser({ blankNodePrefix: 'data_' }).parse(
                            '<urn:item> <urn:p> _:step . _:step <urn:q> "value" .',
                        ),
                    ),
                    sources: [],
                    provenance: [],
                },
                [
                    {
                        id: 'shapes',
                        owner: { role: 'root', canonicalIri: 'urn:owner', ownedIriPrefixes: ['urn:'] },
                        locator: '/private/shapes.ttl',
                        baseIri: 'urn:owner',
                        mediaType: 'text/turtle',
                    },
                ],
                true,
            ),
        );
        expect(captured.evidence?.kind).toBe('complete');
        const projection = await complete(captured.evidence as ShaclEvidenceComplete);
        expect(JSON.stringify(projection)).not.toContain('/private/');
        const decoded = restore(projection);
        const report = decoded.contexts.get(NS + 'report') as Store;
        const paths = report.getObjects(null, f.namedNode('http://www.w3.org/ns/shacl#resultPath'), null);
        expect(paths[0]?.termType).toBe('BlankNode');
        expect(
            report.getObjects(
                paths[0] as Quad['subject'],
                f.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#first'),
                null,
            )[0],
        ).toEqual(f.namedNode('urn:p'));
        expect(report.getObjects(null, f.namedNode('http://www.w3.org/ns/shacl#value'), null)).toContainEqual(
            f.literal('value'),
        );
    });

    it.each(['source-limit', 'statement-limit', 'term-limit', 'output-limit'] as const)(
        'preserves upstream capture summary %s',
        async (reason) => {
            expect(await normalizeShaclEvidence({ schema: 'erden.shacl-capture/v1', kind: 'summary', reason })).toEqual(
                { schema: 'erden.shacl-rdf/v1', kind: 'summary', stage: 'capture', reason },
            );
        },
    );

    it('bounds source count, raw statement occurrences, and duplicate source bytes', async () => {
        const source = evidence('', { s: '' }).shapes[0] as CapturedShapeSource;
        const selected = Array.from({ length: SHACL_RDF_LIMITS.maxSources }, (_, index) => ({
            ...source,
            sourceId: `s${String(index)}`,
        }));
        expect((await complete({ ...evidence(), shapes: selected })).sources).toHaveLength(SHACL_RDF_LIMITS.maxSources);
        expect(
            await normalizeShaclEvidence({
                ...evidence(),
                shapes: Array.from({ length: SHACL_RDF_LIMITS.maxSources + 1 }, () => source),
            }),
        ).toMatchObject({ kind: 'summary', stage: 'projection', reason: 'source-limit' });
        const quad = quads('<urn:s> <urn:p> "x" .')[0] as CapturedQuad;
        const data = Array.from({ length: SHACL_RDF_LIMITS.maxStatements - 1 }, () => quad);
        const report = { root: { termType: 'NamedNode' as const, value: 'urn:report' }, quads: [quad] };
        expect((await complete({ ...evidence(), data, report })).quadCounts).toEqual({ data: 1, shapes: 0, report: 1 });
        expect(
            await normalizeShaclEvidence({ ...evidence(), data, report: { ...report, quads: [quad, quad] } }),
        ).toMatchObject({ kind: 'summary', stage: 'projection', reason: 'statement-limit' });
        expect(
            await normalizeShaclEvidence({
                ...evidence(),
                data: Array.from({ length: SHACL_RDF_LIMITS.maxStatements + 1 }, () => quad),
            }),
        ).toMatchObject({ kind: 'summary', stage: 'projection', reason: 'statement-limit' });
        const large = {
            ...quad,
            object: {
                termType: 'Literal' as const,
                value: 'x'.repeat(RDF_COMPARISON_LIMITS.maxLiteralBytes),
                language: '',
                datatype: 'http://www.w3.org/2001/XMLSchema#string',
            },
        };
        expect(
            await normalizeShaclEvidence({ ...evidence(), data: Array.from({ length: 600 }, () => large) }),
        ).toMatchObject({ kind: 'summary', stage: 'projection', reason: 'input-limit' });
    });

    it('enforces exact encoded-byte limits before starting normalization', async () => {
        function fixture(length: number, extra = 0) {
            return evidence(
                Array.from(
                    { length: 512 },
                    (_, index) => `<urn:s${String(index)}> <urn:p> "${'x'.repeat(length + (index < extra ? 1 : 0))}" .`,
                ).join('\n'),
            );
        }
        const base = Buffer.byteLength(encodeShaclContexts(fixture(10_000), () => {}).nquads);
        const available = SHACL_RDF_LIMITS.maxEncodedBytes - base;
        const length = 10_000 + Math.floor(available / 512);
        const extra = available % 512;
        expect(length + 1).toBeLessThanOrEqual(RDF_COMPARISON_LIMITS.maxLiteralBytes);
        expect(Buffer.byteLength(encodeShaclContexts(fixture(length, extra), () => {}).nquads)).toBe(
            SHACL_RDF_LIMITS.maxEncodedBytes,
        );
        expect(await normalizeShaclEvidence(fixture(length, extra + 1))).toEqual({
            schema: 'erden.shacl-rdf/v1',
            kind: 'summary',
            stage: 'projection',
            reason: 'encoded-limit',
        });
    });

    it('counts original and generated blank nodes against the shared limit', async () => {
        const count = RDF_COMPARISON_LIMITS.maxBlankNodes / 2;
        const data = Array.from({ length: count }, (_, index) => `<urn:s> <urn:p> "x" _:b${String(index)} .`).join(
            '\n',
        );
        expect(encodeShaclContexts(evidence(data), () => {}).quadCounts.data).toBe(count);
        expect(await normalizeShaclEvidence(evidence(data + '\n<urn:s> <urn:p> "x" _:extra .'))).toEqual({
            schema: 'erden.shacl-rdf/v1',
            kind: 'summary',
            stage: 'normalization',
            reason: 'blank-node-limit',
        });
    });

    it('accepts the exact source-byte budget and refuses one byte more even for duplicate assertions', async () => {
        const count = 512;
        const datatype = 'http://www.w3.org/2001/XMLSchema#string';
        const overhead = Buffer.byteLength('urn:s' + 'urn:p' + datatype);
        const available = SHACL_RDF_LIMITS.maxSourceBytes - count * overhead - Buffer.byteLength('urn:report');
        const length = Math.floor(available / count);
        const extra = available % count;
        expect(length + 2).toBeLessThanOrEqual(RDF_COMPARISON_LIMITS.maxLiteralBytes);
        function fixture(extraByte: number): ShaclEvidenceComplete {
            return {
                ...evidence(),
                data: Array.from({ length: count }, (_, index) => ({
                    subject: { termType: 'NamedNode', value: 'urn:s' },
                    predicate: { termType: 'NamedNode', value: 'urn:p' },
                    object: {
                        termType: 'Literal',
                        value: 'x'.repeat(length + (index < extra ? 1 : 0) + (index === 0 ? extraByte : 0)),
                        language: '',
                        datatype,
                    },
                    graph: { termType: 'DefaultGraph' },
                })),
            };
        }
        expect((await complete(fixture(0))).quadCounts.data).toBe(2);
        expect(await normalizeShaclEvidence(fixture(1))).toEqual({
            schema: 'erden.shacl-rdf/v1',
            kind: 'summary',
            stage: 'projection',
            reason: 'input-limit',
        });
    });

    it('copies every source binding and report-root value before awaiting the worker', async () => {
        const owner = { role: 'root' as const, canonicalIri: 'urn:original' };
        const source = {
            sourceId: 'original',
            contentDigest: digest,
            owner,
            quads: quads('<urn:s> <urn:p> "original" .'),
        };
        const root = { termType: 'NamedNode' as const, value: 'urn:report' };
        const input = { ...evidence(), shapes: [source], report: { root, quads: [] } };
        const pending = normalizeShaclEvidence(input);
        source.sourceId = 'changed';
        source.contentDigest = `sha256:${'b'.repeat(64)}`;
        owner.canonicalIri = 'urn:changed';
        source.quads.length = 0;
        root.value = 'urn:changed';
        const result = await pending;
        expect(result.kind).toBe('complete');
        if (result.kind !== 'complete') {
            throw new Error('Expected complete projection');
        }
        expect(result.sources).toEqual([
            {
                sourceId: 'original',
                contentDigest: digest,
                owner: { role: 'root', canonicalIri: 'urn:original' },
                quadCount: 1,
            },
        ]);
        expect(restore(result).root).toEqual(f.namedNode('urn:report'));
        expect(result.quadCounts.shapes).toBe(1);
    });

    it.each(['iri', 'blank', 'language', 'source-id'] as const)('enforces exact %s term bounds', async (kind) => {
        function fixture(extra: string): ShaclEvidenceComplete {
            const quad = quads('<urn:s> <urn:p> "value" .')[0] as CapturedQuad;
            if (kind === 'iri') {
                return {
                    ...evidence(),
                    data: [
                        {
                            ...quad,
                            subject: {
                                termType: 'NamedNode',
                                value: 'urn:' + 'é'.repeat((RDF_COMPARISON_LIMITS.maxIriBytes - 4) / 2) + extra,
                            },
                        },
                    ],
                };
            }
            if (kind === 'blank') {
                return {
                    ...evidence(),
                    data: [
                        {
                            ...quad,
                            subject: {
                                termType: 'BlankNode',
                                value: 'b'.repeat(RDF_COMPARISON_LIMITS.maxBlankNodeBytes) + extra,
                            },
                        },
                    ],
                };
            }
            if (kind === 'language') {
                return {
                    ...evidence(),
                    data: [
                        {
                            ...quad,
                            object: {
                                termType: 'Literal',
                                value: 'text',
                                language: 'en-x-' + 'a-'.repeat(61) + 'b' + extra,
                                datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
                            },
                        },
                    ],
                };
            }
            return evidence('', { ['s' + '/'.repeat(1_023) + extra]: '' });
        }
        expect((await complete(fixture(''))).kind).toBe('complete');
        expect(await normalizeShaclEvidence(fixture('x'))).toMatchObject({
            kind: 'summary',
            stage: 'projection',
            reason: 'term-limit',
        });
    });

    it('discards oversized contextual components and combined output', async () => {
        const chain = Array.from({ length: 10_001 }, (_, index) => `_:b <urn:p> <urn:o${String(index)}> .`).join('\n');
        expect(await normalizeShaclEvidence(evidence(chain))).toMatchObject({
            kind: 'summary',
            stage: 'normalization',
            reason: 'component-limit',
        });
        const ownerIri = 'urn:' + 'x'.repeat(RDF_COMPARISON_LIMITS.maxIriBytes - 4);
        const sources = Array.from({ length: 1_000 }, (_, index) => ({
            sourceId: 's' + String(index),
            contentDigest: digest,
            owner: { role: 'root' as const, canonicalIri: ownerIri },
            quads: [],
        }));
        expect(await normalizeShaclEvidence({ ...evidence(), shapes: sources })).toEqual({
            schema: 'erden.shacl-rdf/v1',
            kind: 'summary',
            stage: 'projection',
            reason: 'output-limit',
        });
    });

    it('preserves canonicalization and normalized-output capacity summaries without partial evidence', async () => {
        const clique = readFileSync(new URL('./fixtures/rdf-canon/rdfc10/test074-in.nq', import.meta.url), 'utf8');
        expect(await normalizeShaclEvidence(evidence(clique))).toEqual({
            schema: 'erden.shacl-rdf/v1',
            kind: 'summary',
            stage: 'normalization',
            reason: 'canonicalization-limit',
        });
        const data = Array.from(
            { length: 400 },
            (_, index) => `<urn:s${String(index)}> <urn:p> "${'x'.repeat(12_000)}" .`,
        ).join('\n');
        expect(await normalizeShaclEvidence(evidence(data))).toEqual({
            schema: 'erden.shacl-rdf/v1',
            kind: 'summary',
            stage: 'normalization',
            reason: 'output-limit',
        });
    });

    it('enforces exact literal bounds and refuses malformed RDF term positions', async () => {
        const quad = quads('<urn:s> <urn:p> "x" .')[0] as CapturedQuad;
        const value = {
            termType: 'Literal' as const,
            value: 'x'.repeat(RDF_COMPARISON_LIMITS.maxLiteralBytes),
            language: '',
            datatype: 'http://www.w3.org/2001/XMLSchema#string',
        };
        expect((await complete({ ...evidence(), data: [{ ...quad, object: value }] })).quadCounts.data).toBe(1);
        expect(
            await normalizeShaclEvidence({
                ...evidence(),
                data: [{ ...quad, object: { ...value, value: value.value + 'x' } }],
            }),
        ).toMatchObject({ kind: 'summary', reason: 'term-limit' });
        for (const invalid of [
            { ...quad, subject: value },
            { ...quad, predicate: { termType: 'BlankNode', value: 'p' } },
            { ...quad, graph: { termType: 'DefaultGraph', value: 'lost-value' } },
            { ...quad, object: { ...value, direction: 'ltr' } },
            { ...quad, object: { ...value, language: 'en' } },
            { ...quad, object: { termType: 'NamedNode', value: 'relative' } },
        ]) {
            await expect(
                normalizeShaclEvidence({ ...evidence(), data: [invalid] } as ShaclEvidence),
            ).rejects.toMatchObject({ code: 'RDF_COMPARISON_INPUT_INVALID' });
        }
    });

    it('rejects extra fields, duplicate source identities, sparse arrays, and accessors without invoking them', async () => {
        const source = evidence('', { s: '' }).shapes[0];
        const getter = vi.fn(() => 'private-secret');
        const accessor = Object.defineProperty(evidence(), 'schema', { enumerable: true, get: getter });
        const invalid: unknown[] = [
            { ...evidence(), extra: true },
            { ...evidence(), schema: 'unknown' },
            { ...evidence(), shapes: [source, source] },
            { ...evidence(), data: new Array(1) },
            accessor,
            { ...evidence(), shapes: [{ ...source, contentDigest: 'wrong' }] },
            { ...evidence(), report: { root: { termType: 'NamedNode', value: 'urn:r' }, quads: [], extra: 'lost' } },
        ];
        for (const input of invalid) {
            await expect(normalizeShaclEvidence(input as ShaclEvidence)).rejects.toMatchObject({
                code: 'RDF_COMPARISON_INPUT_INVALID',
                message: 'The RDF comparison input is invalid',
            });
        }
        expect(getter).not.toHaveBeenCalled();
    });

    it('shares cancellation and concurrency admission with the ordinary RDF normalizer', async () => {
        const signals = [new AbortController(), new AbortController()];
        const first = normalizeShaclEvidence(evidence(), signals[0]?.signal);
        const second = normalizeRdfComparison('', signals[1]?.signal);
        await expect(normalizeShaclEvidence(evidence())).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
        for (const signal of signals) {
            signal.abort('private-reason');
        }
        const settled = await Promise.allSettled([first, second]);
        expect(
            settled.every(
                (item) =>
                    item.status === 'rejected' && (item.reason as { code: string }).code === 'RDF_COMPARISON_CANCELLED',
            ),
        ).toBe(true);
        expect((await complete(evidence())).kind).toBe('complete');
        await expect(
            normalizeShaclEvidence(
                { schema: 'erden.shacl-capture/v1', kind: 'summary', reason: 'source-limit' },
                AbortSignal.abort('private-reason'),
            ),
        ).rejects.toMatchObject({ code: 'RDF_COMPARISON_CANCELLED' });
    });

    it('includes encoding time in the fixed deadline and never persists timeout as capacity', async () => {
        for (const input of [evidence(), { ...evidence(), shapes: new Array(SHACL_RDF_LIMITS.maxSources + 1) }]) {
            const now = vi
                .spyOn(performance, 'now')
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(0)
                .mockReturnValue(RDF_COMPARISON_LIMITS.maxMilliseconds + 1);
            try {
                await expect(normalizeShaclEvidence(input)).rejects.toMatchObject({
                    code: 'RDF_COMPARISON_UNAVAILABLE',
                });
            } finally {
                now.mockRestore();
            }
        }
    });
});
