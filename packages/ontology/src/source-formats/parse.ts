import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { DataFactory, Parser, type Quad } from 'n3';

import {
    OntologyAssemblyLimitError,
    OntologySourceParseError,
    OntologySourceRefusedError,
    TurtleSourceEncodingError,
    TurtleSourceParseError,
    UnsupportedSemanticFormatError,
    type OntologySourceLocation,
    type OntologySourceRefusalReason,
} from '../errors.js';
import type { TurtleSourceDescriptor } from '../model.js';
import { withOxigraph } from '../oxigraph-runtime.js';

import { ONTOLOGY_SOURCE_EXTENSIONS, ontologyMediaTypeForLocator, type OntologyMediaType } from './formats.js';
import { jsonLdRemoteContext, jsonLdStructureRefusal, type JsonLdGuardReason } from './jsonld-guard.js';
import { rdfXmlGuardRefusal, type RdfXmlGuardReason } from './rdfxml-guard.js';

interface OxigraphTerm {
    readonly termType: string;
    readonly value: string;
    readonly language?: string;
    readonly direction?: string;
    readonly datatype?: { readonly value: string };
}

interface OxigraphQuad {
    readonly subject: OxigraphTerm;
    readonly predicate: OxigraphTerm;
    readonly object: OxigraphTerm;
    readonly graph: OxigraphTerm;
}

interface OxigraphParser {
    readonly parse: (
        input: Iterable<string>,
        options: { readonly format: string; readonly base_iri?: string },
    ) => IterableIterator<OxigraphQuad>;
}

/** n3 2.1.1 builds RDF 1.2 directional literals from this argument shape; its type declarations predate it. */
function directionalLiteral(
    value: string,
    tag: { readonly language: string; readonly direction: 'ltr' | 'rtl' },
): Quad['object'] {
    return DataFactory.literal(value, tag as unknown as string);
}

export type OntologySourceParseFailure =
    | OntologyAssemblyLimitError
    | OntologySourceParseError
    | OntologySourceRefusedError
    | TurtleSourceEncodingError
    | TurtleSourceParseError
    | UnsupportedSemanticFormatError;

/** The blank-node label prefix of one source: unique per source ID, identical across parses. */
export function sourceBlankNodePrefix(sourceId: string): string {
    return `erden_${createHash('sha256').update(sourceId).digest('hex')}_`;
}

function assertQuadCapacity(maximumQuads: number | undefined): void {
    if (maximumQuads !== undefined && (!Number.isSafeInteger(maximumQuads) || maximumQuads < 0)) {
        throw new OntologyAssemblyLimitError('statements');
    }
}

/** The media type the descriptor's extension names; a descriptor that disagrees with it is refused. */
export function sourceMediaType(descriptor: TurtleSourceDescriptor): OntologyMediaType {
    const mediaType = ontologyMediaTypeForLocator(descriptor.locator);
    if (mediaType === undefined || mediaType !== descriptor.mediaType) {
        throw new UnsupportedSemanticFormatError('source', descriptor.locator, ONTOLOGY_SOURCE_EXTENSIONS);
    }
    return mediaType;
}

interface N3ParseContext {
    readonly line?: unknown;
    readonly token?: {
        readonly start?: unknown;
    };
}

function n3Location(locator: string, cause: unknown): { file: string; line: number; column: number } {
    const context =
        cause !== null && typeof cause === 'object' && 'context' in cause
            ? (cause as { readonly context?: N3ParseContext }).context
            : undefined;
    const line = typeof context?.line === 'number' ? context.line : 1;
    const start = typeof context?.token?.start === 'number' ? context.token.start : 0;
    return { file: locator, line, column: start + 1 };
}

