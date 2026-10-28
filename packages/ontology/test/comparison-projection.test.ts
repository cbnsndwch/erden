import { DataFactory as f, Parser, Store, Writer, type Quad, type Term } from 'n3';
import { describe, expect, it } from 'vitest';

import {
    normalizeCapturedRdf,
    normalizeCapturedRdfContexts,
    normalizeRdfComparison,
    normalizeShaclOutcomes,
    RDF_COMPARISON_LIMITS,
    type CapturedQuad,
    type CapturedResource,
    type ShaclEvidenceComplete,
    type ShaclSelfTestEvidence,
    type RdfComparisonComplete,
} from '../src/index.js';

function term(value: Term): CapturedQuad['object'] | CapturedQuad['graph'] {
    if (value.termType === 'NamedNode' || value.termType === 'BlankNode') {
        return { termType: value.termType, value: value.value };
    }
    if (value.termType === 'DefaultGraph') {
        return { termType: 'DefaultGraph' };
    }
    if (value.termType === 'Literal') {
        return { termType: 'Literal', value: value.value, language: value.language, datatype: value.datatype.value };
    }
    throw new Error('Invalid fixture');
}
function quads(text: string): CapturedQuad[] {
    return new Parser({ format: 'N-Quads', blankNodePrefix: '' }).parse(text).map((quad) => ({
        subject: term(quad.subject) as CapturedResource,
        predicate: { termType: 'NamedNode', value: quad.predicate.value },
        object: term(quad.object) as CapturedQuad['object'],
        graph: term(quad.graph) as CapturedQuad['graph'],
    }));
}
function restoreContexts(rdf: RdfComparisonComplete) {
    const encoded = new Store();
    for (const [index, component] of rdf.components.entries()) {
        for (let instance = 0; instance < component.multiplicity; instance += 1) {
            encoded.addQuads(
                new Parser({ format: 'N-Quads', blankNodePrefix: `c${String(index)}i${String(instance)}_` }).parse(
                    component.nquads,
                ),
            );
        }
    }
    const ns = 'urn:erden:rdf-context:v1:';
    const contexts = new Map<string, Store>();
    for (const entry of encoded.getQuads(null, f.namedNode(ns + 'id'), null, f.defaultGraph())) {
        contexts.set(entry.object.value, new Store());
    }
    for (const quad of encoded.getQuads(null, null, null, null)) {
        if (quad.graph.termType === 'DefaultGraph') {
            continue;
        }
        const context = encoded.getObjects(quad.graph, f.namedNode(ns + 'context'), f.defaultGraph())[0];
        if (context === undefined) {
            throw new Error('Missing graph mapping');
        }
        const id = encoded.getObjects(context, f.namedNode(ns + 'id'), f.defaultGraph())[0]?.value;
        const graph =
            encoded.getObjects(quad.graph, f.namedNode(ns + 'graph'), f.defaultGraph())[0] ?? f.defaultGraph();
        if (id === undefined) {
            throw new Error('Missing context identity');
        }
        contexts.get(id)?.addQuad(quad.subject, quad.predicate, quad.object, graph as Quad['graph']);
    }
    return contexts;
}
function evidence(data = '', shape = '', report = '', label = 'shape'): ShaclEvidenceComplete {
    return {
        schema: 'erden.shacl-capture/v1',
        kind: 'complete',
        data: quads(data),
        shapes: [
            {
                sourceId: 'source:one',
                contentDigest: `sha256:${'a'.repeat(64)}`,
                owner: { role: 'root', canonicalIri: 'urn:owner' },
                quads: quads(shape),
            },
        ],
        report: {
            root: { termType: 'BlankNode', value: 'report' },
            quads: quads(report || `_:report <urn:shape> _:${label} .`),
        },
    };
}
function tests(label = 'shape', fired = true): ShaclSelfTestEvidence {
    return {
        schema: 'erden.shacl-self-tests/v1',
        kind: 'complete',
        results: [{ shape: { termType: 'BlankNode', value: label }, fired }],
    };
}

