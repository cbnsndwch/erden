import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    ontologyMediaTypeForLocator,
    parseCompetencyQuestionMetadata,
    parseOntologySource,
    runCompetencyQuestions,
    type LoadedCompetencyQuestion,
    type TurtleSourceDescriptor,
} from '../src/index.js';

import { ROOT_OWNER, assembleFixtures } from './reasoner-helpers.js';

// Its own file: the test breaks the process's shared Oxigraph instance on purpose.
const FIXTURES = join(import.meta.dirname, 'fixtures', 'source-formats');

interface OxigraphParse {
    readonly parse: (input: Iterable<string>, options: { readonly format: string }) => Iterable<unknown>;
}

function descriptor(locator: string): TurtleSourceDescriptor {
    return Object.freeze({
        id: `root:ontology:${locator}`,
        owner: ROOT_OWNER,
        locator,
        baseIri: ROOT_OWNER.canonicalIri,
        mediaType: ontologyMediaTypeForLocator(locator) ?? 'text/turtle',
        provenance: Object.freeze({ _tag: 'Asserted' as const }),
    });
}

/** Traps the shared WebAssembly instance the way an unguarded 800-deep JSON-LD document did. */
function trapSharedInstance(): void {
    const oxigraph = createRequire(import.meta.url)('oxigraph') as OxigraphParse;
    const depth = 1_000;
    const bomb = `{"@context":{"p":{"@id":"https://example.test/p"}},"@id":"https://example.test/s",${'"p":{'.repeat(depth)}"@id":"https://example.test/o"${'}'.repeat(depth)}}`;
    expect(() => [...oxigraph.parse([bomb], { format: 'application/ld+json' })]).toThrow(WebAssembly.RuntimeError);
}

function question(text: string): LoadedCompetencyQuestion {
    const bytes = new TextEncoder().encode(text);
    const parsed = parseCompetencyQuestionMetadata(text);
    return Object.freeze({
        id: 'root:competency-questions:0000',
        owner: ROOT_OWNER,
        locator: 'question.rq',
        contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        bytes,
        text,
        placeholders: {},
        metadata: parsed.metadata,
        diagnostics: parsed.diagnostics,
    });
}

describe('a WebAssembly trap in the shared Oxigraph instance', () => {
    it('does not break later RDF/XML and JSON-LD parses or competency questions', async () => {
        trapSharedInstance();
        for (const name of ['animals.jsonld', 'animals.rdf']) {
            const bytes = Uint8Array.from(readFileSync(join(FIXTURES, name)));
            expect(parseOntologySource(descriptor(name), bytes).quads).toHaveLength(26);
        }

        trapSharedInstance();
        const graph = await assembleFixtures([
            {
                id: 'root:ontology:0000',
                locator: 'ontology.ttl',
                text: '<https://example.test/root#i> a <https://example.test/root#A> .\n',
            },
        ]);
        const result = runCompetencyQuestions(graph, [
            question(`# @ask     Is there an A?
# @expect  rows >= 1
SELECT ?i WHERE { ?i a <https://example.test/root#A> }
`),
        ]);
        expect(result.questions).toMatchObject([{ execution: 'executed', rows: 1, ok: true }]);
    });
});
