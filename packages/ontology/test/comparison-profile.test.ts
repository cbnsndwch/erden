import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    normalizeRdfComparison,
    validateRdfComparisonBytes,
    RDF_COMPARISON_LIMITS,
    type RdfComparisonComplete,
} from '../src/index.js';

function bytes(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
}
function component(nquads: string, multiplicity = 1) {
    return {
        nquads,
        sha256: createHash('sha256').update(nquads).digest('hex'),
        multiplicity,
        quadCount: nquads.split('\n').length - 1,
    };
}
function profile(nquads: string, multiplicity = 1): RdfComparisonComplete {
    const value = component(nquads, multiplicity);
    return {
        schema: 'erden.rdf-components/v1',
        kind: 'complete',
        quadCount: value.quadCount * multiplicity,
        components: [value],
    };
}

describe('stored RDF component verification', () => {
    it('verifies real canonical components with graph identity, lexical forms, and repeated instances', async () => {
        const projected = await normalizeRdfComparison(
            '_:a <urn:p> "01"^^<http://www.w3.org/2001/XMLSchema#integer> _:g .\n_:g <urn:q> _:a .\n_:x <urn:p> "repeat" .\n_:y <urn:p> "repeat" .\n<urn:s> <urn:p> "word"@EN <urn:graph> .',
        );
        expect(projected.kind).toBe('complete');
        const decoded = await validateRdfComparisonBytes(bytes(projected));
        expect(decoded).toEqual(projected);
        expect(Object.isFrozen(decoded.components)).toBe(true);
        expect(await validateRdfComparisonBytes(bytes(await normalizeRdfComparison('')))).toMatchObject({
            kind: 'complete',
            quadCount: 0,
        });
    });

    it.each([
        '_:renamed <urn:p> "value" .\n',
        '<urn:s>  <urn:p> "value" .\n',
        '<urn:s> <urn:p> "value"@EN .\n',
        '<urn:s> <urn:p> "\\u0076alue" .\n',
        '<urn:s> <urn:p> "value" .\n<urn:s> <urn:p> "value" .\n',
        '_:c14n0 <urn:p> "first" .\n_:c14n1 <urn:p> "second" .\n',
        '<urn:s> <urn:p> "one" .\n<urn:s> <urn:p> "two" .\n',
        '<relative> <urn:p> "value" .\n',
        '<urn:s> <urn:p> "unterminated .\n',
    ])('rejects noncanonical or disconnected RDF even with a matching digest: %s', async (nquads) => {
        await expect(validateRdfComparisonBytes(bytes(profile(nquads)))).rejects.toMatchObject({
            code: 'RDF_COMPARISON_INPUT_INVALID',
        });
    });

    it('rejects repeated ground assertions and charges blank nodes for every component instance', async () => {
        await expect(
            validateRdfComparisonBytes(bytes(profile('<urn:s> <urn:p> "value" .\n', 2))),
        ).rejects.toMatchObject({ code: 'RDF_COMPARISON_INPUT_INVALID' });
        const blank = '_:c14n0 <urn:p> "value" .\n';
        expect(
            await validateRdfComparisonBytes(bytes(profile(blank, RDF_COMPARISON_LIMITS.maxBlankNodes))),
        ).toMatchObject({ quadCount: 10_000 });
        await expect(
            validateRdfComparisonBytes(bytes(profile(blank, RDF_COMPARISON_LIMITS.maxBlankNodes + 1))),
        ).rejects.toMatchObject({ code: 'RDF_COMPARISON_INPUT_INVALID' });
    });

    it('rejects substituted hashes, totals, component ordering, and closed record fields', async () => {
        const valid = profile('<urn:s> <urn:p> "value" .\n');
        const first = valid.components[0];
        for (const value of [
            { ...valid, quadCount: 2 },
            { ...valid, extra: true },
            { ...valid, components: [{ ...first, sha256: 'a'.repeat(64) }] },
            { ...valid, quadCount: 2, components: [first, first] },
            { schema: 'erden.rdf-components/v1', kind: 'summary', reason: 'output-limit' },
        ]) {
            await expect(validateRdfComparisonBytes(bytes(value))).rejects.toMatchObject({
                code: 'RDF_COMPARISON_INPUT_INVALID',
            });
        }
    });

    it('bounds bytes, copies caller ownership, and respects cancellation', async () => {
        await expect(
            validateRdfComparisonBytes(new Uint8Array(RDF_COMPARISON_LIMITS.maxOutputBytes + 1)),
        ).rejects.toMatchObject({ code: 'RDF_COMPARISON_INPUT_INVALID' });
        const valid = profile('<urn:s> <urn:p> "value" .\n');
        const input = bytes(valid);
        const pending = validateRdfComparisonBytes(input);
        input.fill(0);
        expect(await pending).toEqual(valid);
        await expect(validateRdfComparisonBytes(bytes(valid), AbortSignal.abort())).rejects.toMatchObject({
            code: 'RDF_COMPARISON_CANCELLED',
        });
    });
});