describe('typed canonical RDF projection', () => {
    it('matches the qualified N-Quads normalizer and preserves lexical, language, and graph distinctions', async () => {
        const text =
            '_:a <urn:p> "01"^^<http://www.w3.org/2001/XMLSchema#integer> _:g .\n_:a <urn:q> "word"@en <urn:graph> .\n_:g <urn:p> _:a .';
        expect(await normalizeCapturedRdf(quads(text))).toEqual(await normalizeRdfComparison(text));
        expect(
            await normalizeCapturedRdf(quads(text.replaceAll('_:a', '_:renamed').replaceAll('_:g', '_:graph'))),
        ).toEqual(await normalizeCapturedRdf(quads(text)));
    });

    it('independently reconstructs contexts, shared blank links, graph identities, empty contexts, and repeated structures', async () => {
        const first =
            '_:shared <urn:p> "one" _:g .\n_:g <urn:p> _:shared .\n_:x <urn:repeat> "same" .\n_:y <urn:repeat> "same" .';
        const second =
            '_:shared <urn:q> "two" <urn:named> .\n<urn:erden:rdf-context:v1:context:a> <urn:erden:rdf-context:v1:id> "inert" .';
        const result = await normalizeCapturedRdfContexts([
            { id: 'a', quads: quads(first) },
            { id: 'b', quads: quads(second) },
            { id: 'empty', quads: [] },
        ]);
        expect(result.kind).toBe('complete');
        if (result.kind !== 'complete') {
            throw new Error('Missing projection');
        }
        const restored = restoreContexts(result);
        const writer = new Writer({ format: 'N-Quads' });
        expect(
            await normalizeRdfComparison(
                writer.quadsToString(restored.get('a')?.getQuads(null, null, null, null) ?? []),
            ),
        ).toEqual(await normalizeRdfComparison(first));
        expect(
            await normalizeRdfComparison(
                writer.quadsToString(restored.get('b')?.getQuads(null, null, null, null) ?? []),
            ),
        ).toEqual(await normalizeRdfComparison(second));
        expect(restored.get('empty')?.size).toBe(0);
        expect(restored.get('a')?.getSubjects(f.namedNode('urn:p'), f.literal('one'), null)[0]).toEqual(
            restored.get('b')?.getSubjects(f.namedNode('urn:q'), f.literal('two'), null)[0],
        );
        expect(
            await normalizeCapturedRdfContexts([
                { id: 'empty', quads: [] },
                { id: 'b', quads: quads(second) },
                { id: 'a', quads: quads(first) },
            ]),
        ).toEqual(result);
    });

    it('copies terms before the worker can observe caller mutation', async () => {
        const input = quads('<urn:s> <urn:p> "original" .');
        const pending = normalizeCapturedRdf(input);
        input.splice(0, input.length, ...quads('<urn:s> <urn:p> "changed" .'));
        expect(await pending).toEqual(await normalizeRdfComparison('<urn:s> <urn:p> "original" .'));
    });

    it('keeps repeated component multiplicities and rejects unsupported terms or malformed contexts', async () => {
        const result = await normalizeCapturedRdf(quads('_:a <urn:p> "same" .\n_:b <urn:p> "same" .'));
        expect(result).toMatchObject({ kind: 'complete', components: [{ multiplicity: 2 }] });
        await expect(
            normalizeCapturedRdfContexts([
                { id: 'a', quads: [] },
                { id: 'a', quads: [] },
            ]),
        ).rejects.toMatchObject({ code: 'RDF_COMPARISON_INPUT_INVALID' });
        const input = quads('<urn:s> <urn:p> "value" .');
        Object.defineProperty(input, '0', {
            get: () => {
                throw new Error('secret');
            },
        });
        await expect(normalizeCapturedRdf(input)).rejects.toMatchObject({ code: 'RDF_COMPARISON_INPUT_INVALID' });
    });

    it('applies typed term and occurrence limits and respects pre-cancellation', async () => {
        const row = quads('<urn:s> <urn:p> "value" .')[0] as CapturedQuad;
        expect(
            await normalizeCapturedRdf(Array.from({ length: RDF_COMPARISON_LIMITS.maxStatements + 1 }, () => row)),
        ).toMatchObject({ kind: 'summary', reason: 'statement-limit' });
        expect(
            await normalizeCapturedRdf(
                quads(`<urn:s> <urn:p> "${'a'.repeat(RDF_COMPARISON_LIMITS.maxLiteralBytes + 1)}" .`),
            ),
        ).toMatchObject({ kind: 'summary', reason: 'term-limit' });
        const controller = new AbortController();
        controller.abort();
        await expect(normalizeCapturedRdf([], controller.signal)).rejects.toMatchObject({
            code: 'RDF_COMPARISON_CANCELLED',
        });
    });
});

