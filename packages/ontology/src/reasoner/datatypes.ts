import { RDF, RDFS, XSD } from '../model.js';

import { ReasonerNormalizationError } from './errors.js';

/** The built-in datatypes of the normalizer, in the order of `reasoner/qualification/datatypes.json`. */
export const BUILTIN_DATATYPES: ReadonlyArray<string> = Object.freeze([
    `${RDFS}Literal`,
    `${RDF}langString`,
    `${RDF}XMLLiteral`,
    `${RDF}HTML`,
    `${RDF}JSON`,
    ...[
        'string',
        'boolean',
        'decimal',
        'float',
        'double',
        'duration',
        'dateTime',
        'time',
        'date',
        'gYearMonth',
        'gYear',
        'gMonthDay',
        'gDay',
        'gMonth',
        'hexBinary',
        'base64Binary',
        'anyURI',
        'normalizedString',
        'token',
        'language',
        'Name',
        'NCName',
        'NMTOKEN',
        'integer',
        'nonPositiveInteger',
        'negativeInteger',
        'long',
        'int',
        'short',
        'byte',
        'nonNegativeInteger',
        'unsignedLong',
        'unsignedInt',
        'unsignedShort',
        'unsignedByte',
        'positiveInteger',
        'yearMonthDuration',
        'dayTimeDuration',
        'dateTimeStamp',
    ].map((localName) => `${XSD}${localName}`),
]);

/**
 * The usages of built-in datatypes one reasoner release cannot decide: each reaches a PurRDF semantic boundary, so the
 * normalizer refuses it before reasoning as UNSUPPORTED_DATATYPE. Measured per release in
 * `reasoner/qualification/datatypes.json`.
 */
export interface DatatypeBoundaries {
    /** Datatypes refused as a data-property or annotation-property range, whatever else the ontology says. */
    readonly range: ReadonlySet<string>;
    /** Datatypes refused as a data-property range once some value of that property is asserted. */
    readonly assertedRange: ReadonlySet<string>;
    /** Datatypes whose literals are refused as data-property assertion values. */
    readonly dataLiteral: ReadonlySet<string>;
    /** Datatypes whose literals are refused as annotation values. */
    readonly annotationLiteral: ReadonlySet<string>;
}

function names(...localNames: ReadonlyArray<string>): ReadonlySet<string> {
    return new Set(
        localNames.map((name) =>
            name.startsWith('rdfs:')
                ? `${RDFS}${name.slice(5)}`
                : name.startsWith('rdf:')
                  ? `${RDF}${name.slice(4)}`
                  : `${XSD}${name}`,
        ),
    );
}

/** A range PurRDF cannot decide in either release; 0.2 meets it only with a value asserted under the range. */
const BOUNDARY_RANGES = names(
    'rdf:langString',
    'rdf:XMLLiteral',
    'rdf:HTML',
    'rdf:JSON',
    'anyURI',
    'normalizedString',
    'token',
    'language',
    'Name',
    'NCName',
    'NMTOKEN',
    'yearMonthDuration',
    'dayTimeDuration',
    'dateTimeStamp',
);

/** A literal PurRDF cannot decide in either release; 0.2 never sends annotation values to PurRDF. */
const BOUNDARY_LITERALS = names(
    'rdfs:Literal',
    'rdf:XMLLiteral',
    'rdf:HTML',
    'rdf:JSON',
    'anyURI',
    'normalizedString',
    'token',
    'language',
    'Name',
    'NCName',
    'NMTOKEN',
    'dateTimeStamp',
);

const NONE: ReadonlySet<string> = new Set();

const MEASURED: ReadonlyMap<string, DatatypeBoundaries> = new Map([
    [
        '0.1.0+purrdf.0.12.0.dfb1df7',
        Object.freeze({
            range: BOUNDARY_RANGES,
            assertedRange: NONE,
            dataLiteral: BOUNDARY_LITERALS,
            annotationLiteral: BOUNDARY_LITERALS,
        }),
    ],
    [
        '0.2.0+purrdf.0.12.0.dfb1df7',
        Object.freeze({
            range: NONE,
            assertedRange: BOUNDARY_RANGES,
            dataLiteral: BOUNDARY_LITERALS,
            annotationLiteral: NONE,
        }),
    ],
    // 0.3.0 sends literals and data ranges to PurRDF exactly as 0.2.0 does, under either calculus; the
    // qualification's 'v0.2' column (reasoner/qualification/adapter.test.ts) re-measures it on each build.
    [
        '0.3.0+purrdf.0.12.0.dfb1df7',
        Object.freeze({
            range: NONE,
            assertedRange: BOUNDARY_RANGES,
            dataLiteral: BOUNDARY_LITERALS,
            annotationLiteral: NONE,
        }),
    ],
]);

