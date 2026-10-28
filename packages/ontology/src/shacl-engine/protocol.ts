// Writing an `erden.shacl/v1` request and trusting its answer. Each input is serialized once, as N-Triples with wire
// blank-node labels (`s<n>` in the shapes graph, `d<n>` in every data graph), and its SHA-256 is hashed once from the
// text written. The answer is decoded once, strictly, and checked in one pass against what the request recorded while
// it was written: the envelope, the tool, every digest, every blank node and source shape, every severity and every
// verdict. Nothing is validated twice.
import { createHash } from 'node:crypto';

import {
    MAX_SHACL_GRAPHS,
    MAX_SHACL_REQUEST_ID_BYTES,
    MAX_SHACL_WIRE_BYTES,
    SHACL_PROTOCOL_VERSION,
    type ShaclEngineTool,
} from './identity.js';

const SH = 'http://www.w3.org/ns/shacl#';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const SH_SEVERITY = `${SH}severity`;
const BUILT_IN_SEVERITIES = new Set([`${SH}Violation`, `${SH}Warning`, `${SH}Info`, `${SH}Debug`, `${SH}Trace`]);
/** The default conformance-disallow set the engine identity names. */
const DISALLOWED = new Set([`${SH}Violation`, `${SH}Warning`, `${SH}Info`]);

/** An RDF/JS term as the encoder reads it. */
export interface ShaclInputTerm {
    readonly termType: string;
    readonly value: string;
    readonly language?: string;
    readonly datatype?: { readonly value: string };
    readonly direction?: string | null;
}
export interface ShaclInputQuad {
    readonly subject: ShaclInputTerm;
    readonly predicate: ShaclInputTerm;
    readonly object: ShaclInputTerm;
}

/** A term of a trusted answer. Blank nodes are the caller's own terms, mapped back from their wire labels. */
export type ShaclAnswerTerm =
    | Readonly<{ termType: 'NamedNode'; value: string }>
    | Readonly<{ termType: 'Literal'; value: string; datatype: string; language: string }>
    | ShaclInputTerm;

export type ShaclAnswerPath =
    | Readonly<{ kind: 'predicate'; iri: string }>
    | Readonly<{ kind: 'inverse' | 'zeroOrMore' | 'oneOrMore' | 'zeroOrOne'; path: ShaclAnswerPath }>
    | Readonly<{ kind: 'sequence' | 'alternative'; paths: ReadonlyArray<ShaclAnswerPath> }>
    | Readonly<{ kind: 'node'; term: ShaclAnswerTerm }>;

export interface ShaclAnswerResult {
    readonly focusNode: ShaclAnswerTerm;
    readonly resultPath: ShaclAnswerPath | null;
    readonly value: ShaclAnswerTerm | null;
    readonly sourceConstraintComponent: string;
    readonly sourceShape: ShaclAnswerTerm;
    readonly resultSeverity: string;
    readonly resultMessages: ReadonlyArray<Readonly<{ value: string; datatype: string; language: string }>>;
    readonly details: ReadonlyArray<ShaclAnswerResult>;
}

export interface ShaclAnswerReport {
    readonly id: string;
    readonly conforms: boolean;
    readonly results: ReadonlyArray<ShaclAnswerResult>;
    readonly diagnostics: ReadonlyArray<Readonly<{ rule: string; shape: ShaclAnswerTerm; message: string }>>;
}

export interface TrustedShaclAnswer {
    readonly outcome: 'validated';
    readonly tool: ShaclEngineTool;
    readonly reports: ReadonlyArray<ShaclAnswerReport>;
}

export interface ShaclRefusal {
    readonly outcome: 'refused';
    readonly tool: ShaclEngineTool;
    readonly code: string;
    readonly message: string;
    readonly graph: string | null;
}

/** Why an answer is not trusted. Never a pass: the caller fails the check closed. */
export class ShaclAnswerUntrustedError extends Error {
    readonly code = 'SHACL_ANSWER_UNTRUSTED';
    readonly reason: string;

    constructor(reason: string) {
        super(`The erden-shacl answer is not trusted: ${reason}`);
        this.name = 'ShaclAnswerUntrustedError';
        this.reason = reason;
    }
}