describe('canonical SHACL outcome context', () => {
    it('ignores unrelated data and named definitions while retaining the identifying blank-node closure', async () => {
        const source = evidence(
            '_:focus <urn:p> _:next .\n_:next <urn:value> "identity" .\n<urn:unrelated> <urn:p> "old" .',
            '_:shape <urn:path> <urn:p> .\n<urn:unused> <urn:value> "old" .',
            '_:report <urn:focus> _:focus .\n_:report <urn:shape> _:shape .',
        );
        const first = await normalizeShaclOutcomes(source, tests());
        const unrelated = {
            ...source,
            data: [...source.data, ...quads('<urn:extra> <urn:p> "new" .')],
            shapes: source.shapes.map((shape) => ({
                ...shape,
                quads: [...shape.quads, ...quads('<urn:other> <urn:p> "new" .')],
            })),
        };
        expect(await normalizeShaclOutcomes(unrelated, tests())).toEqual(first);
        const changed = { ...source, data: quads('_:focus <urn:p> _:next .\n_:next <urn:value> "different" .') };
        expect(await normalizeShaclOutcomes(changed, tests())).not.toEqual(first);
    });

    it('ignores source moves and blank relabeling without losing typed self-test outcomes', async () => {
        const source = evidence('', '_:shape <urn:path> <urn:p> .');
        const first = await normalizeShaclOutcomes(source, tests());
        const moved = evidence('', '_:other <urn:path> <urn:p> .', '_:report <urn:shape> _:other .', 'other');
        const shape = moved.shapes[0];
        if (shape === undefined) {
            throw new Error('Missing shape');
        }
        expect(
            await normalizeShaclOutcomes(
                {
                    ...moved,
                    shapes: [{ ...shape, sourceId: 'moved:source', contentDigest: `sha256:${'b'.repeat(64)}` }],
                },
                tests('other'),
            ),
        ).toEqual(first);
        expect(await normalizeShaclOutcomes(source, tests('shape', false))).not.toEqual(first);
    });

    it('distinguishes literal/IRI report values and a changed selected report root', async () => {
        const first = evidence('', '', '_:report <urn:value> <urn:same> .');
        const empty: ShaclSelfTestEvidence = { schema: 'erden.shacl-self-tests/v1', kind: 'complete', results: [] };
        expect(await normalizeShaclOutcomes(first, empty)).not.toEqual(
            await normalizeShaclOutcomes(evidence('', '', '_:report <urn:value> "urn:same" .'), empty),
        );
        expect(await normalizeShaclOutcomes(first, empty)).not.toEqual(
            await normalizeShaclOutcomes(
                { ...first, report: { ...first.report, root: { termType: 'NamedNode', value: 'urn:other' } } },
                empty,
            ),
        );
    });

    it('rejects malformed unused data and duplicate typed self-tests; summaries remain explicit', async () => {
        const source = evidence('<urn:unrelated> <urn:p> "value" .');
        const row = source.data[0] as CapturedQuad;
        const malformed = {
            ...source,
            data: [{ ...row, predicate: { termType: 'Literal', value: 'secret' } }],
        } as unknown as ShaclEvidenceComplete;
        await expect(normalizeShaclOutcomes(malformed, tests())).rejects.toMatchObject({
            code: 'RDF_COMPARISON_INPUT_INVALID',
        });
        const repeated = tests();
        if (repeated.kind !== 'complete') {
            throw new Error('Missing tests');
        }
        await expect(
            normalizeShaclOutcomes(source, { ...repeated, results: [...repeated.results, ...repeated.results] }),
        ).rejects.toMatchObject({ code: 'RDF_COMPARISON_INPUT_INVALID' });
        expect(
            await normalizeShaclOutcomes(source, {
                schema: 'erden.shacl-self-tests/v1',
                kind: 'summary',
                reason: 'source-limit',
            }),
        ).toMatchObject({ kind: 'summary', stage: 'self-tests', reason: 'source-limit' });
    });
});
