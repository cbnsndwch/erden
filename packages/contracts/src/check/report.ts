import { Result, Schema } from 'effect';

import { ONTOLOGY_MEDIA_TYPES, REASONER_PROTOCOL_VERSION, UNSUPPORTED_SHACL_CONSTRUCT_KINDS } from '@erden/ontology';
import { LemmaConclusion, ProofRuleName } from '@erden/reasoner-protocol';

export const CHECK_REPORT_VERSION = 'erden.check-report/v1' as const;
export { REASONER_PROTOCOL_VERSION };

const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:(?!.*[\s\u0000-\u001f\u007f-\u009f\uD800-\uDFFF])[\s\S]+$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/u;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:/u;

const WellFormedText = Schema.String.check(
    Schema.makeFilter((value) => value.isWellFormed(), { expected: 'well-formed Unicode text' }),
);
const NonEmptyText = WellFormedText.check(Schema.isMinLength(1));
const Identifier = Schema.String.check(Schema.isPattern(IDENTIFIER));
const AbsoluteIri = Schema.String.check(Schema.isPattern(ABSOLUTE_IRI));
const Sha256Digest = Schema.String.check(Schema.isPattern(SHA256));
const NonNegativeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
/** The limits a check ran with. Optional so reports stored before limits were recorded decode to the same bytes. */
export const CheckReportReasonerLimits = Schema.Struct({
    maxWallTimeMs: PositiveInteger,
    maxInputAxioms: PositiveInteger,
    maxInferences: PositiveInteger,
    maxRequestBytes: Schema.optionalKey(PositiveInteger),
});
const RefusalReason = Schema.Literals([
    'unsupported-construct',
    'named-graph',
    'unknown-reserved-term',
    'bottom-property',
    'cyclic-expression',
    'known-divergence',
    'unknown-result',
    'boundary-exhausted',
    'budget-exhausted',
    'missing-provenance',
    'incomplete-certificate',
]);
const IncompatibilityReason = Schema.Literals([
    'protocol-version',
    'tool-name',
    'tool-version',
    'executable-digest',
    'adapter-digest',
    'calculus-digest',
    'profile-id',
    'profile-digest',
    'input-digest',
]);
const PortablePath = Schema.String.check(
    Schema.makeFilter(
        (value) =>
            value.length > 0 &&
            value.isWellFormed() &&
            !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
            !value.includes('\\') &&
            !value.includes('\u0000') &&
            !value.startsWith('/') &&
            !WINDOWS_ABSOLUTE.test(value) &&
            value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
        { expected: 'a non-empty portable relative path using forward slashes' },
    ),
);

export const CheckReportTool = Schema.Struct({
    name: NonEmptyText,
    version: NonEmptyText,
    executableDigest: Sha256Digest,
    adapterDigest: Sha256Digest,
    calculusDigest: Sha256Digest,
});

export const CheckReportOwner = Schema.Struct({
    role: Schema.Literals(['root', 'dependency']),
    canonicalIri: AbsoluteIri,
    ownedIriPrefixes: Schema.NonEmptyArray(AbsoluteIri),
});

/** Where a statement is written: a reported source file, and the 1-based line and column of the statement. */
export const CheckReportLocation = Schema.Struct({
    file: PortablePath,
    line: PositiveInteger,
    column: PositiveInteger,
});
export type CheckReportLocation = typeof CheckReportLocation.Type;

/**
 * One reasoner diagnostic. `locations`, added after the first reports were stored, is where the statements its axioms
 * were read from are written, by file, line and column; absent when none of them can be located.
 */
export const CheckReportDiagnostic = Schema.Struct({
    severity: Schema.Literals(['warning', 'error']),
    code: Identifier,
    message: NonEmptyText,
    axiomIds: Schema.Array(Identifier),
    locations: Schema.optionalKey(Schema.NonEmptyArray(CheckReportLocation)),
});

export const CheckReportSourceSelector = Schema.Struct({
    id: Identifier,
    stage: Schema.Literals(['ontology', 'shapes', 'competency-questions']),
    kind: Schema.Literals(['file', 'directory']),
    selector: PortablePath,
});