/** Why a request could not be written: an input the v1 wire cannot carry. */
export class ShaclRequestEncodingError extends Error {
    readonly code = 'SHACL_REQUEST_UNSUPPORTED';

    constructor(message: string) {
        super(message);
        this.name = 'ShaclRequestEncodingError';
    }
}

// ── Encoding ─────────────────────────────────────────────────────────────────────────────────────────────────────

const IRI_ESCAPE = /[\u0000- <>"{}|^`\\]/gu;
const LITERAL_ESCAPE = /["\\\n\r\t\b\f]/gu;
const LITERAL_ESCAPES: Readonly<Record<string, string>> = {
    '"': '\\"',
    '\\': '\\\\',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\b': '\\b',
    '\f': '\\f',
};

function hex4(character: string): string {
    return `\\u${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

function iriText(value: string): string {
    if (!value.isWellFormed()) {
        throw new ShaclRequestEncodingError('An IRI is not well-formed Unicode');
    }
    return `<${value.replace(IRI_ESCAPE, hex4)}>`;
}

/** One graph's serialization state: the N-Triples text and the wire label of each of its blank nodes. */
class GraphWriter {
    readonly #prefix: string;
    readonly #labels = new Map<string, number>();
    readonly terms: ShaclInputTerm[] = [];
    readonly nodes = new Set<string>();
    readonly severities = new Set<string>();
    #text = '';

    constructor(prefix: 's' | 'd') {
        this.#prefix = prefix;
    }

    #resource(term: ShaclInputTerm, record: boolean): string {
        if (term.termType === 'NamedNode') {
            if (record) {
                this.nodes.add(`N:${term.value}`);
            }
            return iriText(term.value);
        }
        if (term.termType === 'BlankNode') {
            let index = this.#labels.get(term.value);
            if (index === undefined) {
                index = this.terms.length;
                this.#labels.set(term.value, index);
                this.terms.push(term);
            }
            const label = `${this.#prefix}${String(index)}`;
            if (record) {
                this.nodes.add(`B:${label}`);
            }
            return `_:${label}`;
        }
        throw new ShaclRequestEncodingError(`A ${term.termType} term cannot be a subject or object on the v1 wire`);
    }

    #object(term: ShaclInputTerm): string {
        if (term.termType !== 'Literal') {
            return this.#resource(term, true);
        }
        if (typeof term.direction === 'string' && term.direction !== '') {
            throw new ShaclRequestEncodingError('A directional literal cannot be sent on the v1 wire');
        }
        if (!term.value.isWellFormed()) {
            throw new ShaclRequestEncodingError('A literal is not well-formed Unicode');
        }
        const lexical = `"${term.value.replace(LITERAL_ESCAPE, (character) => LITERAL_ESCAPES[character] ?? character)}"`;
        const language = term.language ?? '';
        if (language !== '') {
            return `${lexical}@${language}`;
        }
        const datatype = term.datatype?.value ?? XSD_STRING;
        return datatype === XSD_STRING ? lexical : `${lexical}^^${iriText(datatype)}`;
    }

    add(quad: ShaclInputQuad): void {
        if (quad.predicate.termType !== 'NamedNode') {
            throw new ShaclRequestEncodingError('A predicate must be an IRI on the v1 wire');
        }
        if (quad.predicate.value === SH_SEVERITY && quad.object.termType === 'NamedNode') {
            this.severities.add(quad.object.value);
        }
        this.#text += `${this.#resource(quad.subject, true)} ${iriText(quad.predicate.value)} ${this.#object(quad.object)} .\n`;
    }

    get text(): string {
        return this.#text;
    }
}