/** The reasoner releases whose datatype boundaries are measured. */
export const MEASURED_DATATYPE_RELEASES: ReadonlyArray<string> = Object.freeze([...MEASURED.keys()]);

/**
 * The datatype boundaries of one reasoner release. An unmeasured release has no table, so normalizing for it fails
 * instead of guessing; a new reasoner release adds its measurements here and in `datatypes.json`.
 */
export function datatypeBoundaries(toolVersion: string): DatatypeBoundaries {
    const found = MEASURED.get(toolVersion);
    if (found === undefined) {
        throw new ReasonerNormalizationError(
            'INVALID_REASONER_INPUT',
            `No built-in datatype measurements exist for reasoner ${toolVersion}`,
            { toolVersion },
        );
    }
    return found;
}

/**
 * Whether a release decides a built-in datatype in one usage on its own; datatypes outside the built-in list are
 * decidable. A range refused only under an asserted value is decidable here: it needs the whole ontology.
 */
export function isDecidableUnder(
    boundaries: DatatypeBoundaries,
    datatype: string,
    usage: 'range' | 'literal',
    kind: 'DataProperty' | 'AnnotationProperty',
): boolean {
    if (usage === 'range') {
        return !boundaries.range.has(datatype);
    }
    return !(kind === 'AnnotationProperty' ? boundaries.annotationLiteral : boundaries.dataLiteral).has(datatype);
}

function unsupported(datatype: string, usage: 'range' | 'literal', subject: string, context: string, message: string) {
    return new ReasonerNormalizationError('UNSUPPORTED_DATATYPE', message, { datatype, subject, usage, context });
}

/** Refuses, during one normalization, each datatype usage the given release cannot decide. */
export interface DatatypeUsageCheck {
    readonly range: (property: string, kind: 'DataProperty' | 'AnnotationProperty', datatype: string) => void;
    readonly dataLiteral: (property: string, subject: string, datatype: string) => void;
    readonly annotationLiteral: (subject: string, datatype: string) => void;
    /** Runs after every axiom is read: a range refused only under an asserted value needs the whole ontology. */
    readonly finish: () => void;
}

export function makeDatatypeUsageCheck(boundaries: DatatypeBoundaries): DatatypeUsageCheck {
    const assertedRanges: Array<{ readonly property: string; readonly datatype: string }> = [];
    const assertedProperties = new Set<string>();
    return Object.freeze({
        range(property: string, kind: 'DataProperty' | 'AnnotationProperty', datatype: string) {
            if (boundaries.range.has(datatype)) {
                throw unsupported(
                    datatype,
                    'range',
                    property,
                    'rdfs:range',
                    `${property} has range ${datatype}, a datatype the bundled reasoner cannot decide as a range`,
                );
            }
            if (kind === 'DataProperty' && boundaries.assertedRange.has(datatype)) {
                assertedRanges.push({ property, datatype });
            }
        },
        dataLiteral(property: string, subject: string, datatype: string) {
            assertedProperties.add(property);
            if (boundaries.dataLiteral.has(datatype)) {
                throw unsupported(
                    datatype,
                    'literal',
                    subject,
                    'data property assertion',
                    `${subject} has a ${datatype} literal value, a datatype the bundled reasoner cannot decide as a value`,
                );
            }
        },
        annotationLiteral(subject: string, datatype: string) {
            if (boundaries.annotationLiteral.has(datatype)) {
                throw unsupported(
                    datatype,
                    'literal',
                    subject,
                    'annotation assertion',
                    `${subject} has a ${datatype} literal value, a datatype the bundled reasoner cannot decide as a value`,
                );
            }
        },
        finish() {
            const refused = assertedRanges.find((item) => assertedProperties.has(item.property));
            if (refused !== undefined) {
                throw unsupported(
                    refused.datatype,
                    'range',
                    refused.property,
                    'rdfs:range',
                    `${refused.property} has range ${refused.datatype} and an asserted value, a datatype the bundled reasoner cannot decide as the range of a value`,
                );
            }
        },
    });
}
