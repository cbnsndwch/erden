import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { DataFactory, Parser, Writer, type Quad } from 'n3';
import { describe, expect, it } from 'vitest';

import { normalizeRdfComparison, RDF_COMPARISON_LIMITS, type RdfComparisonComplete } from '../src/index.js';

const require = createRequire(import.meta.url);
const { canonize } = require('rdf-canonize') as {
    canonize: (
        input: ReadonlyArray<Quad>,
        options: { algorithm: 'RDFC-1.0'; maxDeepIterations: number },
    ) => Promise<string>;
};

async function complete(input: string): Promise<RdfComparisonComplete> {
    const value = await normalizeRdfComparison(input);
    expect(value.kind).toBe('complete');
    if (value.kind !== 'complete') {
        throw new Error('Expected a complete RDF comparison fixture');
    }
    return value;
}

function reconstruct(value: RdfComparisonComplete): Quad[] {
    const result: Quad[] = [];
    for (const [index, component] of value.components.entries()) {
        for (let instance = 0; instance < component.multiplicity; instance += 1) {
            result.push(
                ...new Parser({ format: 'N-Quads', blankNodePrefix: `c${String(index)}i${String(instance)}` }).parse(
                    component.nquads,
                ),
            );
        }
    }
    return result;
}

describe('bounded RDF comparison normalization', () => {
    it('normalizes an empty dataset and duplicate ground assertions', async () => {
        expect(await complete('')).toEqual({
            schema: 'erden.rdf-components/v1',
            kind: 'complete',
            quadCount: 0,
            components: [],
        });
        const value = await complete('<urn:s> <urn:p> <urn:o> .\n<urn:s> <urn:p> <urn:o> .\n');
        expect(value.quadCount).toBe(1);
        expect(value.components).toHaveLength(1);
        expect(value.components[0]).toMatchObject({
            nquads: '<urn:s> <urn:p> <urn:o> .\n',
            multiplicity: 1,
            quadCount: 1,
        });
    });

    it('keeps repeated isomorphic components and ignores blank-label and statement ordering', async () => {
        const first = await complete('_:a <urn:p> _:b .\n_:c <urn:p> _:d .\n');
        const renamed = await complete('_:z <urn:p> _:x .\n_:y <urn:p> _:w .\n');
        expect(renamed).toEqual(first);
        expect(first.components).toHaveLength(1);
        expect(first.components[0]?.multiplicity).toBe(2);
        expect(first.quadCount).toBe(2);
        expect(await canonize(reconstruct(first), { algorithm: 'RDFC-1.0', maxDeepIterations: 10_000 })).toBe(
            await canonize(new Parser({ format: 'N-Quads' }).parse('_:a <urn:p> _:b .\n_:c <urn:p> _:d .\n'), {
                algorithm: 'RDFC-1.0',
                maxDeepIterations: 10_000,
            }),
        );
    });

    it('does not relabel an unrelated component when another changes', async () => {
        const first = await complete('_:a <urn:p> "one" .\n_:b <urn:q> "unchanged" .\n');
        const second = await complete('_:different <urn:p> "two" .\n_:other <urn:q> "unchanged" .\n');
        const preserved = first.components.filter((component) =>
            second.components.some((other) => component.sha256 === other.sha256),
        );
        expect(preserved).toHaveLength(1);
        expect(preserved[0]?.nquads).toContain('unchanged');
    });

    it('treats named and blank graph identities as RDF identity, including shared graph nodes', async () => {
        const text = '_:a <urn:p> _:b _:g .\n_:g <urn:q> <urn:o> <urn:named> .\n';
        const value = await complete(text);
        expect(value.components).toHaveLength(1);
        expect(value.quadCount).toBe(2);
        expect(await canonize(reconstruct(value), { algorithm: 'RDFC-1.0', maxDeepIterations: 10_000 })).toBe(
            await canonize(new Parser({ format: 'N-Quads' }).parse(text), {
                algorithm: 'RDFC-1.0',
                maxDeepIterations: 10_000,
            }),
        );
    });

    it('preserves literal lexical/datatype distinctions while normalizing language case', async () => {
        const first = await complete('<urn:s> <urn:p> "name"@EN-us .\n');
        expect(first).toEqual(await complete('<urn:s> <urn:p> "name"@en-US .\n'));
        expect(first).not.toEqual(await complete('<urn:s> <urn:p> "name"@fr .\n'));
        const one = await complete('<urn:s> <urn:p> "01"^^<http://www.w3.org/2001/XMLSchema#integer> .\n');
        expect(one).not.toEqual(await complete('<urn:s> <urn:p> "1"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'));
    });

    it('keeps hostile literal text inert and never interprets an IRI as a fetch', async () => {
        const text = "</script><script>alert(1)</script>'); process.stdout.write('injected'); //";
        const quad = DataFactory.quad(
            DataFactory.namedNode('file:///private/source'),
            DataFactory.namedNode('urn:p'),
            DataFactory.literal(text),
        );
        const value = await complete(new Writer({ format: 'N-Quads' }).quadsToString([quad]));
        expect(new Parser({ format: 'N-Quads' }).parse(value.components[0]?.nquads ?? '')[0]?.object.value).toBe(text);
    });

    it.each([
        'not RDF private-token',
        '<relative> <urn:p> <urn:o> .',
        '<urn:s> <urn:p> "unterminated',
        '<urn:s> <urn:p> "\\uD800" .',
    ])('rejects malformed RDF with a fixed diagnostic', async (input) => {
        await expect(normalizeRdfComparison(input)).rejects.toMatchObject({
            code: 'RDF_COMPARISON_INPUT_INVALID',
            message: 'The RDF comparison input is invalid',
        });
    });

    it('checks a cancelled signal even for an empty or oversized input', async () => {
        const signal = AbortSignal.abort('private-cancellation-reason');
        for (const input of ['', ' '.repeat(RDF_COMPARISON_LIMITS.maxInputBytes + 1)]) {
            await expect(normalizeRdfComparison(input, signal)).rejects.toMatchObject({
                code: 'RDF_COMPARISON_CANCELLED',
                message: 'RDF comparison normalization was cancelled',
            });
        }
    });

    it('closes cancelled workers before releasing their concurrency slots', async () => {
        const controllers = [new AbortController(), new AbortController()];
        const pending = controllers.map((controller) =>
            normalizeRdfComparison('_:a <urn:p> _:b .\n', controller.signal),
        );
        await expect(normalizeRdfComparison('')).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
        for (const controller of controllers) {
            controller.abort('private-reason');
        }
        const results = await Promise.allSettled(pending);
        for (const result of results) {
            expect(result).toMatchObject({ status: 'rejected', reason: { code: 'RDF_COMPARISON_CANCELLED' } });
        }
        expect((await complete('<urn:s> <urn:p> <urn:o> .\n')).quadCount).toBe(1);
    });

    it('returns explicit summaries for input, term, and statement capacity', async () => {
        expect(await normalizeRdfComparison(' '.repeat(RDF_COMPARISON_LIMITS.maxInputBytes + 1))).toMatchObject({
            kind: 'summary',
            reason: 'input-limit',
        });
        expect(
            await normalizeRdfComparison(
                '<urn:s> <urn:p> "' + 'x'.repeat(RDF_COMPARISON_LIMITS.maxLiteralBytes + 1) + '" .\n',
            ),
        ).toMatchObject({ kind: 'summary', reason: 'term-limit' });
        expect(
            await normalizeRdfComparison('<urn:s> <urn:p> <urn:o> .\n'.repeat(RDF_COMPARISON_LIMITS.maxStatements + 1)),
        ).toMatchObject({ kind: 'summary', reason: 'statement-limit' });
    });

    it.each([
        [
            'blank-node-limit',
            Array.from({ length: 10_001 }, (_, index) => `_:b${String(index)} <urn:p> <urn:o> .\n`).join(''),
        ],
        [
            'component-limit',
            Array.from({ length: 16_385 }, (_, index) => `<urn:s${String(index)}> <urn:p> <urn:o> .\n`).join(''),
        ],
        [
            'component-limit',
            Array.from({ length: 10_001 }, (_, index) => `_:b <urn:p> <urn:o${String(index)}> .\n`).join(''),
        ],
        [
            'component-limit',
            Array.from({ length: 100 }, (_, index) => `_:b <urn:p${String(index)}> "${'x'.repeat(12_000)}" .\n`).join(
                '',
            ),
        ],
        [
            'output-limit',
            Array.from(
                { length: 400 },
                (_, index) => `<urn:s${String(index)}> <urn:p> "${'x'.repeat(12_000)}" .\n`,
            ).join(''),
        ],
    ])('reports %s without returning partial facts', async (reason, input) => {
        expect(await normalizeRdfComparison(input)).toEqual({
            schema: 'erden.rdf-components/v1',
            kind: 'summary',
            reason,
        });
    });

    it('accepts exact byte limits and refuses larger IRI, literal, and blank-node terms', async () => {
        for (const [prefix, suffix, size] of [
            ['<urn:', '> <urn:p> <urn:o> .\n', RDF_COMPARISON_LIMITS.maxIriBytes - 4],
            ['_:', ' <urn:p> <urn:o> .\n', RDF_COMPARISON_LIMITS.maxBlankNodeBytes],
            ['<urn:s> <urn:p> "', '" .\n', RDF_COMPARISON_LIMITS.maxLiteralBytes],
        ] as const) {
            expect((await complete(prefix + 'x'.repeat(size) + suffix)).quadCount).toBe(1);
            expect(await normalizeRdfComparison(prefix + 'x'.repeat(size + 1) + suffix)).toMatchObject({
                kind: 'summary',
                reason: 'term-limit',
            });
        }
    });

    it('bounds complete language tags independently of their literal value', async () => {
        const language = 'en-x-' + 'a-'.repeat(61) + 'b';
        expect(Buffer.byteLength(language)).toBe(RDF_COMPARISON_LIMITS.maxLanguageBytes);
        expect((await complete(`<urn:s> <urn:p> "name"@${language} .\n`)).quadCount).toBe(1);
        expect(await normalizeRdfComparison(`<urn:s> <urn:p> "name"@${language}b .\n`)).toMatchObject({
            kind: 'summary',
            reason: 'term-limit',
        });
    });

    it('preserves a supplementary Unicode character across a parser chunk boundary', async () => {
        const prefix = '<urn:s> <urn:p> "';
        const input = ' '.repeat(65_535 - prefix.length) + prefix + '🌃" .\n';
        expect(await complete(input)).toEqual(await complete(prefix + '🌃" .\n'));
    });
});