function parseWithN3(
    descriptor: TurtleSourceDescriptor,
    text: string,
    format: 'text/turtle' | 'application/n-triples',
    maximumQuads: number | undefined,
): ReadonlyArray<Quad> {
    try {
        const sourcePrefix = sourceBlankNodePrefix(descriptor.id);
        let anonymousBlankIndex = 0;
        let quadCount = 0;
        const factory = {
            ...DataFactory,
            ...(maximumQuads === undefined
                ? {}
                : {
                      quad: (
                          subject: Quad['subject'],
                          predicate: Quad['predicate'],
                          object: Quad['object'],
                          graph?: Quad['graph'],
                      ) => {
                          quadCount += 1;
                          if (quadCount > maximumQuads) {
                              throw new OntologyAssemblyLimitError('statements');
                          }
                          return DataFactory.quad(subject, predicate, object, graph);
                      },
                  }),
            blankNode: (value?: string) =>
                DataFactory.blankNode(value ?? `${sourcePrefix}/anonymous/${String((anonymousBlankIndex += 1))}`),
        };
        return new Parser({
            baseIRI: descriptor.baseIri,
            blankNodePrefix: sourcePrefix,
            format,
            factory,
        }).parse(text);
    } catch (cause) {
        if (cause instanceof OntologyAssemblyLimitError) {
            throw cause;
        }
        throw new TurtleSourceParseError(descriptor.id, n3Location(descriptor.locator, cause), cause);
    }
}

function oxigraphLocation(locator: string, cause: unknown): OntologySourceLocation {
    const message = cause instanceof Error ? cause.message : String(cause);
    const position = /\bline (\d+) column (\d+)\b/u.exec(message);
    return position === null
        ? { file: locator }
        : { file: locator, line: Number(position[1]), column: Number(position[2]) };
}

class Relabeller {
    readonly #labels = new Map<string, string>();
    readonly #prefix: string;

    constructor(prefix: string) {
        this.#prefix = prefix;
    }

    /** Numbers blank nodes in order of first appearance, replacing the parser's random labels. */
    label(value: string): string {
        let label = this.#labels.get(value);
        if (label === undefined) {
            label = `${this.#prefix}${String(this.#labels.size + 1)}`;
            this.#labels.set(value, label);
        }
        return label;
    }
}

function convertTerm(
    descriptor: TurtleSourceDescriptor,
    term: OxigraphTerm,
    relabel: Relabeller,
): Quad['subject'] | Quad['object'] {
    switch (term.termType) {
        case 'NamedNode':
            return DataFactory.namedNode(term.value);
        case 'BlankNode':
            return DataFactory.blankNode(relabel.label(term.value));
        case 'Literal': {
            const language = term.language ?? '';
            if (language !== '') {
                const direction = term.direction ?? '';
                return direction === ''
                    ? DataFactory.literal(term.value, language)
                    : directionalLiteral(term.value, { language, direction: direction as 'ltr' | 'rtl' });
            }
            return DataFactory.literal(term.value, DataFactory.namedNode(term.datatype?.value ?? ''));
        }
        default:
            throw new OntologySourceRefusedError(
                descriptor.id,
                descriptor.locator,
                'triple-term',
                'RDF 1.2 triple terms are not read yet',
            );
    }
}

function parseWithOxigraph(
    descriptor: TurtleSourceDescriptor,
    text: string,
    format: 'application/rdf+xml' | 'application/ld+json',
    maximumQuads: number | undefined,
): ReadonlyArray<Quad> {
    try {
        return withOxigraph((module) => {
            const oxigraph = module as OxigraphParser;
            const relabel = new Relabeller(sourceBlankNodePrefix(descriptor.id));
            const quads: Quad[] = [];
            for (const quad of oxigraph.parse([text], { format, base_iri: descriptor.baseIri })) {
                if (quad.graph.termType !== 'DefaultGraph') {
                    throw new OntologySourceRefusedError(
                        descriptor.id,
                        descriptor.locator,
                        'named-graph',
                        'named graphs are not read yet; only the default graph is read',
                    );
                }
                if (maximumQuads !== undefined && quads.length >= maximumQuads) {
                    throw new OntologyAssemblyLimitError('statements');
                }
                quads.push(
                    DataFactory.quad(
                        convertTerm(descriptor, quad.subject, relabel) as Quad['subject'],
                        DataFactory.namedNode(quad.predicate.value),
                        convertTerm(descriptor, quad.object, relabel),
                    ),
                );
            }
            return quads;
        });
    } catch (cause) {
        if (cause instanceof OntologyAssemblyLimitError || cause instanceof OntologySourceRefusedError) {
            throw cause;
        }
        throw new OntologySourceParseError(descriptor.id, format, oxigraphLocation(descriptor.locator, cause), cause);
    }
}

