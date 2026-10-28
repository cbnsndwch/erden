// RDF helpers for the qualification harness: parsing, a small graph index, the W3C suite's report projection and
// isomorphism (RDFC-1.0). Taken from the W3 measurement's harness (research/w3-shacl-engines/harness/lib.mjs at
// 54c6650) so the grading is the one W3 used; n3 and rdf-canonize are @erden/ontology's own pinned dependencies.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = new URL('../../../', import.meta.url);
const ontologyRequire = createRequire(new URL('packages/ontology/package.json', REPOSITORY));
export const N3 = await import(pathToFileURL(ontologyRequire.resolve('n3')).href);
const canonizeModule = await import(pathToFileURL(ontologyRequire.resolve('rdf-canonize')).href);
const canonize = canonizeModule.default?.canonize ?? canonizeModule.canonize;
/** Erden's built @erden/ontology (run `pnpm run build` first): the protocol client the harness drives. */
export const ontology = await import(new URL('packages/ontology/dist/index.js', REPOSITORY).href);

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const SH = 'http://www.w3.org/ns/shacl#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
export const SHT = 'http://www.w3.org/ns/shacl-test#';

export function fileIri(path) {
    return pathToFileURL(path).href;
}

let parseCounter = 0;
export function parseText(text, base, format = 'text/turtle') {
    parseCounter += 1;
    return new N3.Parser({ baseIRI: base, format, blankNodePrefix: `h${parseCounter}_` }).parse(text);
}

export function parseFile(path, base = fileIri(path)) {
    return parseText(readFileSync(path, 'utf8'), base, path.endsWith('.nt') ? 'application/n-triples' : 'text/turtle');
}

export function key(term) {
    if (term.termType === 'Literal') {
        return `L:${term.value}|${term.language ?? ''}|${term.datatype?.value ?? ''}`;
    }
    return `${term.termType[0]}:${term.value}`;
}

/** Minimal subject/predicate index over an array of quads. */
export class Graph {
    constructor(quads) {
        this.quads = quads;
        this.bySubject = new Map();
        for (const quad of quads) {
            const k = key(quad.subject);
            if (!this.bySubject.has(k)) {
                this.bySubject.set(k, []);
            }
            this.bySubject.get(k).push(quad);
        }
    }
    outgoing(subject) {
        return this.bySubject.get(key(subject)) ?? [];
    }
    objects(subject, predicate) {
        return this.outgoing(subject)
            .filter((quad) => quad.predicate.value === predicate)
            .map((quad) => quad.object);
    }
    object(subject, predicate) {
        return this.objects(subject, predicate)[0];
    }
    subjects(predicate, object) {
        return this.quads
            .filter((quad) => quad.predicate.value === predicate && (object === undefined || key(quad.object) === key(object)))
            .map((quad) => quad.subject);
    }
    list(head) {
        const items = [];
        let node = head;
        const seen = new Set();
        while (node !== undefined && !(node.termType === 'NamedNode' && node.value === `${RDF}nil`)) {
            if (seen.has(key(node))) {
                break;
            }
            seen.add(key(node));
            const first = this.object(node, `${RDF}first`);
            if (first === undefined) {
                break;
            }
            items.push(first);
            node = this.object(node, `${RDF}rest`);
        }
        return items;
    }
}

const PATH_PREDICATES = new Set([
    `${SH}inversePath`,
    `${SH}alternativePath`,
    `${SH}zeroOrMorePath`,
    `${SH}oneOrMorePath`,
    `${SH}zeroOrOnePath`,
    `${RDF}first`,
    `${RDF}rest`,
]);

const RESULT_PREDICATES = [
    `${SH}focusNode`,
    `${SH}resultSeverity`,
    `${SH}sourceConstraint`,
    `${SH}sourceConstraintComponent`,
    `${SH}sourceShape`,
    `${SH}value`,
];

/**
 * Project a report graph onto the W3C test-suite comparison graph
 * (data-shapes-test-suite/index.html, "full compliance"): report and results become fresh blank nodes typed only
 * sh:ValidationReport / sh:ValidationResult; only the listed predicates are kept; result-path blank-node structures
 * are cloned per result; sh:resultMessage is kept only when the expected graph uses it; nested sh:detail is dropped.
 * Returns { quads, missingPathStructure } or null when the graph has no report node.
 */