function sha256(text: string): string {
    return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** A shapes graph written once, for one request or for every request of a long-lived session. */
export interface PreparedShaclShapes {
    readonly nTriples: string;
    readonly digest: string;
    readonly terms: ReadonlyArray<ShaclInputTerm>;
    /** `N:<iri>` and `B:<wire label>` of every subject and object resource of the shapes graph. */
    readonly nodes: ReadonlySet<string>;
    /** Every built-in severity and every IRI the shapes graph names as an `sh:severity`. */
    readonly severities: ReadonlySet<string>;
}

export function prepareShaclShapes(quads: Iterable<ShaclInputQuad>): PreparedShaclShapes {
    const writer = new GraphWriter('s');
    for (const quad of quads) {
        writer.add(quad);
    }
    const nTriples = writer.text;
    return Object.freeze({
        nTriples,
        digest: sha256(nTriples),
        terms: Object.freeze(writer.terms),
        nodes: writer.nodes,
        severities: new Set([...BUILT_IN_SEVERITIES, ...writer.severities]),
    });
}

export interface ShaclDataGraph {
    readonly id: string;
    readonly quads: Iterable<ShaclInputQuad>;
}

/** A request as written, with what its answer is checked against. */
export interface EncodedShaclRequest {
    readonly line: string;
    readonly requestId: string;
    readonly tool: ShaclEngineTool;
    readonly shapes: PreparedShaclShapes;
    readonly graphs: ReadonlyArray<Readonly<{ id: string; digest: string; terms: ReadonlyArray<ShaclInputTerm> }>>;
    /** Whether the line carries the shapes text (always for one process per check). */
    readonly includesShapesText: boolean;
    /** What a long-lived session keeps one compilation under: the shapes digest and graph IRI. */
    readonly shapesKey: string;
}

const VISIBLE_ASCII = /^[!-~]+$/u;

export interface ShaclRequestInput {
    readonly requestId: string;
    readonly tool: ShaclEngineTool;
    readonly shapes: PreparedShaclShapes;
    readonly graphs: ReadonlyArray<ShaclDataGraph>;
    readonly maxResults: number;
    /** Leave the shapes text out (a long-lived session that already holds its digest). Default false. */
    readonly omitShapesText?: boolean;
    /** The IRI SHACL-SPARQL sees the shapes graph under (`$shapesGraph`). Default none. */
    readonly shapesGraphIri?: string;
}

export function encodeShaclRequest(input: ShaclRequestInput): EncodedShaclRequest {
    if (input.requestId.length > MAX_SHACL_REQUEST_ID_BYTES || !VISIBLE_ASCII.test(input.requestId)) {
        throw new ShaclRequestEncodingError('A request id must be 1 to 1,024 visible ASCII characters');
    }
    if (input.graphs.length === 0 || input.graphs.length > MAX_SHACL_GRAPHS) {
        throw new ShaclRequestEncodingError(`A request names 1 to ${String(MAX_SHACL_GRAPHS)} data graphs`);
    }
    if (input.shapesGraphIri !== undefined && !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/u.test(input.shapesGraphIri)) {
        throw new ShaclRequestEncodingError('shapesGraphIri must be an absolute IRI');
    }
    if (!Number.isSafeInteger(input.maxResults) || input.maxResults <= 0) {
        throw new ShaclRequestEncodingError('maxResults must be a positive safe integer');
    }
    const ids = new Set<string>();
    const graphs: { id: string; digest: string; terms: ReadonlyArray<ShaclInputTerm>; nTriples: string }[] = [];
    for (const graph of input.graphs) {
        if (graph.id.length > 256 || !VISIBLE_ASCII.test(graph.id) || ids.has(graph.id)) {
            throw new ShaclRequestEncodingError('Graph ids must be unique and 1 to 256 visible ASCII characters');
        }
        ids.add(graph.id);
        const writer = new GraphWriter('d');
        for (const quad of graph.quads) {
            writer.add(quad);
        }
        const nTriples = writer.text;
        graphs.push({ id: graph.id, digest: sha256(nTriples), terms: Object.freeze(writer.terms), nTriples });
    }
    const omit = input.omitShapesText === true;
    const line = `${JSON.stringify({
        kind: 'ShaclRequest',
        protocolVersion: SHACL_PROTOCOL_VERSION,
        requestId: input.requestId,
        requiredTool: {
            name: input.tool.name,
            version: input.tool.version,
            engineDigest: input.tool.engineDigest,
            executableDigest: input.tool.executableDigest,
        },
        shapes: {
            digest: input.shapes.digest,
            ...(omit ? {} : { nTriples: input.shapes.nTriples }),
            ...(input.shapesGraphIri === undefined ? {} : { graphIri: input.shapesGraphIri }),
        },
        graphs: graphs.map(({ id, digest, nTriples }) => ({ id, digest, nTriples })),
        limits: { maxResults: input.maxResults },
    })}\n`;
    if (Buffer.byteLength(line) > MAX_SHACL_WIRE_BYTES) {
        throw new ShaclRequestEncodingError(`The request exceeds ${String(MAX_SHACL_WIRE_BYTES)} bytes`);
    }
    return Object.freeze({
        line,
        requestId: input.requestId,
        tool: input.tool,
        shapes: input.shapes,
        graphs: Object.freeze(graphs.map(({ id, digest, terms }) => Object.freeze({ id, digest, terms }))),
        includesShapesText: !omit,
        shapesKey: `${input.shapes.digest}\u0000${input.shapesGraphIri ?? ''}`,
    });
}

// ── Decoding and trust ───────────────────────────────────────────────────────────────────────────────────────────

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json };

