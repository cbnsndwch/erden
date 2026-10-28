import { createHash } from 'node:crypto';

import { Effect } from 'effect';
import { DataFactory, Parser, Store, type Quad, type Term } from 'n3';
import { describe, expect, it, vi } from 'vitest';

import {
    captureShaclEvidence,
    captureShaclSelfTests,
    makeOntologyService,
    ResourceAccessError,
    SHACL_EVIDENCE_LIMITS,
    validateShaclWithEvidence,
    type AssembledOntology,
    type CapturedQuad,
    type CaptureShaclEvidenceInput,
    type ProjectSourceOwner,
    type ShaclEvidenceComplete,
    type ShapeSourceDescriptor,
    type TextResourcePort,
} from '../src/index.js';

const owner: ProjectSourceOwner = { role: 'root', canonicalIri: 'urn:root', ownedIriPrefixes: ['urn:root:'] };
const source: ShapeSourceDescriptor = {
    id: 'root:shapes:0',
    locator: '/private/shape-source.ttl',
    owner,
    baseIri: 'urn:root',
    mediaType: 'text/turtle',
};
const prefixes =
    '@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> . @prefix ex: <urn:root:> .\n';

function resources(text: string) {
    const readBytes = vi.fn((locator: string) =>
        locator === source.locator
            ? Effect.succeed(new TextEncoder().encode(text))
            : Effect.fail(new ResourceAccessError(locator, 'missing fixture')),
    );
    const port: TextResourcePort = {
        readBytes,
        readText: () => Effect.succeed(text),
        listFiles: () => Effect.succeed([]),
    };
    return { port, readBytes };
}
function graph(text: string): AssembledOntology {
    return {
        dataset: new Store(new Parser({ format: 'Turtle', blankNodePrefix: 'data_' }).parse(prefixes + text)),
        sources: [],
        provenance: [],
    };
}
function complete(input: unknown): ShaclEvidenceComplete {
    expect(input).toMatchObject({ schema: 'erden.shacl-capture/v1', kind: 'complete' });
    return input as ShaclEvidenceComplete;
}
function term(value: CapturedQuad['object'] | CapturedQuad['graph']): Term {
    switch (value.termType) {
        case 'NamedNode':
            return DataFactory.namedNode(value.value);
        case 'BlankNode':
            return DataFactory.blankNode(value.value);
        case 'DefaultGraph':
            return DataFactory.defaultGraph();
        case 'Literal':
            return DataFactory.literal(value.value, value.language || DataFactory.namedNode(value.datatype));
    }
}
function dataset(quads: ReadonlyArray<CapturedQuad>): Store {
    return new Store(
        quads.map((quad) =>
            DataFactory.quad(
                term(quad.subject) as Quad['subject'],
                DataFactory.namedNode(quad.predicate.value),
                term(quad.object) as Quad['object'],
                term(quad.graph) as Quad['graph'],
            ),
        ),
    );
}

async function validate(data: AssembledOntology, text: string) {
    const memory = resources(prefixes + text);
    const result = await Effect.runPromise(validateShaclWithEvidence(memory.port, data, [source], true));
    expect(memory.readBytes).toHaveBeenCalledTimes(1);
    const evidence = complete(result.evidence);
    expect(evidence.shapes[0]?.contentDigest).toBe(
        `sha256:${createHash('sha256')
            .update(prefixes + text)
            .digest('hex')}`,
    );
    expect(JSON.stringify(evidence)).not.toContain('/private/');
    return { ...result, evidence };
}