export function projectReport(graph, reportNode, keepMessages) {
    const { namedNode, blankNode, quad, literal } = N3.DataFactory;
    const out = [];
    let fresh = 0;
    const leafNames = new Map();
    const leaf = (term) => {
        if (term.termType !== 'BlankNode') {
            return term;
        }
        if (!leafNames.has(term.value)) {
            leafNames.set(term.value, blankNode(`leaf${leafNames.size}`));
        }
        return leafNames.get(term.value);
    };
    let missingPathStructure = 0;
    const clonePath = (term) => {
        if (term.termType !== 'BlankNode') {
            return term;
        }
        const outgoing = graph.outgoing(term).filter((q) => PATH_PREDICATES.has(q.predicate.value));
        const copy = blankNode(`path${fresh++}`);
        if (outgoing.length === 0) {
            missingPathStructure += 1;
        }
        for (const q of outgoing) {
            out.push(quad(copy, q.predicate, clonePath(q.object)));
        }
        return copy;
    };
    const report = blankNode('report');
    out.push(quad(report, namedNode(`${RDF}type`), namedNode(`${SH}ValidationReport`)));
    const conforms = graph.object(reportNode, `${SH}conforms`);
    if (conforms !== undefined) {
        out.push(quad(report, namedNode(`${SH}conforms`), literal(conforms.value, namedNode(`${XSD}boolean`))));
    }
    for (const result of graph.objects(reportNode, `${SH}result`)) {
        const node = blankNode(`result${fresh++}`);
        out.push(quad(report, namedNode(`${SH}result`), node));
        out.push(quad(node, namedNode(`${RDF}type`), namedNode(`${SH}ValidationResult`)));
        for (const q of graph.outgoing(result)) {
            const p = q.predicate.value;
            if (RESULT_PREDICATES.includes(p) || (keepMessages && p === `${SH}resultMessage`)) {
                out.push(quad(node, q.predicate, leaf(q.object)));
            } else if (p === `${SH}resultPath`) {
                out.push(quad(node, q.predicate, clonePath(q.object)));
            }
        }
    }
    return { quads: out, missingPathStructure };
}

export function findReportNodes(graph) {
    return graph.subjects(`${RDF}type`, N3.DataFactory.namedNode(`${SH}ValidationReport`));
}

function plain(term) {
    if (term.termType === 'Literal') {
        return {
            termType: 'Literal',
            value: term.value,
            language: term.language ?? '',
            datatype: { termType: 'NamedNode', value: term.datatype?.value ?? `${XSD}string` },
        };
    }
    return { termType: term.termType, value: term.value };
}

export async function canonical(quads) {
    const dataset = quads.map((q) => ({
        subject: plain(q.subject),
        predicate: plain(q.predicate),
        object: plain(q.object),
        graph: { termType: 'DefaultGraph', value: '' },
    }));
    return canonize(dataset, { algorithm: 'RDFC-1.0', maxWorkFactor: 3 });
}

/** Human-readable result tuples, for diagnosing mismatches (not used for pass/fail). */
export function tuples(graph, reportNode) {
    const show = (term) => {
        if (term === undefined) {
            return null;
        }
        if (term.termType === 'BlankNode') {
            const structure = graph.outgoing(term).filter((q) => PATH_PREDICATES.has(q.predicate.value));
            if (structure.length > 0) {
                return `[${structure.map((q) => `${q.predicate.value.replace(/^.*[#/]/u, '')} ${show(q.object)}`).join('; ')}]`;
            }
            return '_:';
        }
        if (term.termType === 'Literal') {
            return JSON.stringify(term.value) + (term.language ? `@${term.language}` : term.datatype && term.datatype.value !== `${XSD}string` ? `^^${term.datatype.value.replace(XSD, 'xsd:')}` : '');
        }
        return term.value;
    };
    return graph.objects(reportNode, `${SH}result`).map((result) => ({
        focus: show(graph.object(result, `${SH}focusNode`)),
        path: show(graph.object(result, `${SH}resultPath`)),
        value: show(graph.object(result, `${SH}value`)),
        component: show(graph.object(result, `${SH}sourceConstraintComponent`)),
        severity: show(graph.object(result, `${SH}resultSeverity`)),
        sourceShape: show(graph.object(result, `${SH}sourceShape`)),
    }));
}

/** Run a command, never throwing; returns {code, stdout, stderr, ms, timedOut}. */
export function run(file, args, { timeoutMs = 120_000, env } = {}) {
    return new Promise((resolvePromise) => {
        const started = process.hrtime.bigint();
        execFile(
            file,
            args,
            { timeout: timeoutMs, maxBuffer: 1 << 30, env: env ?? process.env, killSignal: 'SIGKILL' },
            (error, stdout, stderr) => {
                const ms = Number(process.hrtime.bigint() - started) / 1e6;
                resolvePromise({
                    code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
                    signal: error?.signal ?? null,
                    timedOut: Boolean(error?.killed && error?.signal === 'SIGKILL'),
                    stdout,
                    stderr,
                    ms,
                });
            },
        );
    });
}

export async function pool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function lane() {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
    return results;
}

export function quantile(sorted, q) {
    if (sorted.length === 0) {
        return null;
    }
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return {
        n: sorted.length,
        p50: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
        min: sorted[0] ?? null,
        max: sorted.at(-1) ?? null,
        mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    };
}
