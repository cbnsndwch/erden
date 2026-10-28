import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { DataFactory, type Quad, type Term } from 'n3';

import { CompetencyQuestionArtifactError } from './errors.js';
import type {
    AssembledOntology,
    CompetencyQuestionMetadata,
    CompetencyQuestionMetadataDiagnostic,
    CompetencyQuestionResult,
    CompetencyQuestionValidation,
    LoadedCompetencyQuestion,
} from './model.js';
import { compareCodePoints } from './order.js';
import { discardOxigraphAfterTrap, withOxigraph } from './oxigraph-runtime.js';

interface OxigraphTerm {
    readonly termType: 'BlankNode' | 'DefaultGraph' | 'Literal' | 'NamedNode' | 'Quad' | 'Variable';
    readonly value: string;
    readonly language?: string;
    readonly datatype?: { readonly value: string };
}

interface OxigraphStoreShape {
    readonly add: (quad: unknown) => void;
    readonly query: (
        query: string,
    ) => boolean | ReadonlyArray<Map<string, OxigraphTerm>> | ReadonlyArray<unknown> | string;
}

interface OxigraphModule {
    readonly Store: new () => OxigraphStoreShape;
    readonly fromQuad: (quad: unknown) => unknown;
}

function metadataValue(text: string, tag: string): string | null {
    const lines = text.split(/\r?\n/u);
    const marker = `# @${tag}`;
    const index = lines.findIndex((line) => line.startsWith(marker));
    if (index < 0) {
        return null;
    }
    let value = (lines[index] ?? '').slice(marker.length).trim();
    for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next];
        if (line === undefined || !/^#\s{10,}/u.test(line)) {
            break;
        }
        value += ` ${line.replace(/^#\s+/u, '')}`;
    }
    return value;
}

const EXPECTATION = /^rows\s*(==|>=|<=|>|<)\s*(\d+)$/u;

export function parseCompetencyQuestionMetadata(text: string): {
    readonly metadata: CompetencyQuestionMetadata;
    readonly diagnostics: ReadonlyArray<CompetencyQuestionMetadataDiagnostic>;
} {
    const metadata: CompetencyQuestionMetadata = {
        ask: metadataValue(text, 'ask'),
        expect: metadataValue(text, 'expect'),
        from: metadataValue(text, 'from'),
        status: metadataValue(text, 'status'),
        closes: metadataValue(text, 'closes'),
    };
    const diagnostics: CompetencyQuestionMetadataDiagnostic[] = [];
    if (metadata.ask === null) {
        diagnostics.push({ code: 'missing-ask', message: 'Missing # @ask metadata.' });
    }
    if (metadata.expect === null) {
        diagnostics.push({ code: 'missing-expect', message: 'Missing # @expect metadata.' });
    } else if (!EXPECTATION.test(metadata.expect)) {
        diagnostics.push({
            code: 'invalid-expectation',
            message: `Unparseable @expect: ${metadata.expect}`,
        });
    }
    if (metadata.from === null) {
        diagnostics.push({ code: 'missing-from', message: 'Missing # @from metadata.' });
    }
    if (/EXPECTED TO FAIL/iu.test(metadata.status ?? '') && metadata.closes === null) {
        diagnostics.push({
            code: 'missing-closes',
            message: 'An expected-to-fail question must name # @closes.',
        });
    }
    return { metadata, diagnostics };
}

export function renderQuestion(question: LoadedCompetencyQuestion): {
    readonly text: string;
    readonly missing: ReadonlyArray<string>;
} {
    const missing = new Set<string>();
    const text = question.text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu, (_match, rawKey: string) => {
        const replacement = question.placeholders[rawKey];
        if (replacement !== undefined) {
            return replacement;
        }
        missing.add(rawKey);
        return `{{${rawKey}}}`;
    });
    return { text, missing: [...missing].sort(compareCodePoints) };
}

function evaluateExpectation(
    expectation: string | null,
    rows: number,
): {
    readonly ok: boolean;
    readonly reason: string;
} {
    const match = EXPECTATION.exec(expectation?.trim() ?? '');
    if (match === null) {
        return { ok: false, reason: `unparseable @expect: ${expectation ?? '<missing>'}` };
    }
    const operator = match[1] ?? '';
    const expected = Number(match[2] ?? '0');
    const ok =
        operator === '=='
            ? rows === expected
            : operator === '>='
              ? rows >= expected
              : operator === '<='
                ? rows <= expected
                : operator === '>'
                  ? rows > expected
                  : rows < expected;
    return { ok, reason: `${String(rows)} rows, expected ${operator} ${String(expected)}` };
}

function termValue(term: OxigraphTerm): string {
    if (term.termType === 'Literal') {
        const language = term.language ?? '';
        const suffix = language.length > 0 ? `@${language}` : `^^${term.datatype?.value ?? ''}`;
        return `${term.value}${suffix}`;
    }
    return term.value;
}

function sampleBindings(
    bindings: ReadonlyArray<Map<string, OxigraphTerm>>,
): ReadonlyArray<Readonly<Record<string, string>>> {
    return bindings
        .slice(0, 4)
        .map((binding) =>
            Object.freeze(
                Object.fromEntries(
                    [...binding]
                        .sort(([left], [right]) => compareCodePoints(left, right))
                        .map(([name, term]) => [name, termValue(term)]),
                ),
            ),
        )
        .sort((left, right) => compareCodePoints(JSON.stringify(left), JSON.stringify(right)));
}

