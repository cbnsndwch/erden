import { DataFactory, Lexer, Parser, type Quad } from 'n3';

import { quadKey } from '../assembly.js';
import type { LoadedTurtleSource } from '../model.js';
import { RDF } from '../model.js';

import { sourceMediaType, parseOntologySourceText, sourceBlankNodePrefix } from './parse.js';
import { rdfXmlBodyStart } from './rdfxml-guard.js';

/**
 * Where each statement of one source is written, found by reading the source text again. Assembly does not keep
 * positions, so passing checks pay nothing; only a check with something to report reads its sources a second time.
 *
 * - Turtle and N-Triples: the same n3 parse as assembly, with the same blank-node labels, noting the token each term
 *   came from. A statement is at its predicate, or at its object when that starts on a later line (an object list
 *   over several lines); with the shared `a` keyword, at its object.
 * - RDF/XML: the document again with a marker element before each top-level node element, through the same Oxigraph
 *   parse. Markers are IRIs, so blank-node labels, which follow first appearance, do not move; every statement
 *   between two markers comes from the element between them. A statement about that element's own subject is at the
 *   property element that states it, counted in order; any other statement is at the element's start tag.
 * - JSON-LD: likewise, with a marker node object before each element of the top-level array or `@graph` array.
 *
 * The marked parse must give exactly the statements assembly read, with the same keys; otherwise positions are
 * unknown for that source rather than wrong.
 *
 * Lines and columns count from 1. Columns count UTF-16 code units, as JavaScript strings and most editors' column
 * readouts do for text without astral characters.
 */
export interface SourcePosition {
    readonly line: number;
    readonly column: number;
}

const MARKER_NAMESPACE = 'urn:erden-position:';
const MARKER_TYPE = `${MARKER_NAMESPACE}Marker`;
const RDF_TYPE = `${RDF}type`;
const RDF_DESCRIPTION = `${RDF}Description`;
const RDF_RDF = `${RDF}RDF`;
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

/** Line starts of one text, for offset-to-position lookups. */
class LineIndex {
    readonly #starts: number[] = [0];
    readonly #text: string;

    constructor(text: string) {
        this.#text = text;
        for (let index = 0; index < text.length; index += 1) {
            const character = text.charCodeAt(index);
            if (character === 10 || (character === 13 && text.charCodeAt(index + 1) !== 10)) {
                this.#starts.push(index + 1);
            }
        }
    }