function refuse(
    descriptor: TurtleSourceDescriptor,
    reason: OntologySourceRefusalReason,
    detail: string,
): OntologySourceRefusedError {
    return new OntologySourceRefusedError(descriptor.id, descriptor.locator, reason, detail);
}

const XML_REASONS: Readonly<Record<RdfXmlGuardReason, OntologySourceRefusalReason>> = Object.freeze({
    'encoding-declaration': 'xml-encoding-declaration',
    'external-dtd': 'xml-external-dtd',
    'external-entity': 'xml-external-entity',
    'parameter-entity': 'xml-parameter-entity',
    'entity-reference-in-value': 'xml-entity-reference-in-value',
    'internal-subset-too-large': 'xml-internal-subset-too-large',
    'entity-expansion-too-large': 'xml-entity-expansion-too-large',
    'malformed-document-type': 'xml-malformed-document-type',
    'nesting-too-deep': 'xml-nesting-too-deep',
});

const JSON_LD_REASONS: Readonly<Record<JsonLdGuardReason, OntologySourceRefusalReason>> = Object.freeze({
    'nesting-too-deep': 'jsonld-nesting-too-deep',
    'duplicate-key': 'jsonld-duplicate-key',
});

/**
 * The source format port: parses decoded UTF-8 text with the parser its extension names. Turtle takes the same
 * n3 path as before multi-format sources, so Turtle quads and blank-node labels are unchanged.
 */
export function parseOntologySourceText(
    descriptor: TurtleSourceDescriptor,
    text: string,
    maximumQuads?: number,
): ReadonlyArray<Quad> {
    assertQuadCapacity(maximumQuads);
    const mediaType = sourceMediaType(descriptor);
    switch (mediaType) {
        case 'text/turtle':
        case 'application/n-triples':
            return parseWithN3(descriptor, text, mediaType, maximumQuads);
        case 'application/rdf+xml': {
            const refusal = rdfXmlGuardRefusal(text);
            if (refusal !== undefined) {
                throw refuse(descriptor, XML_REASONS[refusal.reason], refusal.detail);
            }
            return parseWithOxigraph(descriptor, text, mediaType, maximumQuads);
        }
        case 'application/ld+json': {
            const structure = jsonLdStructureRefusal(text);
            if (structure !== undefined) {
                throw refuse(descriptor, JSON_LD_REASONS[structure.reason], structure.detail);
            }
            const remote = jsonLdRemoteContext(text);
            if (remote !== undefined) {
                throw refuse(
                    descriptor,
                    'jsonld-remote-context',
                    `the JSON-LD context ${JSON.stringify(remote)} would have to be loaded; inline it in the source`,
                );
            }
            return parseWithOxigraph(descriptor, text, mediaType, maximumQuads);
        }
    }
}

/** Decodes source bytes as strict UTF-8, exactly as Turtle sources have always been decoded. */
export function decodeOntologySourceText(descriptor: TurtleSourceDescriptor, bytes: Uint8Array): string {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch (cause) {
        throw new TurtleSourceEncodingError(descriptor.id, descriptor.locator, cause);
    }
}

/** Decodes and parses one source: the single entry point for every ontology source format. */
export function parseOntologySource(
    descriptor: TurtleSourceDescriptor,
    bytes: Uint8Array,
    maximumQuads?: number,
): Readonly<{ text: string; quads: ReadonlyArray<Quad> }> {
    assertQuadCapacity(maximumQuads);
    sourceMediaType(descriptor);
    const text = decodeOntologySourceText(descriptor, bytes);
    return Object.freeze({ text, quads: parseOntologySourceText(descriptor, text, maximumQuads) });
}
