import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
    assembleOntology,
    OntologyAssemblyLimitError,
    parseTurtleSource,
    type OntologyAssemblyLimits,
    type TurtleSourceDescriptor,
} from '../src/index.js';

function descriptor(index: number): TurtleSourceDescriptor {
    return {
        id: `source-${String(index)}`,
        locator: `/source-${String(index)}.ttl`,
        baseIri: 'https://example.test/ontology',
        mediaType: 'text/turtle',
        provenance: { _tag: 'Asserted' },
        owner: {
            canonicalIri: 'https://example.test/ontology',
            ownedIriPrefixes: ['https://example.test/ontology#'],
            role: 'root',
        },
    };
}

function assemble(texts: ReadonlyArray<string>, limits?: OntologyAssemblyLimits) {
    const sources = texts.map((_, index) => descriptor(index));
    const bytes = new Map(sources.map((source, index) => [source.locator, new TextEncoder().encode(texts[index])]));
    return assembleOntology(
        {
            readBytes: (path) => Effect.succeed(bytes.get(path) ?? new Uint8Array()),
            readText: () => Effect.die('Unexpected text read'),
            listFiles: () => Effect.die('Unexpected list'),
        },
        sources,
        limits,
    );
}

const triple = '<urn:a> <urn:p> <urn:b> .\n';

describe('bounded ontology assembly', () => {
    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('rejects invalid statement capacity %s', (limit) => {
        expect(() => parseTurtleSource(descriptor(0), '', limit)).toThrow(OntologyAssemblyLimitError);
    });
    it('enforces statement capacity while constructing quads, including repeated assertions', () => {
        expect(() => parseTurtleSource(descriptor(0), triple.repeat(3), 2)).toThrow(OntologyAssemblyLimitError);
        expect(parseTurtleSource(descriptor(0), triple.repeat(2), 2)).toHaveLength(2);
        expect(parseTurtleSource(descriptor(0), triple.repeat(3))).toHaveLength(3);
    });

    it('applies the statement budget across files rather than once per parser', async () => {
        const result = await Effect.runPromise(
            assemble([triple, triple], { maximumSourceBytes: 1_000, maximumStatements: 1 }).pipe(Effect.flip),
        );
        expect(result).toMatchObject({ code: 'ONTOLOGY_ASSEMBLY_LIMIT', limit: 'statements' });
    });

    it('refuses oversized source bytes before parsing or decoding hostile text', async () => {
        const result = await Effect.runPromise(
            assemble(['not Turtle'.repeat(100)], { maximumSourceBytes: 20, maximumStatements: 100 }).pipe(Effect.flip),
        );
        expect(result).toMatchObject({ code: 'ONTOLOGY_ASSEMBLY_LIMIT', limit: 'bytes' });
    });

    it('copies byte limits and accumulates them across sources', async () => {
        const limits = { maximumSourceBytes: new TextEncoder().encode(triple).byteLength, maximumStatements: 10 };
        const running = assemble([triple, triple], limits);
        limits.maximumSourceBytes = 1_000;
        expect(await Effect.runPromise(running.pipe(Effect.flip))).toMatchObject({
            code: 'ONTOLOGY_ASSEMBLY_LIMIT',
            limit: 'bytes',
        });
    });

    it('preserves exact assembled facts, blank node identity, and provenance when within bounds', async () => {
        const sources = ['<urn:a> <urn:p> [ <urn:q> "hello" ] .', triple];
        const unbounded = await Effect.runPromise(assemble(sources));
        const bounded = await Effect.runPromise(
            assemble(sources, { maximumSourceBytes: 1_000, maximumStatements: 20 }),
        );
        expect(bounded.provenance).toEqual(unbounded.provenance);
        expect(bounded.sources).toEqual(unbounded.sources);
    });
});