    position(offset: number): SourcePosition {
        let low = 0;
        let high = this.#starts.length - 1;
        while (low < high) {
            const middle = (low + high + 1) >> 1;
            if ((this.#starts[middle] as number) <= offset) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        return { line: low + 1, column: offset - (this.#starts[low] as number) + 1 };
    }

    /** The column of the first character on a line that is not a space or a tab. */
    firstNonBlankColumn(line: number): number {
        const start = this.#starts[line - 1];
        if (start === undefined) {
            return 1;
        }
        let index = start;
        while (this.#text[index] === ' ' || this.#text[index] === '\t') {
            index += 1;
        }
        return index - start + 1;
    }

    lineLength(line: number): number {
        const start = this.#starts[line - 1] ?? 0;
        const next = this.#starts[line] ?? this.#text.length;
        return next - start;
    }
}

interface N3Token {
    readonly line: number;
    readonly start?: number;
}

interface TrackedN3Options {
    readonly baseIri: string | undefined;
    readonly blankNodePrefix: string;
    /** The label of the nth anonymous blank node (counting from 1), as the parse being located names it. */
    readonly anonymousLabel: (index: number) => string;
    readonly format: 'text/turtle' | 'application/n-triples';
}

/** The statements of one n3 parse, and the position of each by quad key. */
export interface LocatedStatements {
    readonly quads: ReadonlyArray<Quad>;
    readonly positions: ReadonlyMap<string, SourcePosition>;
}

/**
 * An n3 parse that notes for every term the token it came from. n3 measures a token's `start` from the first
 * non-blank character of its line (the newline rule consumes the indentation), except on the first line.
 */
function trackedN3Parse(text: string, options: TrackedN3Options): LocatedStatements {
    const lines = new LineIndex(text);
    let anonymousBlankIndex = 0;
    let current: N3Token | undefined;
    const termPositions = new WeakMap<object, SourcePosition>();
    const positions = new Map<string, SourcePosition>();
    function tokenPosition(token: N3Token): SourcePosition {
        const start = typeof token.start === 'number' ? token.start : 0;
        const base = token.line === 1 ? 1 : lines.firstNonBlankColumn(token.line);
        const column = base + start;
        return { line: token.line, column: column <= lines.lineLength(token.line) ? column : base };
    }
    function mark<T extends object>(term: T): T {
        if (current !== undefined) {
            termPositions.set(term, tokenPosition(current));
        }
        return term;
    }
    const factory = {
        ...DataFactory,
        namedNode: (value: string) => mark(DataFactory.namedNode(value)),
        blankNode: (value?: string) =>
            mark(DataFactory.blankNode(value ?? options.anonymousLabel((anonymousBlankIndex += 1)))),
        literal: (value: string, tag?: Parameters<typeof DataFactory.literal>[1]) =>
            mark(DataFactory.literal(value, tag)),
        quad: (
            subject: Quad['subject'],
            predicate: Quad['predicate'],
            object: Quad['object'],
            graph?: Quad['graph'],
        ) => {
            const quad = DataFactory.quad(subject, predicate, object, graph);
            const key = quadKey(quad);
            if (!positions.has(key)) {
                const atPredicate = termPositions.get(predicate);
                const atObject = termPositions.get(object);
                positions.set(
                    key,
                    (atPredicate !== undefined && atObject !== undefined && atObject.line > atPredicate.line
                        ? atObject
                        : (atPredicate ?? atObject ?? termPositions.get(subject))) ??
                        (current === undefined ? { line: 1, column: 1 } : tokenPosition(current)),
                );
            }
            return quad;
        },
    };
    const lexer = new Lexer({ lineMode: options.format === 'application/n-triples', n3: false });
    // n3's synchronous parse walks the token array with `every`; this lexer hands it one that notes each token first.
    const tracking = Object.create(lexer) as { tokenize: (input: string) => unknown };
    tracking.tokenize = (input: string) => {
        const tokens = lexer.tokenize(input) as unknown as ReadonlyArray<N3Token>;
        return {
            every(step: (token: N3Token) => unknown): boolean {
                for (const token of tokens) {
                    current = token;
                    if (!step(token)) {
                        return false;
                    }
                }
                return true;
            },
        };
    };
    const quads = new Parser({
        ...(options.baseIri === undefined ? {} : { baseIRI: options.baseIri }),
        blankNodePrefix: options.blankNodePrefix,
        format: options.format,
        factory,
        lexer: tracking,
    } as ConstructorParameters<typeof Parser>[0]).parse(text);
    return { quads, positions };
}

/** The n3 parse assembly runs, with assembly's blank-node labels, so its quad keys match assembly's. */
function n3Positions(
    source: LoadedTurtleSource,
    format: 'text/turtle' | 'application/n-triples',
): ReadonlyMap<string, SourcePosition> {
    const sourcePrefix = sourceBlankNodePrefix(source.descriptor.id);
    const { quads, positions } = trackedN3Parse(source.text, {
        baseIri: source.descriptor.baseIri,
        blankNodePrefix: sourcePrefix,
        anonymousLabel: (index) => `${sourcePrefix}/anonymous/${String(index)}`,
        format,
    });
    return quads.length === source.tripleCount ? positions : new Map<string, SourcePosition>();
}

/**
 * Parses one Turtle text again and locates each of its statements, for sources outside assembly such as SHACL
 * shapes. Labelled blank nodes keep `blankNodePrefix`; anonymous ones get labels of their own, so a caller matches
 * statements by reading this parse's quads rather than another parse's. Undefined when the text does not parse or
 * gives a different number of statements than `expectedCount`.
 */
export function locateTurtleText(
    text: string,
    options: { readonly baseIri: string | undefined; readonly blankNodePrefix: string; readonly expectedCount: number },
): LocatedStatements | undefined {
    try {
        const located = trackedN3Parse(text, {
            baseIri: options.baseIri,
            blankNodePrefix: options.blankNodePrefix,
            anonymousLabel: (index) => `${options.blankNodePrefix}located_${String(index)}`,
            format: 'text/turtle',
        });
        return located.quads.length === options.expectedCount ? located : undefined;
    } catch {
        return undefined;
    }
}

interface XmlElement {
    readonly start: number;
    readonly name: string;
    readonly attributes: ReadonlyArray<readonly [string, string]>;
    readonly namespaces: ReadonlyMap<string, string>;
    readonly children: XmlElement[];
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function expandEntities(value: string, entities: ReadonlyMap<string, string>): string {
    return value.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[^\s&;#<>"']+);/gu, (whole, name: string) => {
        if (name.startsWith('#x')) {
            return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
        }
        if (name.startsWith('#')) {
            return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
        }
        return PREDEFINED_ENTITIES[name] ?? entities.get(name) ?? whole;
    });
}

function internalEntities(text: string, bodyStart: number): ReadonlyMap<string, string> {
    const entities = new Map<string, string>();
    for (const match of text.slice(0, bodyStart).matchAll(/<!ENTITY\s+([^\s%]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/gu)) {
        entities.set(match[1] as string, match[2] ?? match[3] ?? '');
    }
    return entities;
}

/** The `>` closing the tag at `start`, skipping quoted attribute values. */
function tagEnd(text: string, start: number): number {
    let quote: string | undefined;
    for (let index = start + 1; index < text.length; index += 1) {
        const character = text[index];
        if (quote !== undefined) {
            if (character === quote) {
                quote = undefined;
            }
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '>') {
            return index;
        }
    }
    return -1;
}

const MARKUP: ReadonlyArray<readonly [string, string]> = [
    ['<!--', '-->'],
    ['<![CDATA[', ']]>'],
    ['<?', '?>'],
    ['<!', '>'],
];

function expandName(qualified: string, namespaces: ReadonlyMap<string, string>, attribute: boolean): string | null {
    const colon = qualified.indexOf(':');
    if (colon < 0) {
        return attribute ? null : `${namespaces.get('') ?? ''}${qualified}`;
    }
    const prefix = qualified.slice(0, colon);
    if (prefix === 'xml') {
        return `${XML_NAMESPACE}#${qualified.slice(colon + 1)}`;
    }
    const namespace = namespaces.get(prefix);
    return namespace === undefined ? null : `${namespace}${qualified.slice(colon + 1)}`;
}

/**
 * The root element and the two levels below it, with start offsets and namespaces in scope. Markup it cannot follow
 * ends the scan early; the parse that follows is what decides whether the positions hold.
 */
function scanXml(text: string, from: number, entities: ReadonlyMap<string, string>): XmlElement | undefined {
    const stack: Array<{ readonly namespaces: ReadonlyMap<string, string>; readonly element: XmlElement | undefined }> =
        [];
    let root: XmlElement | undefined;
    let index = text.indexOf('<', from);
    while (index >= 0) {
        const markup = MARKUP.find(([opening]) => text.startsWith(opening, index));
        let end: number;
        if (markup !== undefined) {
            const terminator = text.indexOf(markup[1], index + markup[0].length);
            end = terminator < 0 ? -1 : terminator + markup[1].length - 1;
        } else if (text.startsWith('</', index)) {
            end = text.indexOf('>', index);
            stack.pop();
        } else {
            end = tagEnd(text, index);
            if (end < 0) {
                return root;
            }
            const selfClosing = text[end - 1] === '/';
            const body = text.slice(index + 1, selfClosing ? end - 1 : end);
            const name = /^[^\s/>]+/u.exec(body)?.[0] ?? '';
            const attributes = [...body.slice(name.length).matchAll(ATTRIBUTE)].map(
                (match) => [match[1] as string, expandEntities(match[2] ?? match[3] ?? '', entities)] as const,
            );
            const inherited = stack.at(-1)?.namespaces ?? new Map<string, string>();
            const declared = attributes.filter(([key]) => key === 'xmlns' || key.startsWith('xmlns:'));
            const namespaces =
                declared.length === 0
                    ? inherited
                    : new Map([
                          ...inherited,
                          ...declared.map(([key, value]) => [key === 'xmlns' ? '' : key.slice(6), value] as const),
                      ]);
            const depth = stack.length;
            const element: XmlElement | undefined =
                depth <= 2 ? { start: index, name, attributes, namespaces, children: [] } : undefined;
            if (depth === 0) {
                root = element;
            } else if (element !== undefined) {
                stack.at(-1)?.element?.children.push(element);
            }
            if (!selfClosing) {
                stack.push({ namespaces, element });
            }
        }
        if (end < 0) {
            return root;
        }
        index = text.indexOf('<', end + 1);
    }
    return root;
}

const RDF_SYNTAX_ATTRIBUTES = new Set(
    ['about', 'ID', 'nodeID', 'resource', 'datatype', 'parseType', 'bagID', 'aboutEach', 'aboutEachPrefix'].map(
        (name) => `${RDF}${name}`,
    ),
);

/** The predicates a node element's start tag states: its type, unless it is rdf:Description, and property attributes. */
function startTagPredicates(element: XmlElement): Map<string, number> {
    const counts = new Map<string, number>();
    const type = expandName(element.name, element.namespaces, false);
    if (type !== null && type !== RDF_DESCRIPTION) {
        counts.set(RDF_TYPE, 1);
    }
    for (const [key] of element.attributes) {
        if (key === 'xmlns' || key.startsWith('xmlns:')) {
            continue;
        }
        const predicate = expandName(key, element.namespaces, true);
        if (predicate === null || RDF_SYNTAX_ATTRIBUTES.has(predicate) || predicate.startsWith(XML_NAMESPACE)) {
            continue;
        }
        counts.set(predicate, (counts.get(predicate) ?? 0) + 1);
    }
    return counts;
}

function attribute(element: XmlElement, name: string): string | undefined {
    return element.attributes.find(([key]) => expandName(key, element.namespaces, true) === name)?.[1];
}

/**
 * The IRI a node element's rdf:about names: as written when absolute (OWL tools write it so), else resolved against
 * the element's or the document's xml:base, or the source's base IRI. A statement whose subject differs is located at
 * the element's start tag, so a resolution that disagrees with the parser's only costs precision.
 */
function aboutIri(element: XmlElement, base: string | undefined): string | undefined {
    const about = attribute(element, `${RDF}about`);
    if (about === undefined) {
        return undefined;
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(about)) {
        return about;
    }
    try {
        return new URL(about, attribute(element, `${XML_NAMESPACE}#base`) ?? base).href;
    } catch {
        return undefined;
    }
}

interface Fragment {
    readonly element: XmlElement;
    readonly quads: Quad[];
}

/** Positions from fragments: each statement at its property element when it can be counted, else its element. */
function fragmentPositions(
    lines: LineIndex,
    fragments: ReadonlyArray<Fragment>,
    base: string | undefined,
): Map<string, SourcePosition> {
    const positions = new Map<string, SourcePosition>();
    for (const { element, quads } of fragments) {
        const at = lines.position(element.start);
        const subject = aboutIri(element, base);
        const fromStartTag = startTagPredicates(element);
        const children = new Map<string, XmlElement[]>();
        for (const child of element.children) {
            const predicate = expandName(child.name, child.namespaces, false);
            if (predicate !== null) {
                children.set(predicate, [...(children.get(predicate) ?? []), child]);
            }
        }
        const seen = new Map<string, number>();
        for (const quad of quads) {
            let position = at;
            if (subject !== undefined && quad.subject.termType === 'NamedNode' && quad.subject.value === subject) {
                const predicate = quad.predicate.value;
                const index = seen.get(predicate) ?? 0;
                seen.set(predicate, index + 1);
                const child = children.get(predicate)?.[index - (fromStartTag.get(predicate) ?? 0)];
                if (child !== undefined) {
                    position = lines.position(child.start);
                }
            }
            const key = quadKey(quad);
            if (!positions.has(key)) {
                positions.set(key, position);
            }
        }
    }
    return positions;
}

function marker(index: number, kind: 'xml' | 'json'): string {
    return kind === 'xml'
        ? `<erdenpos:Marker xmlns:erdenpos="${MARKER_NAMESPACE}" xmlns:erdenrdf="${RDF}" erdenrdf:about="${MARKER_NAMESPACE}${String(index)}"/>`
        : `{"@id":"${MARKER_NAMESPACE}${String(index)}","@type":"${MARKER_TYPE}"},`;
}

function isMarker(quad: Quad): number | undefined {
    if (
        quad.predicate.value !== RDF_TYPE ||
        quad.object.termType !== 'NamedNode' ||
        quad.object.value !== MARKER_TYPE ||
        !quad.subject.value.startsWith(MARKER_NAMESPACE)
    ) {
        return undefined;
    }
    return Number(quad.subject.value.slice(MARKER_NAMESPACE.length));
}

/**
 * Parses the marked text and splits its statements between the markers. Undefined unless the statements are exactly
 * the ones assembly read for this source, in number and in keys.
 */
function splitAtMarkers(
    source: LoadedTurtleSource,
    text: string,
    elements: ReadonlyArray<XmlElement>,
    sourceKeys: ReadonlySet<string>,
    marked: boolean,
): ReadonlyArray<Fragment> | undefined {
    const quads = parseOntologySourceText(source.descriptor, text);
    const fragments = elements.map((element) => ({ element, quads: [] as Quad[] }));
    // Without markers there is one fragment, the whole document.
    let current: Fragment | undefined = marked ? undefined : fragments[0];
    let count = 0;
    for (const quad of quads) {
        const index = marked ? isMarker(quad) : undefined;
        if (index !== undefined) {
            current = fragments[index];
            continue;
        }
        count += 1;
        if (current === undefined || !sourceKeys.has(quadKey(quad))) {
            return undefined;
        }
        current.quads.push(quad);
    }
    return count === source.tripleCount ? fragments : undefined;
}

function insertMarkers(text: string, offsets: ReadonlyArray<number>, kind: 'xml' | 'json'): string {
    let marked = '';
    let previous = 0;
    offsets.forEach((offset, index) => {
        marked += text.slice(previous, offset) + marker(index, kind);
        previous = offset;
    });
    return marked + text.slice(previous);
}

function rdfXmlPositions(source: LoadedTurtleSource, sourceKeys: ReadonlySet<string>): Map<string, SourcePosition> {
    const text = source.text;
    const bodyStart = rdfXmlBodyStart(text);
    const root = scanXml(text, bodyStart, internalEntities(text, bodyStart));
    if (root === undefined) {
        return new Map<string, SourcePosition>();
    }
    const wrapped = expandName(root.name, root.namespaces, false) === RDF_RDF;
    const elements = wrapped ? root.children : [root];
    if (elements.length === 0) {
        return new Map<string, SourcePosition>();
    }
    const marked = wrapped
        ? insertMarkers(
              text,
              elements.map((element) => element.start),
              'xml',
          )
        : text;
    const fragments = splitAtMarkers(source, marked, elements, sourceKeys, wrapped);
    const base = (wrapped ? attribute(root, `${XML_NAMESPACE}#base`) : undefined) ?? source.descriptor.baseIri;
    return fragments === undefined
        ? new Map<string, SourcePosition>()
        : fragmentPositions(new LineIndex(text), fragments, base);
}

/** Start offsets of the elements of the top-level JSON array, or of a top-level object's `@graph` array. */
function jsonElements(text: string): ReadonlyArray<number> {
    const starts: number[] = [];
    let depth = 0;
    let graphDepth: number | undefined;
    let expectValue = false;
    let lastKey: string | undefined;
    let topLevelArray = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index] as string;
        if (character === ' ' || character === '\n' || character === '\r' || character === '\t' || character === '﻿') {
            continue;
        }
        const elementDepth = topLevelArray ? 1 : graphDepth;
        if (elementDepth !== undefined && depth === elementDepth && expectValue && character !== ']') {
            starts.push(index);
            expectValue = false;
        }
        if (character === '"') {
            let end = index + 1;
            while (end < text.length && text[end] !== '"') {
                end += text[end] === '\\' ? 2 : 1;
            }
            if (depth === 1 && !topLevelArray) {
                lastKey = text.slice(index + 1, end);
            }
            index = end;
            continue;
        }
        if (character === '[' || character === '{') {
            if (depth === 0 && character === '[') {
                topLevelArray = true;
                expectValue = true;
            } else if (depth === 1 && !topLevelArray && character === '[' && lastKey === '@graph') {
                graphDepth = 2;
                expectValue = true;
            }
            depth += 1;
            continue;
        }
        if (character === ']' || character === '}') {
            depth -= 1;
            continue;
        }
        if (character === ',' && depth === (topLevelArray ? 1 : graphDepth)) {
            expectValue = true;
        }
    }
    return starts;
}

function jsonLdPositions(source: LoadedTurtleSource, sourceKeys: ReadonlySet<string>): Map<string, SourcePosition> {
    const starts = jsonElements(source.text);
    const marked = starts.length > 0;
    // A document that is one node object has one fragment: everything is located at its opening brace.
    const offsets = marked ? starts : [Math.max(0, source.text.search(/[[{]/u))];
    const elements = offsets.map((start): XmlElement => ({
        start,
        name: '',
        attributes: [],
        namespaces: new Map(),
        children: [],
    }));
    const text = marked ? insertMarkers(source.text, starts, 'json') : source.text;
    const fragments = splitAtMarkers(source, text, elements, sourceKeys, marked);
    return fragments === undefined
        ? new Map<string, SourcePosition>()
        : fragmentPositions(new LineIndex(source.text), fragments, undefined);
}

/**
 * The position of every statement of one source, by quad key; empty when the source's positions cannot be
 * established. `sourceKeys` are the keys assembly recorded for this source.
 */
export function locateSourceStatements(
    source: LoadedTurtleSource,
    sourceKeys: ReadonlySet<string>,
): ReadonlyMap<string, SourcePosition> {
    try {
        const mediaType = sourceMediaType(source.descriptor);
        switch (mediaType) {
            case 'text/turtle':
            case 'application/n-triples':
                return n3Positions(source, mediaType);
            case 'application/rdf+xml':
                return rdfXmlPositions(source, sourceKeys);
            case 'application/ld+json':
                return jsonLdPositions(source, sourceKeys);
        }
    } catch {
        // The source parsed once already; a second read that fails only means no positions.
        return new Map<string, SourcePosition>();
    }
}
