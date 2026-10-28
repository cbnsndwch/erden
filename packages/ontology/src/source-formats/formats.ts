/** The closed set of RDF serializations Erden reads as ontology sources. */
export type OntologyMediaType = 'text/turtle' | 'application/n-triples' | 'application/rdf+xml' | 'application/ld+json';

export interface OntologySourceParser {
    readonly name: 'n3' | 'oxigraph';
    readonly version: string;
}

/** Pinned in packages/ontology/package.json; a test keeps these in step with the pins. */
export const N3_PARSER: OntologySourceParser = Object.freeze({ name: 'n3', version: '2.1.1' });
export const OXIGRAPH_PARSER: OntologySourceParser = Object.freeze({ name: 'oxigraph', version: '0.5.9' });

interface OntologySourceFormat {
    readonly mediaType: OntologyMediaType;
    readonly parser: OntologySourceParser;
}

const FORMATS: Readonly<Record<string, OntologySourceFormat>> = Object.freeze({
    '.ttl': Object.freeze({ mediaType: 'text/turtle', parser: N3_PARSER }),
    '.nt': Object.freeze({ mediaType: 'application/n-triples', parser: N3_PARSER }),
    '.rdf': Object.freeze({ mediaType: 'application/rdf+xml', parser: OXIGRAPH_PARSER }),
    '.owl': Object.freeze({ mediaType: 'application/rdf+xml', parser: OXIGRAPH_PARSER }),
    '.jsonld': Object.freeze({ mediaType: 'application/ld+json', parser: OXIGRAPH_PARSER }),
});

/** File extensions a file selector may name, in documentation order. */
export const ONTOLOGY_SOURCE_EXTENSIONS = Object.freeze(['.ttl', '.nt', '.rdf', '.owl', '.jsonld'] as const);
export type OntologySourceExtension = (typeof ONTOLOGY_SOURCE_EXTENSIONS)[number];

/** RDF serializations with named graphs or N3 rules: recognized so they are refused by name, never parsed. */
export const REFUSED_ONTOLOGY_SOURCE_EXTENSIONS = Object.freeze(['.nq', '.trig', '.n3'] as const);

/** Directory selectors discover Turtle only, so a stray file in another format never changes a package's graph. */
export const ONTOLOGY_DIRECTORY_EXTENSION = '.ttl' as const;

export const ONTOLOGY_MEDIA_TYPES = Object.freeze([
    'text/turtle',
    'application/n-triples',
    'application/rdf+xml',
    'application/ld+json',
] as const satisfies ReadonlyArray<OntologyMediaType>);

/** The extension as `path.extname` reports it, lower-cased: a leading-dot name such as `.ttl` has none. */
function lowerExtension(locator: string): string {
    const slash = Math.max(locator.lastIndexOf('/'), locator.lastIndexOf('\\'));
    const name = locator.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** Matches by suffix, as Turtle file selectors always have; no supported extension is a suffix of another. */
function formatFor(locator: string): OntologySourceFormat | undefined {
    const lower = locator.toLowerCase();
    const extension = ONTOLOGY_SOURCE_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
    return extension === undefined ? undefined : FORMATS[extension];
}

/** The media type a file selector's extension names, or undefined when Erden does not read it. */
export function ontologyMediaTypeForLocator(locator: string): OntologyMediaType | undefined {
    return formatFor(locator)?.mediaType;
}

/**
 * The media type to record on a descriptor for a selected file. A file Erden does not read keeps the Turtle
 * type, which the format port then refuses by extension with the supported list, so the CLI and the server
 * fail the same way at the same stage.
 */
export function ontologySourceDescriptorMediaType(locator: string): OntologyMediaType {
    return ontologyMediaTypeForLocator(locator) ?? 'text/turtle';
}

export function ontologyParserForMediaType(mediaType: OntologyMediaType): OntologySourceParser {
    return mediaType === 'text/turtle' || mediaType === 'application/n-triples' ? N3_PARSER : OXIGRAPH_PARSER;
}

export function isOntologyMediaType(value: unknown): value is OntologyMediaType {
    return typeof value === 'string' && (ONTOLOGY_MEDIA_TYPES as ReadonlyArray<string>).includes(value);
}

/**
 * Whether an ontology selector names one file rather than a directory: any RDF extension Erden reads or
 * refuses by name. A refused extension stays a file selector so it fails with the supported list.
 */
export function isOntologyFileSelector(locator: string): boolean {
    const extension = lowerExtension(locator);
    return (
        (ONTOLOGY_SOURCE_EXTENSIONS as ReadonlyArray<string>).includes(extension) ||
        (REFUSED_ONTOLOGY_SOURCE_EXTENSIONS as ReadonlyArray<string>).includes(extension)
    );
}

/** Whether a file found under a directory selector belongs to the graph (Turtle only). */
export function isOntologyDirectoryMember(locator: string): boolean {
    return locator.toLowerCase().endsWith(ONTOLOGY_DIRECTORY_EXTENSION);
}

export function parserIdentity(parser: OntologySourceParser): string {
    return `${parser.name}@${parser.version}`;
}
