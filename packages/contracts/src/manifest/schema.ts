import { Schema } from 'effect';
import { validRange } from 'semver';

import { MANIFEST_JSON_SCHEMA_URL, MANIFEST_SCHEMA_VERSION } from './constants.js';
import { isRegistryOrigin } from './registry-origin.js';

export { isRegistryOrigin, normalizeRegistryOrigin } from './registry-origin.js';

const ABSOLUTE_IRI_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:(?!.*[\s\u0000-\u001f\u007f-\u009f\uD800-\uDFFF])[\s\S]+$/u;
const SCOPED_ALIAS_PATTERN = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;
const WELL_FORMED_UNICODE_PATTERN = /^(?![\s\S]*[\uD800-\uDFFF])[\s\S]*$/u;
const CITATION_ROOT_NAME_PATTERN = /^(?![\s\S]*[\uD800-\uDFFF])\S(?:[\s\S]*\S)?$/u;

function canonicalIriJsonSchema() {
    return {
        format: 'uri',
        pattern: ABSOLUTE_IRI_PATTERN.source,
        'x-erden-canonical-iri': true,
    };
}

function registryOriginJsonSchema() {
    return {
        format: 'uri',
        'x-erden-registry-origin': true,
    };
}

export function isCanonicalOntologyIri(value: string): boolean {
    try {
        return new URL(value).href === value;
    } catch {
        return false;
    }
}

export function isScopedAlias(value: string): boolean {
    return SCOPED_ALIAS_PATTERN.test(value);
}

export function isCitationRootName(value: string): boolean {
    return CITATION_ROOT_NAME_PATTERN.test(value);
}

const WellFormedUnicode = Schema.makeFilter((value: string) => value.isWellFormed(), {
    expected: 'a well-formed Unicode string without lone UTF-16 surrogates',
    toJsonSchema: () => ({ pattern: WELL_FORMED_UNICODE_PATTERN.source }),
});

const NonEmptyTrimmedString = Schema.NonEmptyString.check(Schema.isTrimmed(), WellFormedUnicode);

export const CanonicalOntologyIri = Schema.String.check(
    Schema.makeFilter(isCanonicalOntologyIri, {
        expected: 'an absolute ontology IRI using its exact canonical URL serialization',
        toJsonSchema: canonicalIriJsonSchema,
    }),
);
export type CanonicalOntologyIri = typeof CanonicalOntologyIri.Type;

export const OwnedIriPrefix = Schema.String.check(
    Schema.makeFilter(isCanonicalOntologyIri, {
        expected: 'an absolute IRI prefix using its exact canonical URL serialization',
        toJsonSchema: canonicalIriJsonSchema,
    }),
);
export type OwnedIriPrefix = typeof OwnedIriPrefix.Type;

export const ScopedAlias = Schema.String.check(
    Schema.makeFilter(isScopedAlias, {
        expected: 'a scoped registry alias such as @org/package',
        toJsonSchema: () => ({ pattern: SCOPED_ALIAS_PATTERN.source }),
    }),
);
export type ScopedAlias = typeof ScopedAlias.Type;

export const RegistryOrigin = Schema.String.check(
    Schema.makeFilter(isRegistryOrigin, {
        expected: 'an http(s) origin with no credentials, no path beyond /, no query, and no fragment',
        toJsonSchema: registryOriginJsonSchema,
    }),
);
export type RegistryOrigin = typeof RegistryOrigin.Type;

export const ManifestPath = NonEmptyTrimmedString.check(
    Schema.makeFilter((value) => !value.includes('\u0000'), {
        expected: 'a non-empty path without NUL characters',
        toJsonSchema: () => ({ pattern: '^[^\\u0000]+$' }),
    }),
);
export type ManifestPath = typeof ManifestPath.Type;

export const CitationRootName = Schema.String.check(
    Schema.makeFilter((value) => value.isWellFormed() && isCitationRootName(value), {
        expected: 'a non-empty root name with no leading or trailing whitespace',
        toJsonSchema: () => ({ pattern: CITATION_ROOT_NAME_PATTERN.source }),
    }),
);
export type CitationRootName = typeof CitationRootName.Type;

export const SemverRange = NonEmptyTrimmedString.check(
    Schema.makeFilter((value) => validRange(value, { loose: false }) !== null, {
        expected: 'a valid semantic-version range',
        toJsonSchema: () => ({ format: 'semver-range' }),
    }),
);
export type SemverRange = typeof SemverRange.Type;

export const DependencyIdentifier = Schema.Union([ScopedAlias, CanonicalOntologyIri]);
export type DependencyIdentifier = typeof DependencyIdentifier.Type;