function untrusted(reason: string): never {
    throw new ShaclAnswerUntrustedError(reason);
}

type JsonObject = { readonly [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: Json | undefined, key: string): Json | undefined {
    return isObject(value) ? value[key] : undefined;
}

function record(value: Json | undefined, keys: ReadonlyArray<string>, where: string): Readonly<Record<string, Json>> {
    if (!isObject(value)) {
        return untrusted(`${where} is not an object`);
    }
    const actual = Object.keys(value);
    if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
        return untrusted(`${where} has keys ${actual.join(',')} instead of ${keys.join(',')}`);
    }
    return value;
}

function text(value: Json | undefined, where: string): string {
    return typeof value === 'string' ? value : untrusted(`${where} is not a string`);
}

function list(value: Json | undefined, where: string): ReadonlyArray<Json> {
    return Array.isArray(value) ? (value as ReadonlyArray<Json>) : untrusted(`${where} is not an array`);
}

const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

/** Per report: maps wire labels back and checks every reference against the request. */
class ReportScope {
    constructor(
        readonly shapes: PreparedShaclShapes,
        readonly data: ReadonlyArray<ShaclInputTerm>,
    ) {}

    term(value: Json | undefined, where: string): ShaclAnswerTerm {
        const kind = field(value, 'termType');
        if (kind === 'NamedNode') {
            const iri = text(record(value, ['termType', 'value'], where)['value'], `${where}.value`);
            return ABSOLUTE_IRI.test(iri)
                ? Object.freeze({ termType: 'NamedNode', value: iri })
                : untrusted(`${where} is not an IRI`);
        }
        if (kind === 'BlankNode') {
            const label = text(record(value, ['termType', 'value'], where)['value'], `${where}.value`);
            const match = /^([sd])(0|[1-9][0-9]*)$/u.exec(label);
            const index = match === null ? -1 : Number(match[2]);
            const terms = match?.[1] === 's' ? this.shapes.terms : this.data;
            const found = index >= 0 ? terms[index] : undefined;
            return found ?? untrusted(`${where} names the blank node _:${label}, which the request did not send`);
        }
        if (kind === 'Literal') {
            const literal = record(value, ['termType', 'value', 'datatype', 'language'], where);
            const datatype = text(literal['datatype'], `${where}.datatype`);
            const language = text(literal['language'], `${where}.language`);
            if (!ABSOLUTE_IRI.test(datatype) || (language !== '') !== (datatype === RDF_LANG_STRING)) {
                return untrusted(`${where} is not a well-formed literal`);
            }
            return Object.freeze({
                termType: 'Literal',
                value: text(literal['value'], `${where}.value`),
                datatype,
                language,
            });
        }
        return untrusted(`${where} is not a term`);
    }