describe('typed SHACL evidence from the actual validation run', () => {
    it('preserves literal lexical forms, datatypes, language tags, and sequence paths', async () => {
        const data = graph('ex:item ex:p _:step . _:step ex:q "01", "hello"@fr .');
        const { validation, evidence } = await validate(
            data,
            'ex:S a sh:NodeShape; sh:targetNode ex:item; sh:property [ sh:path (ex:p ex:q); sh:datatype xsd:integer; sh:message "need integer"@en, "entier"@fr ] .',
        );
        expect(validation?.conforms).toBe(false);
        const report = dataset(evidence.report.quads);
        const values = report.getObjects(null, DataFactory.namedNode('http://www.w3.org/ns/shacl#value'), null);
        expect(values.map((value) => [value.value, value.termType === 'Literal' ? value.language : null])).toEqual(
            expect.arrayContaining([
                ['01', ''],
                ['hello', 'fr'],
            ]),
        );
        const paths = report.getObjects(null, DataFactory.namedNode('http://www.w3.org/ns/shacl#resultPath'), null);
        expect(paths[0]?.termType).toBe('BlankNode');
        expect(
            report.getObjects(
                paths[0] as Quad['subject'],
                DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#first'),
                null,
            )[0]?.value,
        ).toBe('urn:root:p');
        expect(evidence.shapes[0]?.owner).toEqual({ role: 'root', canonicalIri: 'urn:root' });
        expect(dataset(evidence.data).size).toBe(data.dataset.size);
    });

    it('distinguishes IRI and literal focus nodes with identical displayed values', async () => {
        const { evidence } = await validate(
            graph(''),
            'ex:S a sh:NodeShape; sh:targetNode <urn:same>, "urn:same"; sh:nodeKind sh:BlankNode .',
        );
        const focus = dataset(evidence.report.quads).getObjects(
            null,
            DataFactory.namedNode('http://www.w3.org/ns/shacl#focusNode'),
            null,
        );
        expect(focus.map((value) => [value.termType, value.value])).toEqual(
            expect.arrayContaining([
                ['NamedNode', 'urn:same'],
                ['Literal', 'urn:same'],
            ]),
        );
    });

    it('retains blank-node links between data, shape definitions, and the report', async () => {
        const { evidence } = await validate(
            graph('_:item ex:p "value" .'),
            '[] a sh:NodeShape; sh:targetSubjectsOf ex:p; sh:class ex:Required .',
        );
        const report = dataset(evidence.report.quads);
        const focus = report.getObjects(null, DataFactory.namedNode('http://www.w3.org/ns/shacl#focusNode'), null)[0];
        expect(focus?.termType).toBe('BlankNode');
        expect(dataset(evidence.data).countQuads(focus as Quad['subject'], null, null, null)).toBe(1);
        const shape = report.getObjects(null, DataFactory.namedNode('http://www.w3.org/ns/shacl#sourceShape'), null)[0];
        expect(shape?.termType).toBe('BlankNode');
        expect(
            dataset(evidence.shapes[0]?.quads ?? []).countQuads(shape as Quad['subject'], null, null, null),
        ).toBeGreaterThan(0);
    });

    it('copies evidence immutably and preserves named graph identities', async () => {
        const data = graph('ex:item ex:p "original" .');
        data.dataset.addQuad(
            DataFactory.namedNode('urn:s'),
            DataFactory.namedNode('urn:p'),
            DataFactory.literal('named'),
            DataFactory.namedNode('urn:g'),
        );
        const { evidence } = await validate(data, 'ex:S a sh:NodeShape; sh:targetNode ex:item; sh:nodeKind sh:IRI .');
        const encoded = JSON.stringify(evidence);
        data.dataset.removeQuads(data.dataset.getQuads(null, null, null, null));
        expect(JSON.stringify(evidence)).toBe(encoded);
        expect(dataset(evidence.data).countQuads(null, null, null, DataFactory.namedNode('urn:g'))).toBe(1);
        expect(Object.isFrozen(evidence.data[0]?.object)).toBe(true);
        expect(Object.isFrozen(evidence.shapes[0]?.quads)).toBe(true);
    });

    it('captures the data actually supplied to the engine when the caller later changes its store', async () => {
        const data = graph('ex:item ex:p "validated" .');
        const read = data.dataset.getQuads.bind(data.dataset);
        vi.spyOn(data.dataset, 'getQuads').mockImplementationOnce((...args) => {
            const quads = read(...args);
            queueMicrotask(() => {
                data.dataset.removeQuads(read(null, null, null, null));
            });
            return quads;
        });
        const { evidence } = await validate(data, 'ex:S a sh:NodeShape; sh:targetNode ex:item; sh:nodeKind sh:IRI .');
        expect(data.dataset.size).toBe(0);
        expect(dataset(evidence.data).getObjects(null, null, null)[0]?.value).toBe('validated');
    });

    it('keeps ordinary validation output unchanged and captures only when requested', async () => {
        const memory = resources(prefixes + 'ex:S a sh:NodeShape; sh:targetNode ex:item; sh:nodeKind sh:IRI .');
        const service = makeOntologyService({
            resources: memory.port,
            citationFiles: { exists: () => Effect.succeed(false) },
        });
        const data = graph('ex:item ex:p "value" .');
        const input = {
            shapeSources: [source],
            competencyQuestions: [],
            shacl: { required: true },
            cq: { required: false },
        };
        const ordinary = await Effect.runPromise(service.validateAssembled(data, input));
        expect(ordinary).not.toHaveProperty('shaclEvidence');
        const captured = await Effect.runPromise(
            service.validateAssembled(data, { ...input, captureShaclEvidence: true }),
        );
        const { shaclEvidence, shaclSelfTestEvidence, ...withoutEvidence } = captured;
        expect(shaclSelfTestEvidence?.kind).toBe('complete');
        expect(withoutEvidence).toEqual(ordinary);
        complete(shaclEvidence);
        expect(memory.readBytes).toHaveBeenCalledTimes(2);
    });

    it('represents skipped SHACL separately from an executed empty report', async () => {
        const skipped = await Effect.runPromise(validateShaclWithEvidence(resources('').port, graph(''), [], false));
        expect(skipped).toEqual({ validation: null, evidence: null, selfTestEvidence: null });
        const executed = await validate(graph(''), 'ex:S a sh:NodeShape; sh:nodeKind sh:IRI .');
        expect(executed.evidence.report.quads.length).toBeGreaterThan(0);
        expect(executed.validation?.findings).toEqual([]);
    });

    it('handles null paths in ordinary node-level validation findings', async () => {
        const memory = resources(prefixes + 'ex:S a sh:NodeShape; sh:targetNode ex:item; sh:nodeKind sh:BlankNode .');
        const service = makeOntologyService({
            resources: memory.port,
            citationFiles: { exists: () => Effect.succeed(false) },
        });
        const validation = await Effect.runPromise(service.shacl(graph(''), [source], true));
        expect(validation?.conforms).toBe(false);
        expect(validation?.findings[0]).toMatchObject({ focus: 'urn:root:item', path: null, severity: 'Violation' });
    });

    it('uses the same byte-backed source and refuses digest drift before capture', async () => {
        const text = prefixes + 'ex:S a sh:NodeShape; sh:targetNode ex:item; sh:nodeKind sh:IRI .';
        const loaded = {
            ...source,
            text,
            bytes: new TextEncoder().encode(text),
            contentDigest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        };
        const memory = resources('must not be read');
        const captured = await Effect.runPromise(validateShaclWithEvidence(memory.port, graph(''), [loaded], true));
        expect(complete(captured.evidence).shapes[0]?.contentDigest).toBe(loaded.contentDigest);
        expect(memory.readBytes).not.toHaveBeenCalled();
        loaded.bytes[0] = 0x20;
        await expect(
            Effect.runPromise(validateShaclWithEvidence(memory.port, graph(''), [loaded], true)),
        ).rejects.toThrow();
        expect(memory.readBytes).not.toHaveBeenCalled();
    });
});