const officialCases = JSON.parse(
    readFileSync(new URL('./fixtures/rdf-canon/cases.json', import.meta.url), 'utf8'),
) as ReadonlyArray<{
    readonly id: string;
    readonly input: string;
    readonly expected: string;
}>;

describe('pinned W3C canonicalization cases through the component adapter', () => {
    it('retains the pinned upstream fixture bytes', () => {
        const source = JSON.parse(
            readFileSync(new URL('./fixtures/rdf-canon/source.json', import.meta.url), 'utf8'),
        ) as {
            revision: string;
            files: ReadonlyArray<{ path: string; sha256: string }>;
        };
        expect(source.revision).toBe('15619df2fda7a4ca88308733789b6774517f9638');
        expect(source.files).toHaveLength(35);
        for (const file of source.files) {
            const bytes = readFileSync(new URL(`./fixtures/rdf-canon/${file.path}`, import.meta.url));
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
        }
    });
    for (const fixture of officialCases) {
        it(fixture.id, async () => {
            const input = readFileSync(new URL(`./fixtures/rdf-canon/${fixture.input}`, import.meta.url), 'utf8');
            const expected = readFileSync(new URL(`./fixtures/rdf-canon/${fixture.expected}`, import.meta.url), 'utf8');
            const projected = await complete(input);
            const reconstructed = reconstruct(projected);
            expect(projected.quadCount).toBe(new Parser({ format: 'N-Quads' }).parse(expected).length);
            expect(await canonize(reconstructed, { algorithm: 'RDFC-1.0', maxDeepIterations: 10_000 })).toBe(expected);
            expect(await complete(new Writer({ format: 'N-Quads' }).quadsToString(reconstructed.reverse()))).toEqual(
                projected,
            );
        });
    }

    it('refuses the official clique graph without exposing a partial result', async () => {
        const input = readFileSync(new URL('./fixtures/rdf-canon/rdfc10/test074-in.nq', import.meta.url), 'utf8');
        expect(await normalizeRdfComparison(input)).toEqual({
            schema: 'erden.rdf-components/v1',
            kind: 'summary',
            reason: 'canonicalization-limit',
        });
    });
});
