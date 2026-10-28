import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    parseCompetencyQuestionMetadata,
    runCompetencyQuestions,
    type AssembledOntology,
    type LoadedCompetencyQuestion,
} from '../src/index.js';

import { ROOT_OWNER, assembleFixtures } from './reasoner-helpers.js';

const HEADER = `@prefix x: <https://example.test/root#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://example.test/root> a owl:Ontology ; rdfs:label "repro" .
x:A a owl:Class ; rdfs:label "A" . x:B a owl:Class ; rdfs:label "B" . x:C a owl:Class ; rdfs:label "C" .
x:i a x:A ; rdfs:label "i" .
`;
const UNION = `${HEADER}x:p a owl:ObjectProperty ; rdfs:label "p" ; rdfs:domain [ a owl:Class ; owl:unionOf ( x:A x:B ) ] ; rdfs:range x:C .\n`;
const NAMED = `${HEADER}x:p a owl:ObjectProperty ; rdfs:label "p" ; rdfs:domain x:A ; rdfs:range x:C .\n`;

const IS_THERE_AN_A = `# @ask     Is there an A?
# @expect  rows >= 1
# @from    x:i is asserted to be an A.
PREFIX x: <https://example.test/root#>
SELECT ?i WHERE { ?i a x:A }
`;
const UNION_MEMBERS = `# @ask     Which classes make up the domain of p?
# @expect  rows == 2
# @from    The union domain of x:p.
PREFIX x: <https://example.test/root#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?d ?member WHERE { x:p rdfs:domain ?d . ?d owl:unionOf ?list . ?list rdf:rest*/rdf:first ?member }
`;

function question(id: string, text: string): LoadedCompetencyQuestion {
    const bytes = new TextEncoder().encode(text);
    const parsed = parseCompetencyQuestionMetadata(text);
    return Object.freeze({
        id,
        owner: ROOT_OWNER,
        locator: `${id}.rq`,
        contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        bytes,
        text,
        placeholders: {},
        metadata: parsed.metadata,
        diagnostics: parsed.diagnostics,
    });
}

async function graphOf(text: string): Promise<AssembledOntology> {
    return assembleFixtures([{ id: 'root:ontology:0000', locator: 'ontology.ttl', text }]);
}

describe('competency questions over union domains', () => {
    it('runs a question against a graph whose union domain uses assembled blank-node labels', async () => {
        const graph = await graphOf(UNION);
        const labels = graph.dataset
            .getQuads(null, null, null, null)
            .flatMap((quad) => [quad.subject, quad.object])
            .filter((term) => term.termType === 'BlankNode')
            .map((term) => term.value);
        expect(labels.length).toBeGreaterThan(0);
        expect(labels.some((label) => label.includes('/'))).toBe(true);
        const result = runCompetencyQuestions(graph, [question('root:competency-questions:0000', IS_THERE_AN_A)]);
        expect(result.conforms).toBe(true);
        expect(result.questions[0]).toMatchObject({ rows: 1, ok: true, blocking: false });
    });

    it('matches the named-domain control', async () => {
        const result = runCompetencyQuestions(await graphOf(NAMED), [
            question('root:competency-questions:0000', IS_THERE_AN_A),
        ]);
        expect(result.questions[0]).toMatchObject({ rows: 1, ok: true, blocking: false });
    });

    it('binds the union blank node to a valid label that is identical across runs', async () => {
        const first = runCompetencyQuestions(await graphOf(UNION), [question('q', UNION_MEMBERS)]);
        const second = runCompetencyQuestions(await graphOf(UNION), [question('q', UNION_MEMBERS)]);
        expect(first.questions[0]).toMatchObject({ rows: 2, ok: true });
        const sample = first.questions[0]?.sample ?? [];
        expect(sample.map((row) => row.member).sort()).toEqual([
            'https://example.test/root#A',
            'https://example.test/root#B',
        ]);
        for (const row of sample) {
            expect(row.d).toMatch(/^b[0-9a-f]{64}$/u);
        }
        expect(second.questions[0]?.sample).toEqual(sample);
    });

    it('leaves the assembled graph and its labels untouched', async () => {
        const graph = await graphOf(UNION);
        const before = graph.dataset.getQuads(null, null, null, null).map((quad) => quad.subject.value);
        runCompetencyQuestions(graph, [question('q', UNION_MEMBERS)]);
        expect(graph.dataset.getQuads(null, null, null, null).map((quad) => quad.subject.value)).toEqual(before);
    });
});