function raw(): CaptureShaclEvidenceInput {
    return { data: [], shapes: [], report: { term: DataFactory.blankNode('report'), dataset: [] } };
}
function* repeated(count: number, value = 'x'): Iterable<Quad> {
    const quad = DataFactory.quad(
        DataFactory.namedNode('urn:s'),
        DataFactory.namedNode('urn:p'),
        DataFactory.literal(value),
    );
    for (let index = 0; index < count; index += 1) {
        yield quad;
    }
}

describe('typed SHACL capture bounds and failure behavior', () => {
    it('shares the statement budget across data, shapes, and report evidence', () => {
        const input = raw();
        const shape = {
            descriptor: { id: 'shape', owner },
            contentDigest: `sha256:${'a'.repeat(64)}`,
            quads: repeated(1),
        };
        const accepted = captureShaclEvidence({
            ...input,
            data: repeated(SHACL_EVIDENCE_LIMITS.maxStatements - 2),
            shapes: [shape],
            report: { ...input.report, dataset: repeated(1) },
        });
        expect(complete(accepted).report.quads).toHaveLength(1);
        const exhausted = captureShaclEvidence({
            ...input,
            data: repeated(SHACL_EVIDENCE_LIMITS.maxStatements - 2),
            shapes: [{ ...shape, quads: repeated(1) }],
            report: { ...input.report, dataset: repeated(2) },
        });
        expect(exhausted).toEqual({ schema: 'erden.shacl-capture/v1', kind: 'summary', reason: 'statement-limit' });
    });

    it('discards all partial facts at statement and byte capacity', () => {
        expect(captureShaclEvidence({ ...raw(), data: repeated(SHACL_EVIDENCE_LIMITS.maxStatements + 1) })).toEqual({
            schema: 'erden.shacl-capture/v1',
            kind: 'summary',
            reason: 'statement-limit',
        });
        expect(captureShaclEvidence({ ...raw(), data: repeated(600, 'x'.repeat(16_000)) })).toEqual({
            schema: 'erden.shacl-capture/v1',
            kind: 'summary',
            reason: 'output-limit',
        });
    });
    it('bounds source inventory and individual terms', () => {
        const shape = { descriptor: { id: 'shape', owner }, contentDigest: `sha256:${'a'.repeat(64)}`, quads: [] };
        expect(
            captureShaclEvidence({
                ...raw(),
                shapes: Array.from({ length: SHACL_EVIDENCE_LIMITS.maxSources + 1 }, () => shape),
            }),
        ).toMatchObject({ kind: 'summary', reason: 'source-limit' });
        expect(captureShaclEvidence({ ...raw(), data: repeated(1, 'x'.repeat(16_385)) })).toMatchObject({
            kind: 'summary',
            reason: 'term-limit',
        });
    });
    it('rejects blank-node scope collisions and redacts unexpected iterator failures', () => {
        const conflicting = DataFactory.quad(
            DataFactory.blankNode('report'),
            DataFactory.namedNode('urn:p'),
            DataFactory.literal('private'),
        );
        expect(() => captureShaclEvidence({ ...raw(), data: [conflicting] })).toThrow(
            'The typed SHACL evidence is invalid',
        );
        function* failing(): Iterable<Quad> {
            throw new Error('private engine detail');
        }
        expect(() => captureShaclEvidence({ ...raw(), data: failing() })).toThrow(
            'The typed SHACL evidence is invalid',
        );
    });
    it('rejects duplicate source IDs and invalid source digests', () => {
        const shape = { descriptor: { id: 'shape', owner }, contentDigest: `sha256:${'a'.repeat(64)}`, quads: [] };
        expect(() => captureShaclEvidence({ ...raw(), shapes: [shape, shape] })).toThrow(
            'The typed SHACL evidence is invalid',
        );
        expect(() => captureShaclEvidence({ ...raw(), shapes: [{ ...shape, contentDigest: 'private' }] })).toThrow(
            'The typed SHACL evidence is invalid',
        );
    });
    it('rejects variables and malformed RDF terms instead of flattening them', () => {
        const ordinary = [...repeated(1)][0] as Quad;
        const plain = {
            subject: ordinary.subject,
            predicate: ordinary.predicate,
            object: ordinary.object,
            graph: ordinary.graph,
        };
        const invalid = { ...plain, subject: DataFactory.variable('private') } as unknown as Quad;
        expect(() => captureShaclEvidence({ ...raw(), data: [invalid] })).toThrow(
            'The typed SHACL evidence is invalid',
        );
        const graph = { ...plain, graph: { termType: 'DefaultGraph', value: 'private' } } as unknown as Quad;
        expect(() => captureShaclEvidence({ ...raw(), data: [graph] })).toThrow('The typed SHACL evidence is invalid');
    });
});