const PARSER_IDENTITY = /^[a-z0-9][a-z0-9.-]*@[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

/**
 * Ontology sources also record their format, the pinned parser that read them and their RDFC-1.0 graph hash.
 * The three fields are optional so reports stored before multi-format sources decode to the same bytes.
 */
export const CheckReportSourceFile = Schema.Struct({
    stage: Schema.Literals(['ontology', 'shapes', 'competency-questions']),
    id: Identifier,
    file: PortablePath,
    contentDigest: Sha256Digest,
    mediaType: Schema.optionalKey(Schema.Literals(ONTOLOGY_MEDIA_TYPES)),
    parser: Schema.optionalKey(Schema.String.check(Schema.isPattern(PARSER_IDENTITY))),
    graphHash: Schema.optionalKey(Sha256Digest),
});

export const CheckReportInference = Schema.Struct({
    id: Identifier,
    // Every proof rule the reasoner may name: V1's rules, then the Horn calculus's (profile V2).
    rule: ProofRuleName,
    subject: AbsoluteIri,
    predicate: AbsoluteIri,
    object: NonEmptyText,
    premiseIds: Schema.NonEmptyArray(Identifier),
    contributingSourceIds: Schema.NonEmptyArray(Identifier),
    contributingOwners: Schema.NonEmptyArray(CheckReportOwner),
    justificationDigest: Sha256Digest,
});

/**
 * A proof step whose conclusion is not an RDF statement, such as "every Chair has some Person as chairOf", which an
 * inferred statement or another lemma cites. The reasoner's checker verified it like every other step; it is listed
 * so each proof reads end to end. Only proofs through restrictions have them.
 */
export const CheckReportLemma = Schema.Struct({
    id: Identifier,
    rule: ProofRuleName,
    premiseIds: Schema.Array(Identifier),
    conclusion: LemmaConclusion,
    justificationDigest: Sha256Digest,
});

/** What a decided, consistent report says about completeness, in its own words. */
export const REASONING_COMPLETENESS =
    'Completeness checked at qualification, not on this run: each listed inference was proved and checked here; that none is missing rests on the reasoner release qualification.' as const;

export const CheckReportUnsatisfiableClass = Schema.Struct({
    classIri: AbsoluteIri,
    premiseIds: Schema.NonEmptyArray(Identifier),
    contributingSourceIds: Schema.NonEmptyArray(Identifier),
    contributingOwners: Schema.NonEmptyArray(CheckReportOwner),
    justificationDigest: Sha256Digest,
});

const StageStatus = Schema.Literals(['passed', 'failed', 'skipped', 'not-run']);
const StageSummary = Schema.Struct({
    status: StageStatus,
    failureCodes: Schema.Array(NonEmptyText),
});

const BorrowedTerms = Schema.Struct({
    conforms: Schema.Boolean,
    used: Schema.Array(AbsoluteIri),
    declared: Schema.Array(AbsoluteIri),
    missing: Schema.Array(AbsoluteIri),
});

const PropertyDomainRange = Schema.Struct({
    conforms: Schema.Boolean,
    properties: Schema.Array(AbsoluteIri),
    findings: Schema.Array(
        Schema.Struct({
            property: AbsoluteIri,
            missing: Schema.Literals(['domain', 'range', 'domain+range']),
        }),
    ),
});

/**
 * One construct of the selected shapes that the bundled SHACL engine cannot run. Any one refuses the whole SHACL
 * step: the kind, the affected shape (null when none is named, such as for `owl:imports`), the constraint component
 * or construct IRI, what is unsupported, and where the statement is written (absent when the file's positions cannot
 * be established).
 */
export const CheckReportUnsupportedShaclConstruct = Schema.Struct({
    kind: Schema.Literals(UNSUPPORTED_SHACL_CONSTRUCT_KINDS),
    shape: Schema.NullOr(NonEmptyText),
    construct: AbsoluteIri,
    message: NonEmptyText,
    sourceId: Identifier,
    file: PortablePath,
    location: Schema.optionalKey(CheckReportLocation),
});
export type CheckReportUnsupportedShaclConstruct = typeof CheckReportUnsupportedShaclConstruct.Type;

/** The SHACL failure code of a refused step, distinct from `shacl-conformance`. */
export const SHACL_UNSUPPORTED_CONSTRUCT_CODE = 'shacl-unsupported-construct' as const;

const ShaclDetails = Schema.NullOr(
    Schema.Struct({
        conforms: Schema.Boolean,
        counts: Schema.Struct({
            violation: NonNegativeInteger,
            warning: NonNegativeInteger,
            info: NonNegativeInteger,
        }),
        findings: Schema.Array(
            Schema.Struct({
                focus: Schema.NullOr(NonEmptyText),
                path: Schema.NullOr(NonEmptyText),
                severity: NonEmptyText,
                message: WellFormedText,
                shape: Schema.NullOr(NonEmptyText),
                shapeSourceIds: Schema.Array(Identifier),
                shapeOwners: Schema.Array(CheckReportOwner),
                /** The offending value as an N-Triples term, or null; absent from reports written before erden-shacl. */
                value: Schema.optionalKey(Schema.NullOr(NonEmptyText)),
                /** The constraint component IRI (`sh:sourceConstraintComponent`). */
                component: Schema.optionalKey(AbsoluteIri),
                /** The result's own source shape; `shape` keeps naming its owning node shape. */
                sourceShape: Schema.optionalKey(NonEmptyText),
                /** A SPARQL result's `sh:sparql` node, when the source shape has exactly one. */
                sourceConstraint: Schema.optionalKey(NonEmptyText),
            }),
        ),
        shapes: Schema.Array(
            Schema.Struct({
                shape: NonEmptyText,
                targetKind: Schema.Literals(['targetClass', 'targetSubjectsOf', 'targetObjectsOf', 'none']),
                targetTerm: Schema.NullOr(NonEmptyText),
                targetCount: NonNegativeInteger,
                resultCount: NonNegativeInteger,
                sourceIds: Schema.Array(Identifier),
                owners: Schema.Array(CheckReportOwner),
            }),
        ),
        selfTest: Schema.Array(
            Schema.Struct({
                shape: NonEmptyText,
                fired: Schema.Boolean,
                reason: Schema.NullOr(WellFormedText),
            }),
        ),
        sourceDigests: Schema.Array(
            Schema.Struct({
                sourceId: Identifier,
                contentDigest: Sha256Digest,
            }),
        ),
        /** Present only when the step was refused, so reports without a refusal keep their bytes. */
        unsupported: Schema.optionalKey(
            Schema.Array(CheckReportUnsupportedShaclConstruct).check(Schema.isMinLength(1)),
        ),
        /** The engine that ran the shapes (erden-shacl); absent from refused steps and from earlier reports. */
        engine: Schema.optionalKey(
            Schema.Struct({
                name: NonEmptyText,
                version: NonEmptyText,
                engineDigest: Sha256Digest,
                executableDigest: Sha256Digest,
            }),
        ),
    }),
);

const CompetencyQuestionDetails = Schema.NullOr(
    Schema.Struct({
        conforms: Schema.Boolean,
        executed: NonNegativeInteger,
        dormant: NonNegativeInteger,
        questions: Schema.Array(
            Schema.Struct({
                id: Identifier,
                owner: CheckReportOwner,
                file: PortablePath,
                execution: Schema.Literals(['executed', 'dormant-dependency']),
                rows: Schema.NullOr(NonNegativeInteger),
                ok: Schema.NullOr(Schema.Boolean),
                expectedToFail: Schema.Boolean,
                closes: Schema.NullOr(WellFormedText),
                blocking: Schema.Boolean,
                reason: WellFormedText,
                metadataDiagnostics: Schema.Array(
                    Schema.Struct({
                        code: Schema.Literals([
                            'missing-ask',
                            'missing-expect',
                            'missing-from',
                            'missing-closes',
                            'invalid-expectation',
                        ]),
                        message: WellFormedText,
                    }),
                ),
            }),
        ),
    }),
);

const CitationDetails = Schema.NullOr(
    Schema.Struct({
        conforms: Schema.Boolean,
        warnings: NonNegativeInteger,
        citations: Schema.Array(
            Schema.Struct({
                observation: NonEmptyText,
                label: Schema.NullOr(WellFormedText),
                commit: Schema.NullOr(WellFormedText),
                repository: Schema.NullOr(WellFormedText),
                root: WellFormedText,
                affectedFacts: Schema.Array(WellFormedText),
                metadataDiagnostics: Schema.Array(
                    Schema.Struct({
                        predicate: AbsoluteIri,
                        values: Schema.NonEmptyArray(WellFormedText),
                    }),
                ),
                files: Schema.Array(
                    Schema.Struct({
                        path: PortablePath,
                        exists: Schema.NullOr(Schema.Boolean),
                        gitState: Schema.NullOr(
                            Schema.Literals([
                                'git-unavailable',
                                'not-in-git',
                                'no-commit-cited',
                                'commit-not-in-repo',
                                'changed-since',
                                'uncommitted-edit',
                                'unchanged',
                            ]),
                        ),
                    }),
                ),
                status: Schema.Literals([
                    'ok',
                    'ambiguous-metadata',
                    'unsafe-source-path',
                    'missing-source-path',
                    'no-source-root',
                    'git-unavailable',
                    'not-in-git',
                    'no-commit-cited',
                    'commit-not-in-repo',
                    'changed-since',
                    'uncommitted-edit',
                    'unchanged',
                ]),
                blocking: Schema.Boolean,
                warning: Schema.Boolean,
            }),
        ),
    }),
);

export const UNREASONED_NOTE = 'The consequences of these statements were not checked.' as const;
export const UNREASONED_EXAMPLE_LIMIT = 20;

/**
 * One example finding. `owlConstruct`, `description` and `location` were added after the first reports were stored,
 * so they are optional: the OWL 2 construct the finding hinges on (absent when there is none, such as RDF-only
 * vocabulary), the finding's statements in OWL functional-style syntax, and where its root statement is written
 * (absent when the source's positions cannot be established).
 */
const UnreasonedExample = Schema.Struct({
    subject: Schema.NullOr(AbsoluteIri),
    predicate: AbsoluteIri,
    object: Schema.NullOr(AbsoluteIri),
    datatype: Schema.optionalKey(AbsoluteIri),
    statementCount: PositiveInteger,
    files: Schema.Array(PortablePath).check(Schema.isMinLength(1)),
    owlConstruct: Schema.optionalKey(NonEmptyText),
    description: Schema.optionalKey(NonEmptyText),
    location: Schema.optionalKey(CheckReportLocation),
});

/**
 * Statements a project in `report` mode left out because Erden does not reason over them yet, grouped by
 * construct, with up to 20 examples each, and the imports matched against the dependency closure. Optional, and
 * present only when something was left out, so reports without it keep their bytes.
 */
export const CheckReportUnreasoned = Schema.Struct({
    rules: Schema.Struct({ id: Identifier, digest: Sha256Digest }),
    note: Schema.Literal(UNREASONED_NOTE),
    findingCount: PositiveInteger,
    statementCount: PositiveInteger,
    constructs: Schema.Array(
        Schema.Struct({
            group: Schema.Literals(['annotation', 'unreasoned']),
            construct: NonEmptyText,
            findingCount: PositiveInteger,
            statementCount: PositiveInteger,
            /** Every finding of the construct counted by OWL 2 construct, sorted by name. Optional and additive. */
            owlConstructs: Schema.optionalKey(
                Schema.Array(Schema.Struct({ name: NonEmptyText, findingCount: PositiveInteger })).check(
                    Schema.isMinLength(1),
                ),
            ),
            examples: Schema.Array(UnreasonedExample).check(
                Schema.isMinLength(1),
                Schema.isMaxLength(UNREASONED_EXAMPLE_LIMIT),
            ),
        }),
    ).check(Schema.isMinLength(1)),
    imports: Schema.Array(
        Schema.Struct({
            ontology: AbsoluteIri,
            iri: AbsoluteIri,
            status: Schema.Literals(['satisfied', 'unresolved']),
            files: Schema.Array(PortablePath).check(Schema.isMinLength(1)),
        }),
    ),
});
export type CheckReportUnreasoned = typeof CheckReportUnreasoned.Type;

export const UNDECLARED_ANNOTATION_PROPERTY_WARNING = 'undeclared-annotation-property' as const;

/**
 * A predicate no source declares, used with IRI or literal values: read as an annotation property and left out of
 * reasoning, in either mode. Each one is also a top-level warning.
 */
export const CheckReportUndeclaredAnnotationProperty = Schema.Struct({
    property: AbsoluteIri,
    statementCount: PositiveInteger,
    files: Schema.Array(PortablePath).check(Schema.isMinLength(1)),
    /** Where its first use, in statement order, is written. */
    firstUse: Schema.optionalKey(CheckReportLocation),
});
export type CheckReportUndeclaredAnnotationProperty = typeof CheckReportUndeclaredAnnotationProperty.Type;

function plural(count: number, noun: string): string {
    return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** The warning message for one undeclared annotation property: its own words are the report's evidence. */
export function undeclaredAnnotationPropertyWarning(item: CheckReportUndeclaredAnnotationProperty): string {
    const at =
        item.firstUse === undefined
            ? (item.files[0] ?? '')
            : `${item.firstUse.file}:${String(item.firstUse.line)}:${String(item.firstUse.column)}`;
    return `${item.property} is used in ${plural(item.statementCount, 'statement')} without a declaration, so it is read as an annotation property and not reasoned over (first use at ${at}); declare it to make this explicit`;
}

export const CheckProjectReportSchema = Schema.Struct({
    schema: Schema.Literal(CHECK_REPORT_VERSION),
    manifest: Schema.Struct({
        schemaVersion: Schema.Literal(1),
        file: PortablePath,
        canonicalIri: AbsoluteIri,
        alias: Schema.String.check(Schema.isPattern(/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u)),
        title: Schema.NullOr(NonEmptyText),
        /** Present only when the root manifest asks for report mode, so refuse-mode reports keep their bytes. */
        outsideProfile: Schema.optionalKey(Schema.Literal('report')),
    }),
    sources: Schema.Struct({
        selectors: Schema.Array(CheckReportSourceSelector),
        files: Schema.Array(CheckReportSourceFile),
        citationRoots: Schema.Array(Schema.Struct({ name: NonEmptyText, selector: PortablePath })),
    }),
    reasoning: Schema.Struct({
        protocolVersion: Schema.Literal(REASONER_PROTOCOL_VERSION),
        outcome: Schema.Literals(['decided', 'refused', 'incompatible']),
        negativeOutcome: Schema.NullOr(
            Schema.Union([
                Schema.Struct({ outcome: Schema.Literal('refused'), reason: RefusalReason }),
                Schema.Struct({
                    outcome: Schema.Literal('incompatible'),
                    reason: IncompatibilityReason,
                    expected: NonEmptyText,
                    actual: NonEmptyText,
                }),
            ]),
        ),
        consistency: Schema.NullOr(Schema.Literals(['consistent', 'inconsistent'])),
        requestId: Identifier,
        inputDigest: Sha256Digest,
        profile: Schema.Struct({ id: Identifier, digest: Sha256Digest }),
        tool: CheckReportTool,
        diagnostics: Schema.Array(CheckReportDiagnostic),
        inferred: Schema.Array(CheckReportInference),
        /** Present only when a proof needs a step that is not an RDF statement, so V1 reports keep their bytes. */
        lemmas: Schema.optionalKey(Schema.NonEmptyArray(CheckReportLemma)),
        unsatisfiableClasses: Schema.Array(CheckReportUnsatisfiableClass),
        /** Present exactly when the outcome is decided and consistent. */
        completeness: Schema.optionalKey(Schema.Literal(REASONING_COMPLETENESS)),
        inferredStatementCount: NonNegativeInteger,
        materializedStatementCount: NonNegativeInteger,
        limits: Schema.optionalKey(CheckReportReasonerLimits),
        /** Normalized axioms sent to the reasoner, so a max-input-axioms refusal can name the count. Optional. */
        inputAxiomCount: Schema.optionalKey(NonNegativeInteger),
    }),
    stages: Schema.Struct({
        sources: Schema.Struct({
            ...StageSummary.fields,
            ontologyFiles: NonNegativeInteger,
            shapeFiles: NonNegativeInteger,
            competencyQuestionFiles: NonNegativeInteger,
        }),
        reasoning: StageSummary,
        core: Schema.Struct({
            ...StageSummary.fields,
            borrowedTerms: Schema.NullOr(BorrowedTerms),
            propertyDomainRange: Schema.NullOr(PropertyDomainRange),
        }),
        shacl: Schema.Struct({ ...StageSummary.fields, details: ShaclDetails }),
        competencyQuestions: Schema.Struct({ ...StageSummary.fields, details: CompetencyQuestionDetails }),
        citations: Schema.Struct({ ...StageSummary.fields, details: CitationDetails }),
    }),
    unreasoned: Schema.optionalKey(CheckReportUnreasoned),
    /** Present only when a predicate is used undeclared, so reports without one keep their bytes. */
    undeclaredAnnotationProperties: Schema.optionalKey(
        Schema.Array(CheckReportUndeclaredAnnotationProperty).check(Schema.isMinLength(1)),
    ),
    warnings: Schema.Array(
        Schema.Struct({
            stage: Schema.Literals(['reasoning', 'shacl', 'competency-questions', 'citations']),
            code: Identifier,
            message: WellFormedText,
        }),
    ),
    outcome: Schema.Literals(['passed', 'failed']),
});

export type CheckProjectReport = typeof CheckProjectReportSchema.Type;

const STRICT_OPTIONS = { errors: 'all', onExcessProperty: 'error', reportInput: false } as const;

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function assertSorted<A>(values: ReadonlyArray<A>, key: (value: A) => string, label: string): void {
    for (let index = 1; index < values.length; index += 1) {
        const previous = values[index - 1];
        const current = values[index];
        if (previous !== undefined && current !== undefined && compareText(key(previous), key(current)) >= 0) {
            throw new TypeError(`${label} must be strictly sorted and unique`);
        }
    }
}

function assertNondecreasing<A>(values: ReadonlyArray<A>, key: (value: A) => string, label: string): void {
    for (let index = 1; index < values.length; index += 1) {
        const previous = values[index - 1];
        const current = values[index];
        if (previous !== undefined && current !== undefined && compareText(key(previous), key(current)) > 0) {
            throw new TypeError(`${label} must be sorted`);
        }
    }
}

/** Report order for statement locations: by file, then line, then column. */
export function compareCheckReportLocations(left: CheckReportLocation, right: CheckReportLocation): number {
    return compareText(left.file, right.file) || left.line - right.line || left.column - right.column;
}

/** Report order for unsupported SHACL constructs: by file, line and column, then by what they are. */
export function compareUnsupportedShaclConstructs(
    left: CheckReportUnsupportedShaclConstruct,
    right: CheckReportUnsupportedShaclConstruct,
): number {
    return (
        compareText(left.file, right.file) ||
        (left.location?.line ?? 0) - (right.location?.line ?? 0) ||
        (left.location?.column ?? 0) - (right.location?.column ?? 0) ||
        compareText(left.kind, right.kind) ||
        compareText(left.shape ?? '', right.shape ?? '') ||
        compareText(left.construct, right.construct) ||
        compareText(left.message, right.message) ||
        compareText(left.sourceId, right.sourceId)
    );
}

function assertCanonicalOrdering(report: CheckProjectReport): void {
    function ownerKey(owner: (typeof report.reasoning.inferred)[number]['contributingOwners'][number]): string {
        return `${owner.role}\u0000${owner.canonicalIri}`;
    }
    function assertOwner(owner: (typeof report.reasoning.inferred)[number]['contributingOwners'][number]): void {
        assertSorted(owner.ownedIriPrefixes, (item) => item, 'owner IRI prefixes');
    }
    assertSorted(report.sources.selectors, (item) => `${item.stage}\u0000${item.id}`, 'source selectors');
    assertSorted(report.sources.files, (item) => `${item.stage}\u0000${item.file}\u0000${item.id}`, 'source files');
    assertSorted(report.sources.citationRoots, (item) => item.name, 'citation roots');
    assertSorted(
        report.reasoning.diagnostics,
        (item) => `${item.severity}\u0000${item.code}\u0000${item.message}\u0000${JSON.stringify(item.axiomIds)}`,
        'reasoner diagnostics',
    );
    const ontologyFiles = new Set(
        report.sources.files.filter((item) => item.stage === 'ontology').map((item) => item.file),
    );
    for (const diagnostic of report.reasoning.diagnostics) {
        assertSorted(diagnostic.axiomIds, (item) => item, 'reasoner diagnostic axiom IDs');
        const locations = diagnostic.locations ?? [];
        for (let index = 1; index < locations.length; index += 1) {
            const previous = locations[index - 1];
            const current = locations[index];
            if (
                previous !== undefined &&
                current !== undefined &&
                compareCheckReportLocations(previous, current) >= 0
            ) {
                throw new TypeError('reasoner diagnostic locations must be strictly sorted and unique');
            }
        }
        if (diagnostic.locations !== undefined && diagnostic.axiomIds.length === 0) {
            throw new TypeError('A reasoner diagnostic without axioms has no locations');
        }
        if (locations.some((location) => !ontologyFiles.has(location.file))) {
            throw new TypeError('A reasoner diagnostic location must name a reported ontology source file');
        }
    }
    assertSorted(report.reasoning.inferred, (item) => item.id, 'inferred statements');
    for (const inference of report.reasoning.inferred) {
        assertSorted(inference.premiseIds, (item) => item, 'inference premise IDs');
        assertSorted(inference.contributingSourceIds, (item) => item, 'inference contributing source IDs');
        assertSorted(inference.contributingOwners, ownerKey, 'inference contributing owners');
        for (const owner of inference.contributingOwners) {
            assertOwner(owner);
        }
    }
    assertSorted(report.reasoning.lemmas ?? [], (item) => item.id, 'lemmas');
    for (const lemma of report.reasoning.lemmas ?? []) {
        assertSorted(lemma.premiseIds, (item) => item, 'lemma premise IDs');
    }
    assertSorted(
        report.reasoning.unsatisfiableClasses,
        (item) =>
            `${item.classIri}\u0000${item.justificationDigest}\u0000${JSON.stringify(item.premiseIds)}\u0000${JSON.stringify(item.contributingSourceIds)}\u0000${JSON.stringify(item.contributingOwners)}`,
        'unsatisfiable classes',
    );
    for (const item of report.reasoning.unsatisfiableClasses) {
        assertSorted(item.premiseIds, (value) => value, 'unsatisfiable-class premise IDs');
        assertSorted(item.contributingSourceIds, (value) => value, 'unsatisfiable-class contributing source IDs');
        assertSorted(item.contributingOwners, ownerKey, 'unsatisfiable-class contributing owners');
        for (const owner of item.contributingOwners) {
            assertOwner(owner);
        }
    }
    const borrowed = report.stages.core.borrowedTerms;
    if (borrowed !== null) {
        assertSorted(borrowed.used, (item) => item, 'borrowed used terms');
        assertSorted(borrowed.declared, (item) => item, 'borrowed declared terms');
        assertSorted(borrowed.missing, (item) => item, 'borrowed missing terms');
    }
    const domainRange = report.stages.core.propertyDomainRange;
    if (domainRange !== null) {
        assertSorted(domainRange.properties, (item) => item, 'property domain/range IRIs');
        assertSorted(domainRange.findings, (item) => item.property, 'property domain/range findings');
    }
    const shacl = report.stages.shacl.details;
    if (shacl !== null) {
        assertNondecreasing(
            shacl.findings,
            (item) =>
                `${item.severity}\u0000${item.focus ?? ''}\u0000${item.path ?? ''}\u0000${item.shape ?? ''}\u0000${item.message}\u0000${JSON.stringify(item.shapeSourceIds)}\u0000${JSON.stringify(item.shapeOwners)}`,
            'SHACL findings',
        );
        for (const finding of shacl.findings) {
            assertSorted(finding.shapeSourceIds, (item) => item, 'SHACL finding source IDs');
            assertSorted(finding.shapeOwners, ownerKey, 'SHACL finding owners');
            for (const owner of finding.shapeOwners) {
                assertOwner(owner);
            }
        }
        assertSorted(shacl.shapes, (item) => item.shape, 'SHACL shape coverage');
        for (const shape of shacl.shapes) {
            assertSorted(shape.sourceIds, (item) => item, 'SHACL shape source IDs');
            assertSorted(shape.owners, ownerKey, 'SHACL shape owners');
            for (const owner of shape.owners) {
                assertOwner(owner);
            }
        }
        assertSorted(shacl.selfTest, (item) => item.shape, 'SHACL self-tests');
        assertSorted(shacl.sourceDigests, (item) => item.sourceId, 'SHACL source digests');
        const unsupported = shacl.unsupported ?? [];
        for (let index = 1; index < unsupported.length; index += 1) {
            const previous = unsupported[index - 1];
            const current = unsupported[index];
            if (
                previous !== undefined &&
                current !== undefined &&
                compareUnsupportedShaclConstructs(previous, current) > 0
            ) {
                throw new TypeError('Unsupported SHACL constructs must be sorted');
            }
        }
    }
    const questions = report.stages.competencyQuestions.details;
    if (questions !== null) {
        assertSorted(questions.questions, (item) => item.id, 'competency questions');
        for (const question of questions.questions) {
            assertOwner(question.owner);
            assertSorted(
                question.metadataDiagnostics,
                (item) => `${item.code}\u0000${item.message}`,
                'competency-question metadata diagnostics',
            );
        }
    }
    const citations = report.stages.citations.details;
    if (citations !== null) {
        assertSorted(citations.citations, (item) => item.observation, 'citations');
        for (const citation of citations.citations) {
            assertSorted(citation.affectedFacts, (item) => item, 'citation affected facts');
            assertSorted(
                citation.metadataDiagnostics,
                (item) => `${item.predicate}\u0000${JSON.stringify(item.values)}`,
                'citation metadata diagnostics',
            );
            for (const diagnostic of citation.metadataDiagnostics) {
                assertSorted(diagnostic.values, (item) => item, 'citation ambiguous values');
            }
            assertNondecreasing(
                citation.files,
                (item) => `${item.path}\u0000${String(item.exists)}\u0000${item.gitState ?? ''}`,
                'citation files',
            );
        }
    }
    assertSorted(report.warnings, (item) => `${item.stage}\u0000${item.code}\u0000${item.message}`, 'warnings');
}

function assertUnreasonedSemantics(report: CheckProjectReport): void {
    const unreasoned = report.unreasoned;
    if (unreasoned === undefined) {
        return;
    }
    const ontologyFiles = new Set(
        report.sources.files.filter((item) => item.stage === 'ontology').map((item) => item.file),
    );
    function assertFiles(files: ReadonlyArray<string>): void {
        assertSorted(files, (item) => item, 'unreasoned files');
        if (files.some((file) => !ontologyFiles.has(file))) {
            throw new TypeError('Unreasoned findings must name reported ontology source files');
        }
    }
    assertSorted(unreasoned.constructs, (item) => `${item.group}\u0000${item.construct}`, 'unreasoned constructs');
    let findings = 0;
    let statements = 0;
    for (const construct of unreasoned.constructs) {
        const exampleStatements = construct.examples.reduce((total, item) => total + item.statementCount, 0);
        if (
            construct.examples.length !== Math.min(construct.findingCount, UNREASONED_EXAMPLE_LIMIT) ||
            exampleStatements > construct.statementCount ||
            construct.statementCount - exampleStatements < construct.findingCount - construct.examples.length
        ) {
            throw new TypeError('Unreasoned examples must be the first findings of their construct and fit its counts');
        }
        for (const example of construct.examples) {
            assertFiles(example.files);
            if (example.location !== undefined && !ontologyFiles.has(example.location.file)) {
                throw new TypeError('An unreasoned location must name a reported ontology source file');
            }
        }
        if (construct.owlConstructs !== undefined) {
            assertSorted(construct.owlConstructs, (item) => item.name, 'unreasoned OWL constructs');
            if (
                construct.owlConstructs.reduce((total, item) => total + item.findingCount, 0) > construct.findingCount
            ) {
                throw new TypeError('OWL construct counts must not exceed their construct');
            }
        }
        findings += construct.findingCount;
        statements += construct.statementCount;
    }
    if (findings !== unreasoned.findingCount || statements !== unreasoned.statementCount) {
        throw new TypeError('Unreasoned totals must equal the sum of their constructs');
    }
    assertSorted(unreasoned.imports, (item) => `${item.iri}\u0000${item.ontology}`, 'unreasoned imports');
    for (const item of unreasoned.imports) {
        assertFiles(item.files);
    }
}

function assertUndeclaredAnnotationProperties(report: CheckProjectReport): void {
    const items = report.undeclaredAnnotationProperties;
    if (items === undefined) {
        return;
    }
    const ontologyFiles = new Set(
        report.sources.files.filter((item) => item.stage === 'ontology').map((item) => item.file),
    );
    assertSorted(items, (item) => item.property, 'undeclared annotation properties');
    for (const item of items) {
        assertSorted(item.files, (file) => file, 'undeclared annotation property files');
        if (
            item.files.some((file) => !ontologyFiles.has(file)) ||
            (item.firstUse !== undefined && !ontologyFiles.has(item.firstUse.file))
        ) {
            throw new TypeError('Undeclared annotation properties must name reported ontology source files');
        }
    }
}

function assertReportSemantics(report: CheckProjectReport): void {
    const stages = report.stages;
    const summaries = [
        stages.sources,
        stages.reasoning,
        stages.core,
        stages.shacl,
        stages.competencyQuestions,
        stages.citations,
    ];
    for (const stage of summaries) {
        if (stage.status === 'failed' && stage.failureCodes.length === 0) {
            throw new TypeError('A failed check stage must carry at least one deterministic failure code');
        }
        if (stage.status !== 'failed' && stage.failureCodes.length !== 0) {
            throw new TypeError('Only failed check stages may carry failure codes');
        }
        assertSorted(stage.failureCodes, (item) => item, 'stage failure codes');
    }
    function exactCodes(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>, label: string): void {
        if (JSON.stringify(actual) !== JSON.stringify([...expected].sort(compareText))) {
            throw new TypeError(`${label} failure codes do not match the v1 report semantics`);
        }
    }
    if (stages.sources.status !== 'passed') {
        throw new TypeError('A serializable check report requires a completed source stage');
    }
    const sourceCounts = {
        ontology: report.sources.files.filter((item) => item.stage === 'ontology').length,
        shapes: report.sources.files.filter((item) => item.stage === 'shapes').length,
        competencyQuestions: report.sources.files.filter((item) => item.stage === 'competency-questions').length,
    };
    if (
        stages.sources.ontologyFiles !== sourceCounts.ontology ||
        stages.sources.shapeFiles !== sourceCounts.shapes ||
        stages.sources.competencyQuestionFiles !== sourceCounts.competencyQuestions
    ) {
        throw new TypeError('Source stage counts must exactly match reported source files');
    }
    for (const source of report.sources.files) {
        const identified = source.mediaType !== undefined || source.parser !== undefined;
        if (
            (source.mediaType === undefined) !== (source.parser === undefined) ||
            (source.stage !== 'ontology' && (identified || source.graphHash !== undefined)) ||
            (source.graphHash !== undefined && !identified)
        ) {
            throw new TypeError('Only ontology sources carry a media type and parser, together, and a graph hash');
        }
    }
    assertUnreasonedSemantics(report);
    assertUndeclaredAnnotationProperties(report);
    const sourceIds = new Set<string>();
    for (const source of report.sources.files) {
        if (sourceIds.has(source.id)) {
            throw new TypeError('Reported source file IDs must be globally unique');
        }
        sourceIds.add(source.id);
    }
    function sourceIdsFor(stage: 'ontology' | 'shapes' | 'competency-questions') {
        return new Set(report.sources.files.filter((item) => item.stage === stage).map((item) => item.id));
    }
    const ontologyIds = sourceIdsFor('ontology');
    const shapeIds = sourceIdsFor('shapes');
    const questionIds = sourceIdsFor('competency-questions');
    if (ontologyIds.size === 0) {
        throw new TypeError('A check report requires at least one ontology source file');
    }
    const selectorIds = new Set(report.sources.selectors.map((item) => item.id));
    if (selectorIds.size !== report.sources.selectors.length) {
        throw new TypeError('Reported source selector IDs must be globally unique');
    }
    function selectorCount(stage: 'ontology' | 'shapes' | 'competency-questions') {
        return report.sources.selectors.filter((item) => item.stage === stage).length;
    }
    if (
        selectorCount('ontology') === 0 ||
        selectorCount('shapes') > 0 !== shapeIds.size > 0 ||
        selectorCount('competency-questions') > 0 !== questionIds.size > 0
    ) {
        throw new TypeError('Source selector stages must exactly match discovered source-file stages');
    }
    for (const derived of [...report.reasoning.inferred, ...report.reasoning.unsatisfiableClasses]) {
        if (
            derived.contributingSourceIds.length === 0 ||
            derived.contributingOwners.length === 0 ||
            derived.contributingSourceIds.some((id) => !ontologyIds.has(id))
        ) {
            throw new TypeError('Reasoning provenance must reference reported ontology source files and owners');
        }
    }
    if (
        report.reasoning.inferredStatementCount !== report.reasoning.inferred.length ||
        report.reasoning.materializedStatementCount > report.reasoning.inferredStatementCount
    ) {
        throw new TypeError('Reasoning statement counts are inconsistent with the reported inferred statements');
    }
    const isConsistentDecision =
        report.reasoning.outcome === 'decided' && report.reasoning.consistency === 'consistent';
    const hasReasonerError = report.reasoning.diagnostics.some((item) => item.severity === 'error');
    if (report.reasoning.outcome === 'decided') {
        if (report.reasoning.negativeOutcome !== null) {
            throw new TypeError('A decided outcome cannot carry negative-outcome evidence');
        }
    } else if (report.reasoning.negativeOutcome?.outcome !== report.reasoning.outcome) {
        throw new TypeError('A negative outcome requires matching refusal or incompatibility evidence');
    }
    if (report.reasoning.outcome !== 'decided' && report.reasoning.diagnostics.length === 0) {
        throw new TypeError('A negative reasoner outcome requires at least one protocol diagnostic');
    }
    // The check states it on every decided, consistent report it writes; reports written before it did still decode.
    if (report.reasoning.completeness !== undefined && !isConsistentDecision) {
        throw new TypeError('Only a report that decided consistency states how completeness is checked');
    }
    if (isConsistentDecision && !hasReasonerError) {
        if (stages.reasoning.status !== 'passed') {
            throw new TypeError('A consistent decided outcome requires a passed reasoning stage');
        }
        exactCodes(stages.reasoning.failureCodes, [], 'Reasoning');
    } else {
        if (stages.reasoning.status !== 'failed' || report.outcome !== 'failed') {
            throw new TypeError('A negative or inconsistent reasoning outcome must be a failed report');
        }
        if (report.reasoning.outcome !== 'decided' && report.reasoning.consistency !== null) {
            throw new TypeError('Refused and incompatible outcomes cannot claim a consistency decision');
        }
        if (
            report.reasoning.outcome === 'decided' &&
            report.reasoning.consistency !== 'inconsistent' &&
            !(report.reasoning.consistency === 'consistent' && hasReasonerError)
        ) {
            throw new TypeError('A failed decided reasoning report must be inconsistent or carry an error diagnostic');
        }
        if (
            report.reasoning.inferred.length !== 0 ||
            report.reasoning.lemmas !== undefined ||
            report.reasoning.unsatisfiableClasses.length !== 0 ||
            report.reasoning.inferredStatementCount !== 0 ||
            report.reasoning.materializedStatementCount !== 0
        ) {
            throw new TypeError('A non-materialized reasoning failure cannot report derived graph output');
        }
        const expectedReasoningCode =
            report.reasoning.outcome === 'decided'
                ? report.reasoning.consistency === 'inconsistent'
                    ? 'global-inconsistency'
                    : 'reasoner-error-diagnostic'
                : report.reasoning.negativeOutcome?.reason;
        if (expectedReasoningCode === undefined) {
            throw new TypeError('Negative reasoning result lacks a reason');
        }
        exactCodes(stages.reasoning.failureCodes, [expectedReasoningCode], 'Reasoning');
    }
    const downstream = [stages.core, stages.shacl, stages.competencyQuestions, stages.citations] as const;
    if (stages.reasoning.status === 'failed') {
        if (downstream.some((stage) => stage.status !== 'not-run')) {
            throw new TypeError('A failed reasoning stage requires every downstream stage to be not-run');
        }
    } else {
        if (
            stages.core.status === 'not-run' ||
            stages.core.status === 'skipped' ||
            stages.citations.status === 'not-run' ||
            stages.citations.status === 'skipped'
        ) {
            throw new TypeError('A consistent reasoning decision requires executed core and citation stages');
        }
        const expectedShaclStatus = stages.sources.shapeFiles === 0 ? 'skipped' : 'executed';
        const shaclExecuted = stages.shacl.status === 'passed' || stages.shacl.status === 'failed';
        if (
            (expectedShaclStatus === 'skipped' && stages.shacl.status !== 'skipped') ||
            (expectedShaclStatus === 'executed' && !shaclExecuted)
        ) {
            throw new TypeError('SHACL stage execution must exactly match the discovered shape count');
        }
        const expectedCqStatus = stages.sources.competencyQuestionFiles === 0 ? 'skipped' : 'executed';
        const cqExecuted =
            stages.competencyQuestions.status === 'passed' || stages.competencyQuestions.status === 'failed';
        if (
            (expectedCqStatus === 'skipped' && stages.competencyQuestions.status !== 'skipped') ||
            (expectedCqStatus === 'executed' && !cqExecuted)
        ) {
            throw new TypeError('Competency-question stage execution must exactly match the discovered question count');
        }
    }
    const detailStages = [stages.shacl, stages.competencyQuestions, stages.citations] as const;
    for (const stage of detailStages) {
        const shouldHaveDetails = stage.status === 'passed' || stage.status === 'failed';
        if ((stage.details !== null) !== shouldHaveDetails) {
            throw new TypeError('Validation stage detail presence must match its execution status');
        }
        if (stage.details !== null && stage.details.conforms !== (stage.status === 'passed')) {
            throw new TypeError('Validation stage status must match its conformance detail');
        }
    }
    const coreHasDetails = stages.core.borrowedTerms !== null && stages.core.propertyDomainRange !== null;
    if (coreHasDetails !== (stages.core.status === 'passed' || stages.core.status === 'failed')) {
        throw new TypeError('Core stage details must be complete exactly when the stage executed');
    }
    if ((stages.core.borrowedTerms === null) !== (stages.core.propertyDomainRange === null)) {
        throw new TypeError('Core validation details cannot be partial');
    }
    if (coreHasDetails) {
        const borrowed = stages.core.borrowedTerms;
        const domainRange = stages.core.propertyDomainRange;
        const expectedMissing = borrowed.used.filter((iri) => !borrowed.declared.includes(iri));
        if (
            JSON.stringify(borrowed.missing) !== JSON.stringify(expectedMissing) ||
            borrowed.conforms !== (borrowed.missing.length === 0)
        ) {
            throw new TypeError('Borrowed-term conformance and missing terms must match used minus declared terms');
        }
        if (
            domainRange.conforms !== (domainRange.findings.length === 0) ||
            domainRange.findings.some((item) => !domainRange.properties.includes(item.property))
        ) {
            throw new TypeError('Property domain/range conformance and findings must match the reported property set');
        }
        const conforms = borrowed.conforms && domainRange.conforms;
        if (conforms !== (stages.core.status === 'passed')) {
            throw new TypeError('Core stage status must match both conformance checks');
        }
        exactCodes(
            stages.core.failureCodes,
            [
                ...(!borrowed.conforms ? ['borrowed-terms'] : []),
                ...(!domainRange.conforms ? ['property-domain-range'] : []),
            ],
            'Core',
        );
    }
    const shacl = stages.shacl.details;
    if (shacl !== null) {
        const counts = {
            violation: shacl.findings.filter((item) => item.severity === 'Violation').length,
            warning: shacl.findings.filter((item) => item.severity === 'Warning').length,
            info: shacl.findings.filter((item) => item.severity === 'Info').length,
        };
        if (
            shacl.counts.violation !== counts.violation ||
            shacl.counts.warning !== counts.warning ||
            shacl.counts.info !== counts.info ||
            shacl.conforms !==
                (counts.violation === 0 &&
                    shacl.selfTest.every((item) => item.fired) &&
                    shacl.unsupported === undefined)
        ) {
            throw new TypeError('SHACL counts and conformance must match its deterministic findings and self-tests');
        }
        if (
            shacl.findings.some(
                (item) =>
                    item.shapeSourceIds.length === 0 ||
                    item.shapeOwners.length === 0 ||
                    item.shapeSourceIds.some((id) => !shapeIds.has(id)),
            ) ||
            shacl.shapes.some(
                (item) =>
                    item.sourceIds.length === 0 ||
                    item.owners.length === 0 ||
                    item.sourceIds.some((id) => !shapeIds.has(id)),
            )
        ) {
            throw new TypeError('SHACL provenance must reference reported shape source files and owners');
        }
        if (
            shacl.shapes.some(
                (item) => item.resultCount !== shacl.findings.filter((finding) => finding.shape === item.shape).length,
            )
        ) {
            throw new TypeError('SHACL shape result counts must match projected findings');
        }
        if (
            shacl.shapes.some((item) => (item.targetKind === 'none') !== (item.targetTerm === null)) ||
            shacl.selfTest.some((item) => item.fired !== (item.reason === null))
        ) {
            throw new TypeError('SHACL target and self-test fields must match their runtime state');
        }
        const shapeNames = shacl.shapes.map((item) => item.shape);
        const selfTestNames = shacl.selfTest.map((item) => item.shape);
        if (
            JSON.stringify(shapeNames) !== JSON.stringify(selfTestNames) ||
            shacl.findings.some((item) => item.shape === null || !shapeNames.includes(item.shape))
        ) {
            throw new TypeError('SHACL summaries, self-tests, and findings must reference the same declared shapes');
        }
        const expectedShapeDigests = report.sources.files
            .filter((item) => item.stage === 'shapes')
            .map((item) => ({ sourceId: item.id, contentDigest: item.contentDigest }))
            .sort((left, right) => compareText(left.sourceId, right.sourceId));
        if (JSON.stringify(shacl.sourceDigests) !== JSON.stringify(expectedShapeDigests)) {
            throw new TypeError('SHACL validation must be bound to every reported shape source digest');
        }
        if (shacl.unsupported !== undefined) {
            const shapeFiles = new Map(
                report.sources.files.filter((item) => item.stage === 'shapes').map((item) => [item.id, item.file]),
            );
            if (shacl.findings.length !== 0 || shacl.shapes.length !== 0 || shacl.selfTest.length !== 0) {
                throw new TypeError('A refused SHACL step cannot report findings, shape summaries or self-tests');
            }
            if (
                shacl.unsupported.some(
                    (item) =>
                        shapeFiles.get(item.sourceId) !== item.file ||
                        (item.location !== undefined && item.location.file !== item.file),
                )
            ) {
                throw new TypeError('Unsupported SHACL constructs must reference reported shape source files');
            }
        }
        exactCodes(
            stages.shacl.failureCodes,
            shacl.unsupported !== undefined
                ? [SHACL_UNSUPPORTED_CONSTRUCT_CODE]
                : shacl.conforms
                  ? []
                  : ['shacl-conformance'],
            'SHACL',
        );
    }
    const questions = stages.competencyQuestions.details;
    if (questions !== null) {
        const executed = questions.questions.filter((item) => item.execution === 'executed').length;
        const dormant = questions.questions.filter((item) => item.execution === 'dormant-dependency').length;
        if (
            questions.executed !== executed ||
            questions.dormant !== dormant ||
            questions.conforms !== questions.questions.every((item) => !item.blocking)
        ) {
            throw new TypeError('Competency-question counts and conformance must match reported questions');
        }
        const reportedQuestions = new Map(
            report.sources.files
                .filter((item) => item.stage === 'competency-questions')
                .map((item) => [item.id, item.file]),
        );
        if (
            questions.questions.length !== questionIds.size ||
            questions.questions.some((item) => reportedQuestions.get(item.id) !== item.file)
        ) {
            throw new TypeError('Competency questions must correspond exactly to reported question source files');
        }
        if (
            questions.questions.some((item) => {
                if (item.execution === 'dormant-dependency') {
                    return item.owner.role !== 'dependency' || item.rows !== null || item.ok !== null || item.blocking;
                }
                if (item.owner.role !== 'root' || item.ok === null) {
                    return true;
                }
                const documentedExpectedFailure =
                    item.expectedToFail && !item.ok && item.closes !== null && item.metadataDiagnostics.length === 0;
                const expectedBlocking =
                    item.metadataDiagnostics.length > 0 || (!item.ok && !documentedExpectedFailure);
                return item.blocking !== expectedBlocking || (item.rows === null && (item.ok || !item.blocking));
            })
        ) {
            throw new TypeError('Competency-question execution state must match owner role and result fields');
        }
        exactCodes(
            stages.competencyQuestions.failureCodes,
            questions.conforms ? [] : ['competency-question-conformance'],
            'Competency-question',
        );
    }
    const citations = stages.citations.details;
    if (citations !== null) {
        if (
            citations.warnings !== citations.citations.filter((item) => item.warning).length ||
            citations.conforms !== citations.citations.every((item) => !item.blocking)
        ) {
            throw new TypeError('Citation counts and conformance must match reported citations');
        }
        const blockingStatuses = new Set([
            'ambiguous-metadata',
            'unsafe-source-path',
            'missing-source-path',
            'commit-not-in-repo',
        ]);
        const warningStatuses = new Set(['changed-since', 'uncommitted-edit']);
        for (const citation of citations.citations) {
            if (
                citation.files.length === 0 ||
                citation.blocking !== blockingStatuses.has(citation.status) ||
                citation.warning !== warningStatuses.has(citation.status) ||
                (citation.status === 'ambiguous-metadata') !== citation.metadataDiagnostics.length > 0 ||
                citation.files.some((file) => file.gitState !== null && file.exists !== true)
            ) {
                throw new TypeError('Citation status, flags, metadata, and file evidence are inconsistent');
            }
            if (
                (citation.status === 'ambiguous-metadata' || citation.status === 'unsafe-source-path') &&
                !citation.files.every((file) => file.exists === null && file.gitState === null)
            ) {
                throw new TypeError('Ambiguous or unsafe citations cannot claim filesystem or Git evidence');
            }
            if (citation.status === 'ok') {
                throw new TypeError('A cited source path cannot have an evidence-free ok status');
            }
            const states = new Set<string>(
                citation.files.flatMap((file) => (file.gitState === null ? [] : [file.gitState])),
            );
            const expectedState = [
                'commit-not-in-repo',
                'changed-since',
                'uncommitted-edit',
                'not-in-git',
                'no-commit-cited',
                'git-unavailable',
                'unchanged',
            ].find((state) => states.has(state));
            if (citation.status === 'missing-source-path' && !citation.files.some((file) => file.exists === false)) {
                throw new TypeError('A missing citation status requires a missing file');
            }
            if (
                citation.status === 'no-source-root' &&
                !citation.files.every((file) => file.exists === null && file.gitState === null)
            ) {
                throw new TypeError('A no-source-root citation cannot claim filesystem or Git evidence');
            }
            if (
                !['ambiguous-metadata', 'unsafe-source-path', 'no-source-root'].includes(citation.status) &&
                !citation.files.every(
                    (file) =>
                        typeof file.exists === 'boolean' &&
                        (file.exists ? file.gitState !== null : file.gitState === null),
                )
            ) {
                throw new TypeError('A rooted citation must carry Git evidence exactly for its existing files');
            }
            if (
                !['ambiguous-metadata', 'unsafe-source-path', 'missing-source-path', 'no-source-root'].includes(
                    citation.status,
                ) &&
                !citation.files.every((file) => file.exists === true && file.gitState !== null)
            ) {
                throw new TypeError('A rooted existing citation must carry Git evidence for every file');
            }
            if (
                expectedState !== undefined &&
                citation.status !== 'missing-source-path' &&
                citation.status !== 'ambiguous-metadata' &&
                citation.status !== 'unsafe-source-path' &&
                citation.status !== expectedState
            ) {
                throw new TypeError('Citation status must match the highest-priority Git evidence');
            }
        }
        exactCodes(stages.citations.failureCodes, citations.conforms ? [] : ['citation-conformance'], 'Citation');
    }
    const expectedWarningRows = [
        ...report.reasoning.diagnostics
            .filter((item) => item.severity === 'warning')
            .map((item) => ({
                stage: 'reasoning' as const,
                code: item.code,
                message: item.message,
            })),
        ...report.reasoning.unsatisfiableClasses.map((item) => ({
            stage: 'reasoning' as const,
            code: 'unsatisfiable-class',
            message: `${item.classIri} is unsatisfiable`,
        })),
        ...(report.undeclaredAnnotationProperties ?? []).map((item) => ({
            stage: 'reasoning' as const,
            code: UNDECLARED_ANNOTATION_PROPERTY_WARNING,
            message: undeclaredAnnotationPropertyWarning(item),
        })),
        ...(stages.shacl.details?.findings ?? [])
            .filter((item) => item.severity !== 'Violation')
            .map((item) => ({
                stage: 'shacl' as const,
                code:
                    item.severity === 'Warning'
                        ? 'shacl-warning'
                        : item.severity === 'Info'
                          ? 'shacl-info'
                          : 'shacl-non-violation',
                message: `[${item.severity}] ${item.message}${item.focus === null ? '' : ` (focus: ${item.focus})`}`,
            })),
        ...(stages.citations.details?.citations ?? [])
            .filter((item) => item.warning)
            .map((item) => ({
                stage: 'citations' as const,
                code: item.status,
                message: `${item.observation} has citation status ${item.status}`,
            })),
        ...(stages.citations.details?.citations ?? [])
            .filter(
                (item) =>
                    item.status === 'no-source-root' ||
                    item.status === 'git-unavailable' ||
                    item.status === 'not-in-git' ||
                    item.status === 'no-commit-cited',
            )
            .map((item) => ({
                stage: 'citations' as const,
                code: item.status,
                message: `${item.observation} could not be fully checked: ${item.status}`,
            })),
    ];
    const expectedWarnings = [
        ...new Map(
            expectedWarningRows.map((item) => [`${item.stage}\u0000${item.code}\u0000${item.message}`, item]),
        ).entries(),
    ]
        .sort(([left], [right]) => compareText(left, right))
        .map(([, item]) => item);
    if (JSON.stringify(report.warnings) !== JSON.stringify(expectedWarnings)) {
        throw new TypeError('Top-level warnings must be the exact deterministic projection of report evidence');
    }
    const hasFailedStage = summaries.some((stage) => stage.status === 'failed');
    const hasUnexpectedIncompleteStage = [stages.core, stages.citations].some(
        (stage) => stage.status === 'skipped' || stage.status === 'not-run',
    );
    const expectedOutcome = hasFailedStage ? 'failed' : 'passed';
    if (report.outcome !== expectedOutcome) {
        throw new TypeError('Final outcome must match all stage statuses');
    }
    if (report.outcome === 'passed' && hasUnexpectedIncompleteStage) {
        throw new TypeError('A passed report requires executed core and citation stages');
    }
}

/** Freezes every object reachable from `value`, including any a caller froze only shallowly. */
function deepFreeze<A>(value: A): A {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

/**
 * Reports this module validated and froze to the last nested value. Such a report cannot have changed since, so
 * encoding it does not validate it again.
 */
const validatedReports = new WeakSet<CheckProjectReport>();

export function decodeCheckProjectReport(input: unknown): CheckProjectReport {
    const decoded = Schema.decodeUnknownResult(CheckProjectReportSchema, STRICT_OPTIONS)(input);
    if (Result.isFailure(decoded)) {
        throw new TypeError(`Invalid ${CHECK_REPORT_VERSION} document`, { cause: decoded.failure });
    }
    assertCanonicalOrdering(decoded.success);
    assertReportSemantics(decoded.success);
    const report = deepFreeze(decoded.success);
    validatedReports.add(report);
    return report;
}

type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue };

function canonicalize(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort(compareText)
                .map((key) => {
                    const child = (value as Readonly<Record<string, JsonValue>>)[key];
                    if (child === undefined) {
                        throw new TypeError('Canonical JSON objects cannot contain undefined values');
                    }
                    return [key, canonicalize(child)];
                }),
        );
    }
    return value;
}

export function encodeCheckProjectReport(report: CheckProjectReport): string {
    const checked = validatedReports.has(report) ? report : decodeCheckProjectReport(report);
    return `${JSON.stringify(canonicalize(checked))}\n`;
}