/**
 * Assembled blank-node labels carry the source prefix and a `/` (`source/anonymous/1`), which Oxigraph rejects as a
 * blank-node identifier. At the Oxigraph boundary only, each label becomes `b` plus the hex SHA-256 of the assembled
 * label: valid, deterministic, and stable across runs. Assembly, provenance, digests, and reasoner input keep the
 * assembled labels; a question can bind a blank node but never name one, so results do not depend on the spelling.
 */
function oxigraphBlankNodeLabel(label: string): string {
    return `b${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

function oxigraphTerm<T extends Term>(term: T): T {
    return (term.termType === 'BlankNode' ? DataFactory.blankNode(oxigraphBlankNodeLabel(term.value)) : term) as T;
}

function oxigraphQuad(quad: Quad): Quad {
    if (quad.subject.termType !== 'BlankNode' && quad.object.termType !== 'BlankNode') {
        return quad;
    }
    return DataFactory.quad(oxigraphTerm(quad.subject), quad.predicate, oxigraphTerm(quad.object), quad.graph);
}

function isBindingRows(rows: ReadonlyArray<unknown>): rows is ReadonlyArray<Map<string, OxigraphTerm>> {
    return rows.every((value) => value instanceof Map);
}

export function runCompetencyQuestions(
    graph: AssembledOntology,
    questions: ReadonlyArray<LoadedCompetencyQuestion>,
): CompetencyQuestionValidation {
    const boundQuestions = questions.map((question): LoadedCompetencyQuestion => {
        try {
            const digest = `sha256:${createHash('sha256').update(question.bytes).digest('hex')}`;
            const text = new TextDecoder('utf-8', { fatal: true }).decode(question.bytes);
            if (digest !== question.contentDigest || text !== question.text) {
                throw new Error('content digest or decoded text mismatch');
            }
            const parsed = parseCompetencyQuestionMetadata(text);
            return {
                ...question,
                text,
                metadata: parsed.metadata,
                diagnostics: parsed.diagnostics,
            };
        } catch (cause) {
            throw new CompetencyQuestionArtifactError(question.id, cause, question.locator);
        }
    });
    let queryStore: OxigraphStoreShape;
    try {
        queryStore = withOxigraph((module) => {
            const oxigraph = module as OxigraphModule;
            const store = new oxigraph.Store();
            for (const quad of graph.dataset.getQuads(null, null, null, null)) {
                store.add(oxigraph.fromQuad(oxigraphQuad(quad)));
            }
            return store;
        });
    } catch (cause) {
        throw new CompetencyQuestionArtifactError(
            'store',
            cause,
            boundQuestions.find((question) => question.owner.role === 'root')?.locator,
        );
    }
    const results: CompetencyQuestionResult[] = boundQuestions.map((question) => {
        const expectedToFail = /EXPECTED TO FAIL/iu.test(question.metadata.status ?? '');
        if (question.owner.role === 'dependency') {
            return {
                id: question.id,
                owner: question.owner,
                locator: question.locator,
                execution: 'dormant-dependency',
                metadata: question.metadata,
                metadataDiagnostics: question.diagnostics,
                rows: null,
                ok: null,
                expectedToFail,
                blocking: false,
                reason: 'dependency competency questions are loaded but execute only when their project is root',
                sample: [],
            };
        }
        const rendered = renderQuestion(question);
        if (rendered.missing.length > 0) {
            return {
                id: question.id,
                owner: question.owner,
                locator: question.locator,
                execution: 'executed',
                metadata: question.metadata,
                metadataDiagnostics: question.diagnostics,
                rows: null,
                ok: false,
                expectedToFail,
                blocking: true,
                reason: `unknown placeholder(s): ${rendered.missing.map((key) => `{{${key}}}`).join(', ')}`,
                sample: [],
            };
        }
        let bindings: Map<string, OxigraphTerm>[] = [];
        let rows = 0;
        let queryError: string | null = null;
        try {
            const queried = queryStore.query(rendered.text);
            if (typeof queried === 'boolean') {
                rows = queried ? 1 : 0;
            } else if (typeof queried === 'string') {
                queryError = 'query returned a serialized result, not rows';
            } else {
                const materialized = queried;
                if (isBindingRows(materialized)) {
                    bindings = [...materialized];
                    rows = bindings.length;
                } else {
                    rows = materialized.length;
                }
            }
        } catch (cause) {
            // A trapped query leaves the store's instance broken; later checks get a fresh one.
            discardOxigraphAfterTrap(cause);
            queryError = cause instanceof Error ? cause.message : String(cause);
        }
        const verdict =
            queryError === null
                ? evaluateExpectation(question.metadata.expect, rows)
                : { ok: false, reason: `query error: ${queryError}` };
        const metadataBlocks = question.diagnostics.length > 0;
        const expectedFailureIsDocumented =
            expectedToFail && !verdict.ok && question.metadata.closes !== null && !metadataBlocks;
        const blocking = metadataBlocks || (!verdict.ok && !expectedFailureIsDocumented);
        return {
            id: question.id,
            owner: question.owner,
            locator: question.locator,
            execution: 'executed',
            metadata: question.metadata,
            metadataDiagnostics: question.diagnostics,
            rows,
            ok: verdict.ok,
            expectedToFail,
            blocking,
            reason: verdict.reason,
            sample: sampleBindings(bindings),
        };
    });
    return {
        conforms: results.every((result) => !result.blocking),
        questions: results,
        executed: results.filter((result) => result.execution === 'executed').length,
        dormant: results.filter((result) => result.execution === 'dormant-dependency').length,
    };
}