describe('typed SHACL self-test outcomes', () => {
    it('links named and blank self-test shapes to the exact captured shape dataset', async () => {
        const result = await validate(
            graph(''),
            `
            ex:S a sh:NodeShape; sh:targetClass ex:C; sh:class ex:Required .
            [] a sh:NodeShape; sh:targetClass ex:D; sh:class ex:Required .
        `,
        );
        const outcomes = result.selfTestEvidence;
        expect(outcomes?.kind).toBe('complete');
        if (outcomes?.kind !== 'complete') {
            throw new Error('missing outcomes');
        }
        expect(outcomes.results.map((item) => item.shape.termType).sort()).toEqual(['BlankNode', 'NamedNode']);
        for (const item of outcomes.results) {
            expect(item.fired).toBe(true);
            expect(
                result.evidence.shapes[0]?.quads.some(
                    (quad) => quad.subject.termType === item.shape.termType && quad.subject.value === item.shape.value,
                ),
            ).toBe(true);
            expect(Object.isFrozen(item.shape)).toBe(true);
        }
    });

    it('records unfired outcomes without reinterpreting displayed strings', async () => {
        const result = await validate(graph(''), 'ex:S a sh:NodeShape; sh:nodeKind sh:IRI .');
        expect(result.selfTestEvidence).toEqual({
            schema: 'erden.shacl-self-tests/v1',
            kind: 'complete',
            results: [{ shape: { termType: 'NamedNode', value: 'urn:root:S' }, fired: false }],
        });
    });

    it('copies input terms and distinguishes identical labels with different RDF kinds', () => {
        const term = { termType: 'BlankNode', value: 'urn:same' };
        const result = captureShaclSelfTests([
            { term, fired: true },
            { term: { termType: 'NamedNode', value: 'urn:same' }, fired: false },
        ]);
        term.value = 'mutated';
        expect(result.kind).toBe('complete');
        if (result.kind !== 'complete') {
            throw new Error('missing outcomes');
        }
        expect(result.results.map((item) => item.shape)).toEqual([
            { termType: 'BlankNode', value: 'urn:same' },
            { termType: 'NamedNode', value: 'urn:same' },
        ]);
    });

    it('summarizes excessive self-test counts and terms without partial outcomes', () => {
        const row = { term: { termType: 'BlankNode', value: 'a' }, fired: true };
        expect(captureShaclSelfTests(Array.from({ length: SHACL_EVIDENCE_LIMITS.maxSources }, () => row)).kind).toBe(
            'complete',
        );
        expect(captureShaclSelfTests(Array.from({ length: SHACL_EVIDENCE_LIMITS.maxSources + 1 }, () => row))).toEqual({
            schema: 'erden.shacl-self-tests/v1',
            kind: 'summary',
            reason: 'source-limit',
        });
        expect(
            captureShaclSelfTests([{ term: { termType: 'BlankNode', value: 'x'.repeat(513) }, fired: true }]),
        ).toEqual({ schema: 'erden.shacl-self-tests/v1', kind: 'summary', reason: 'term-limit' });
    });
});