    path(value: Json | undefined, where: string): ShaclAnswerPath {
        if (!isObject(value)) {
            return untrusted(`${where} is not a path`);
        }
        const [kind, ...rest] = Object.keys(value);
        if (kind === undefined || rest.length > 0) {
            return untrusted(`${where} is not a path`);
        }
        const inner = value[kind];
        switch (kind) {
            case 'predicate': {
                const iri = text(inner, where);
                return ABSOLUTE_IRI.test(iri) ? Object.freeze({ kind, iri }) : untrusted(`${where} is not an IRI`);
            }
            case 'inverse':
            case 'zeroOrMore':
            case 'oneOrMore':
            case 'zeroOrOne':
                return Object.freeze({ kind, path: this.path(inner, `${where}.${kind}`) });
            case 'sequence':
            case 'alternative':
                return Object.freeze({
                    kind,
                    paths: Object.freeze(
                        list(inner, where).map((item, index) => this.path(item, `${where}[${String(index)}]`)),
                    ),
                });
            case 'node':
                return Object.freeze({ kind, term: this.term(inner, `${where}.node`) });
            default:
                return untrusted(`${where} has the unknown path kind ${kind}`);
        }
    }

    result(value: Json | undefined, where: string): ShaclAnswerResult {
        const fields = record(
            value,
            [
                'focusNode',
                'resultPath',
                'value',
                'sourceConstraintComponent',
                'sourceShape',
                'resultSeverity',
                'resultMessages',
                'details',
            ],
            where,
        );
        const sourceShapeJson = fields['sourceShape'];
        const sourceShape = this.term(sourceShapeJson, `${where}.sourceShape`);
        const shapeKey =
            sourceShape.termType === 'NamedNode'
                ? `N:${sourceShape.value}`
                : `B:${text(record(sourceShapeJson, ['termType', 'value'], where)['value'], where)}`;
        if (!this.shapes.nodes.has(shapeKey)) {
            return untrusted(`${where}.sourceShape is not a node of the shapes graph`);
        }
        const severity = text(fields['resultSeverity'], `${where}.resultSeverity`);
        if (!this.shapes.severities.has(severity)) {
            return untrusted(`${where}.resultSeverity ${severity} is neither built in nor used by the shapes graph`);
        }
        const component = text(fields['sourceConstraintComponent'], `${where}.sourceConstraintComponent`);
        if (!ABSOLUTE_IRI.test(component)) {
            return untrusted(`${where}.sourceConstraintComponent is not an IRI`);
        }
        return Object.freeze({
            focusNode: this.term(fields['focusNode'], `${where}.focusNode`),
            resultPath: fields['resultPath'] === null ? null : this.path(fields['resultPath'], `${where}.resultPath`),
            value: fields['value'] === null ? null : this.term(fields['value'], `${where}.value`),
            sourceConstraintComponent: component,
            sourceShape,
            resultSeverity: severity,
            resultMessages: Object.freeze(
                list(fields['resultMessages'], `${where}.resultMessages`).map((message, index) => {
                    const at = `${where}.resultMessages[${String(index)}]`;
                    if (field(message, 'termType') !== 'Literal') {
                        return untrusted(`${at} is not a literal`);
                    }
                    this.term(message, at);
                    const literal = record(message, ['termType', 'value', 'datatype', 'language'], at);
                    return Object.freeze({
                        value: text(literal['value'], at),
                        datatype: text(literal['datatype'], at),
                        language: text(literal['language'], at),
                    });
                }),
            ),
            details: Object.freeze(
                list(fields['details'], `${where}.details`).map((detail, index) =>
                    this.result(detail, `${where}.details[${String(index)}]`),
                ),
            ),
        });
    }
}

function sameTool(actual: Readonly<Record<string, Json>>, expected: ShaclEngineTool): boolean {
    return (
        actual['name'] === expected.name &&
        actual['version'] === expected.version &&
        actual['engineDigest'] === expected.engineDigest &&
        actual['executableDigest'] === expected.executableDigest
    );
}

/**
 * Decodes one answer line (with its newline) to the request it answers and checks it: the strict v1 shape, the
 * envelope, the tool, the shapes and graph digests in order, every blank node and source shape, every severity and
 * every report's verdict. A refusal is returned as such; anything untrusted throws `ShaclAnswerUntrustedError`.
 */
