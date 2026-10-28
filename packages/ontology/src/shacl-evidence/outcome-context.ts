import { RdfComparisonError } from '../comparison-rdf/model.js';

import type { CapturedQuad, ShaclEvidenceComplete, ShaclSelfTestEvidence } from './model.js';
import { SHACL_EVIDENCE_LIMITS } from './model.js';
import { SHACL_RDF_LIMITS, ShaclProjectionCapacity } from './project-model.js';
import { assertProjectionArray, assertProjectionArrayEntries, assertProjectionRecord } from './project-shape.js';
import { makeShaclProjectionTerms } from './project-terms.js';

type SelfTests = Extract<ShaclSelfTestEvidence, { kind: 'complete' }>;

function blanks(quad: CapturedQuad): string[] {
    return [quad.subject, quad.object, quad.graph].flatMap((term) =>
        term.termType === 'BlankNode' ? [term.value] : [],
    );
}

/** Keep exactly the data/shape blank-node components needed to identify report and self-test terms. */
export function selectShaclOutcomeContext(input: ShaclEvidenceComplete, selfTests: SelfTests, check: () => void) {
    const terms = makeShaclProjectionTerms();
    let statements = 0;
    function capacity(reason: 'source-limit' | 'statement-limit'): never {
        throw new ShaclProjectionCapacity({
            schema: 'erden.shacl-rdf/v1',
            kind: 'summary',
            stage: 'projection',
            reason,
        });
    }
    function validateQuads(values: ReadonlyArray<CapturedQuad>): void {
        assertProjectionArray(values);
        if (statements + values.length > SHACL_RDF_LIMITS.maxStatements) {
            capacity('statement-limit');
        }
        assertProjectionArrayEntries(values);
        for (const quad of values) {
            check();
            statements += 1;
            terms.quad(quad);
        }
    }
    assertProjectionRecord(input, ['schema', 'kind', 'data', 'shapes', 'report']);
    assertProjectionArray(input.shapes);
    if (input.shapes.length > SHACL_RDF_LIMITS.maxSources) {
        capacity('source-limit');
    }
    assertProjectionArrayEntries(input.shapes);
    validateQuads(input.data);
    const sourceIds = new Set<string>();
    for (const source of input.shapes) {
        assertProjectionRecord(source, ['sourceId', 'contentDigest', 'owner', 'quads']);
        assertProjectionRecord(source.owner, ['role', 'canonicalIri']);
        const id = terms.charge(source.sourceId, SHACL_EVIDENCE_LIMITS.maxSourceIdBytes);
        const digest = terms.charge(source.contentDigest, 71);
        terms.iri(source.owner.canonicalIri);
        if (
            !/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/u.test(id) ||
            sourceIds.has(id) ||
            !/^sha256:[0-9a-f]{64}$/u.test(digest) ||
            !['root', 'dependency'].includes(source.owner.role)
        ) {
            throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
        }
        sourceIds.add(id);
        validateQuads(source.quads);
    }
    assertProjectionRecord(input.report, ['root', 'quads']);
    terms.resource(input.report.root);
    validateQuads(input.report.quads);
    assertProjectionRecord(selfTests, ['schema', 'kind', 'results']);
    assertProjectionArray(selfTests.results);
    if (selfTests.results.length > SHACL_EVIDENCE_LIMITS.maxSources) {
        capacity('source-limit');
    }
    assertProjectionArrayEntries(selfTests.results);
    const tested = new Set<string>();
    for (const result of selfTests.results) {
        check();
        assertProjectionRecord(result, ['shape', 'fired']);
        const shape = terms.resource(result.shape);
        const key = JSON.stringify([shape.termType, shape.value]);
        if (typeof result.fired !== 'boolean' || tested.has(key)) {
            throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
        }
        tested.add(key);
    }
    const rows = [input.data, ...input.shapes.map((source) => source.quads)].flat();
    const byBlank = new Map<string, number[]>();
    rows.forEach((quad, index) => {
        for (const label of new Set(blanks(quad))) {
            const entries = byBlank.get(label) ?? [];
            entries.push(index);
            byBlank.set(label, entries);
        }
    });
    const queue = [
        ...new Set([
            ...input.report.quads.flatMap(blanks),
            ...(input.report.root.termType === 'BlankNode' ? [input.report.root.value] : []),
            ...selfTests.results.flatMap((result) =>
                result.shape.termType === 'BlankNode' ? [result.shape.value] : [],
            ),
        ]),
    ];
    const seen = new Set(queue);
    const included = new Set<CapturedQuad>();
    for (let next = 0; next < queue.length; next += 1) {
        check();
        for (const index of byBlank.get(queue[next] as string) ?? []) {
            const quad = rows[index] as CapturedQuad;
            if (included.has(quad)) {
                continue;
            }
            included.add(quad);
            for (const label of blanks(quad)) {
                if (!seen.has(label)) {
                    seen.add(label);
                    queue.push(label);
                }
            }
        }
    }
    return {
        ...input,
        data: input.data.filter((quad) => included.has(quad)),
        shapes: input.shapes
            .map((source) => ({ ...source, quads: source.quads.filter((quad) => included.has(quad)) }))
            .filter((source) => source.quads.length !== 0),
    } satisfies ShaclEvidenceComplete;
}