export const ManifestSourcesV1 = Schema.Struct({
    ontology: Schema.Array(ManifestPath).check(Schema.isMinLength(1)).annotate({
        description:
            'Ontology sources. A file selector may name a Turtle (.ttl), N-Triples (.nt), RDF/XML (.rdf, .owl) or JSON-LD (.jsonld) file, read as published; a directory selector reads only its .ttl files.',
    }),
    shapes: Schema.optionalKey(Schema.Array(ManifestPath)),
    competencyQuestions: Schema.optionalKey(Schema.Array(ManifestPath)),
}).annotate({
    description:
        'Source layout: RDF ontology files, Turtle SHACL shapes and SPARQL competency questions. Directory selectors read .ttl (ontology, shapes) or .rq (questions) files.',
});
export type ManifestSourcesV1 = typeof ManifestSourcesV1.Type;

export const OwnedIriPrefixes = Schema.Array(OwnedIriPrefix).check(
    Schema.makeFilter((prefixes) => prefixes.length > 0 && new Set(prefixes).size === prefixes.length, {
        expected: 'a non-empty array of unique explicitly owned IRI prefixes',
        toJsonSchema: () => ({ minItems: 1, uniqueItems: true }),
    }),
);
export type OwnedIriPrefixes = typeof OwnedIriPrefixes.Type;

export const OutsideProfilePolicyV1 = Schema.Literals(['refuse', 'report']).annotate({
    description:
        'What the check does with statements Erden does not reason over yet. refuse (the default) fails listing every one; report reasons over everything else, leaves these unreasoned and lists them in the check report.',
});
export type OutsideProfilePolicyV1 = typeof OutsideProfilePolicyV1.Type;

export const RawManifestV1 = Schema.Struct({
    $schema: Schema.optionalKey(Schema.Literal(MANIFEST_JSON_SCHEMA_URL)),
    schemaVersion: Schema.Literal(MANIFEST_SCHEMA_VERSION).check(Schema.isInt()),
    canonicalIri: CanonicalOntologyIri,
    alias: ScopedAlias,
    ownedIriPrefixes: OwnedIriPrefixes,
    title: Schema.optionalKey(NonEmptyTrimmedString),
    description: Schema.optionalKey(NonEmptyTrimmedString),
    registry: Schema.optionalKey(RegistryOrigin),
    outsideProfile: Schema.optionalKey(OutsideProfilePolicyV1),
    sources: ManifestSourcesV1,
    citationRoots: Schema.optionalKey(Schema.Record(CitationRootName, ManifestPath)),
    dependencies: Schema.optionalKey(Schema.Record(DependencyIdentifier, SemverRange)),
}).annotate({
    title: 'Erden project manifest v1',
    description: 'The strict, format-neutral schema for erden.config.* project manifests.',
});
export type RawManifestV1 = typeof RawManifestV1.Type;

export interface ManifestV1 {
    readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
    readonly canonicalIri: string;
    readonly alias: string;
    readonly ownedIriPrefixes: ReadonlyArray<string>;
    readonly title?: string;
    readonly description?: string;
    readonly registry?: string;
    readonly outsideProfile?: OutsideProfilePolicyV1;
    readonly sources: {
        readonly ontology: ReadonlyArray<string>;
        readonly shapes: ReadonlyArray<string>;
        readonly competencyQuestions: ReadonlyArray<string>;
    };
    readonly citationRoots: Readonly<Record<string, string>>;
    readonly dependencies: Readonly<Record<string, string>>;
}

/**
 * The source-descriptor field for a project's outside-profile policy: present only in report mode, so refuse-mode
 * descriptors, snapshot digests and reasoner requests are unchanged.
 */
export function outsideProfileSourceField(manifest: ManifestV1): { readonly outsideProfile?: 'report' } {
    return manifest.outsideProfile === 'report' ? { outsideProfile: 'report' } : {};
}

export function generateManifestJsonSchema(): object {
    const document = Schema.toJsonSchemaDocument(RawManifestV1, {
        additionalProperties: false,
        generateDescriptions: true,
    });
    const schema = document.schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const dependencies = properties?.dependencies;
    if (dependencies !== undefined) {
        dependencies.propertyNames = {
            anyOf: [{ pattern: SCOPED_ALIAS_PATTERN.source }, canonicalIriJsonSchema()],
        };
        dependencies.additionalProperties = false;
    }
    const citationRoots = properties?.citationRoots;
    if (citationRoots !== undefined) {
        citationRoots.additionalProperties = false;
    }
    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: MANIFEST_JSON_SCHEMA_URL,
        ...schema,
        title: 'Erden project manifest v1',
        ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
    };
}