export function decodeTrustedShaclAnswer(
    line: string,
    request: EncodedShaclRequest,
): TrustedShaclAnswer | ShaclRefusal {
    if (!line.endsWith('\n') || line.indexOf('\n') !== line.length - 1) {
        return untrusted('the answer is not exactly one line ending in a newline');
    }
    let parsed: Json;
    try {
        parsed = JSON.parse(line) as Json;
    } catch {
        return untrusted('the answer is not JSON');
    }
    const outcome = field(parsed, 'outcome');
    const envelope = ['kind', 'protocolVersion', 'requestId', 'tool', 'outcome'];
    const answer = record(
        parsed,
        outcome === 'validated' ? [...envelope, 'shapesDigest', 'reports'] : [...envelope, 'refusal'],
        'the answer',
    );
    if (answer['kind'] !== 'ShaclAnswer' || answer['protocolVersion'] !== SHACL_PROTOCOL_VERSION) {
        return untrusted('the answer is not a v1 ShaclAnswer');
    }
    const tool = record(answer['tool'], ['name', 'version', 'engineDigest', 'executableDigest'], 'the answer tool');
    if (!sameTool(tool, request.tool)) {
        return untrusted('the answering tool is not the resolved erden-shacl executable');
    }
    if (outcome === 'refused') {
        const refusal = record(answer['refusal'], ['code', 'message', 'graph'], 'the refusal');
        const graph = refusal['graph'];
        if (answer['requestId'] !== null && answer['requestId'] !== request.requestId) {
            return untrusted('the refusal answers another request');
        }
        if (graph !== null && !request.graphs.some((item) => item.id === graph)) {
            return untrusted('the refusal names a graph the request did not send');
        }
        return Object.freeze({
            outcome: 'refused',
            tool: request.tool,
            code: text(refusal['code'], 'the refusal code'),
            message: text(refusal['message'], 'the refusal message'),
            graph: graph === null ? null : text(graph, 'the refusal graph'),
        });
    }
    if (outcome !== 'validated') {
        return untrusted('the answer outcome is neither validated nor refused');
    }
    if (answer['requestId'] !== request.requestId) {
        return untrusted('the answer is for another request');
    }
    if (answer['shapesDigest'] !== request.shapes.digest) {
        return untrusted('the answer validated another shapes graph');
    }
    const reports = list(answer['reports'], 'the reports');
    if (reports.length !== request.graphs.length) {
        return untrusted('the answer has a different number of reports than the request has graphs');
    }
    return Object.freeze({
        outcome: 'validated',
        tool: request.tool,
        reports: Object.freeze(
            reports.map((value, index) => {
                const sent = request.graphs[index];
                const where = `report ${String(index)}`;
                const report = record(value, ['id', 'digest', 'conforms', 'results', 'diagnostics'], where);
                if (sent === undefined || report['id'] !== sent.id || report['digest'] !== sent.digest) {
                    return untrusted(`${where} is not bound to graph ${sent?.id ?? '?'} as sent`);
                }
                if (typeof report['conforms'] !== 'boolean') {
                    return untrusted(`${where}.conforms is not a boolean`);
                }
                const scope = new ReportScope(request.shapes, sent.terms);
                const results = list(report['results'], `${where}.results`).map((result, position) =>
                    scope.result(result, `${where}.results[${String(position)}]`),
                );
                if (report['conforms'] === results.some((result) => DISALLOWED.has(result.resultSeverity))) {
                    return untrusted(`${where}.conforms contradicts its results`);
                }
                const diagnostics = list(report['diagnostics'], `${where}.diagnostics`).map((diagnostic, position) => {
                    const fields = record(
                        diagnostic,
                        ['rule', 'shape', 'message'],
                        `${where}.diagnostics[${String(position)}]`,
                    );
                    return Object.freeze({
                        rule: text(fields['rule'], 'a diagnostic rule'),
                        shape: scope.term(fields['shape'], 'a diagnostic shape'),
                        message: text(fields['message'], 'a diagnostic message'),
                    });
                });
                return Object.freeze({
                    id: sent.id,
                    conforms: report['conforms'],
                    results: Object.freeze(results),
                    diagnostics: Object.freeze(diagnostics),
                });
            }),
        ),
    });
}
