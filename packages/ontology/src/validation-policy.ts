import { createHash } from 'node:crypto';

import type { CitationVocabulary, OntologyValidationInput } from './model.js';
import { DEFAULT_CITATION_VOCABULARY } from './model.js';
import { compareCodePoints } from './order.js';
import { SHACL_ENGINE_DIGEST, SHACL_ENGINE_NAME, SHACL_ENGINE_VERSION } from './shacl-engine/identity.js';

/**
 * Version the behavioral rules independently of lockfile/report format identities. v2 runs SHACL on erden-shacl
 * (PurRDF 3.0.1); v1 ran it on rdf-validate-shacl 0.6.5. Captures and comparison profiles recorded under v1 keep
 * verifying against the v1 document, so stored releases stay readable; every new capture uses v2.
 */
export const ONTOLOGY_VALIDATION_POLICY_ID = 'erden.ontology-validation-policy/v2' as const;
export const ONTOLOGY_VALIDATION_POLICY_DOCUMENT = `${JSON.stringify({
    id: ONTOLOGY_VALIDATION_POLICY_ID,
    scope: 'ontology-validation-after-reasoning',
    engines: {
        turtle: { name: 'n3', version: '2.1.1' },
        shacl: { name: SHACL_ENGINE_NAME, version: SHACL_ENGINE_VERSION, engineDigest: SHACL_ENGINE_DIGEST },
        sparql: { name: 'oxigraph', version: '0.5.9' },
    },
    borrowedTerms: 'external-predicates-types-subclasses-require-owl-declaration/v1',
    propertyDomainRange: 'owned-owl-properties-require-domain-and-range-in-validated-graph/v1',
    ownership: 'union-of-selected-data-source-owned-prefixes/v1',
    shacl: {
        execution: 'all-selected-root-and-dependency-shapes',
        options: 'engine-defaults-no-shapes-graph-iri-no-imports/v1',
        unsupported: 'refuse-step-on-js-owl-imports-or-entailment/v1',
        severity: 'engine-result-severity-local-name',
        blocking: 'Violation-findings-or-unfired-declared-shape-self-test',
        selfTest: 'core-target-or-sx-fixture-first-source-prefix-single-fragment/v2',
        required: 'at-least-one-selected-shape-source',
    },
    competencyQuestions: {
        execution: 'root-only-dependencies-dormant',
        required: 'at-least-one-root-question',
        placeholders: 'literal-substitution-unknown-is-blocking/v1',
        expectation: 'row-count-comparison-ask-boolean-as-zero-or-one/v1',
        metadata: 'ask-expect-from-required-expected-failure-needs-closes/v1',
        blocking: 'metadata-diagnostic-or-undocumented-failure',
    },
    citations: {
        selection: 'sourcePath-observations-root-filter-uses-asserted-provenance/v1',
        paths: 'portable-contained-relative-source-paths/v1',
        roots: 'named-root-with-default-fallback',
        status: 'priority-ordered-file-and-git-status/v1',
        blocking: ['ambiguous-metadata', 'unsafe-source-path', 'missing-source-path', 'commit-not-in-repo'],
        warnings: ['changed-since', 'uncommitted-edit'],
    },
    conforms: 'all-executed-stages-conform-skipped-optional-stages-pass',
})}\n`;
export const ONTOLOGY_VALIDATION_POLICY_SHA256 = createHash('sha256')
    .update(ONTOLOGY_VALIDATION_POLICY_DOCUMENT)
    .digest('hex');

/** The v1 policy, kept byte for byte so captures recorded under it still verify. */
export const ONTOLOGY_VALIDATION_POLICY_V1_DOCUMENT = `${JSON.stringify({
    id: 'erden.ontology-validation-policy/v1',
    scope: 'ontology-validation-after-reasoning',
    engines: {
        turtle: { name: 'n3', version: '2.1.1' },
        shacl: { name: 'rdf-validate-shacl', version: '0.6.5' },
        sparql: { name: 'oxigraph', version: '0.5.9' },
    },
    borrowedTerms: 'external-predicates-types-subclasses-require-owl-declaration/v1',
    propertyDomainRange: 'owned-owl-properties-require-domain-and-range-in-validated-graph/v1',
    ownership: 'union-of-selected-data-source-owned-prefixes/v1',
    shacl: {
        execution: 'all-selected-root-and-dependency-shapes',
        options: 'engine-defaults-with-default-rdfjs-factory',
        severity: 'missing-is-Violation-otherwise-local-name',
        blocking: 'Violation-findings-or-unfired-declared-shape-self-test',
        selfTest: 'core-target-or-sx-fixture-first-source-prefix/v1',
        required: 'at-least-one-selected-shape-source',
    },
    competencyQuestions: {
        execution: 'root-only-dependencies-dormant',
        required: 'at-least-one-root-question',
        placeholders: 'literal-substitution-unknown-is-blocking/v1',
        expectation: 'row-count-comparison-ask-boolean-as-zero-or-one/v1',
        metadata: 'ask-expect-from-required-expected-failure-needs-closes/v1',
        blocking: 'metadata-diagnostic-or-undocumented-failure',
    },
    citations: {
        selection: 'sourcePath-observations-root-filter-uses-asserted-provenance/v1',
        paths: 'portable-contained-relative-source-paths/v1',
        roots: 'named-root-with-default-fallback',
        status: 'priority-ordered-file-and-git-status/v1',
        blocking: ['ambiguous-metadata', 'unsafe-source-path', 'missing-source-path', 'commit-not-in-repo'],
        warnings: ['changed-since', 'uncommitted-edit'],
    },
    conforms: 'all-executed-stages-conform-skipped-optional-stages-pass',
})}\n`;

export type OntologyValidationPolicyId = 'erden.ontology-validation-policy/v1' | typeof ONTOLOGY_VALIDATION_POLICY_ID;

/** Every policy a stored capture may name, by id: its document and SHA-256. */
const KNOWN_POLICIES: ReadonlyMap<
    string,
    Readonly<{ id: OntologyValidationPolicyId; sha256: string; document: string }>
> = new Map(
    (
        [
            ['erden.ontology-validation-policy/v1', ONTOLOGY_VALIDATION_POLICY_V1_DOCUMENT],
            [ONTOLOGY_VALIDATION_POLICY_ID, ONTOLOGY_VALIDATION_POLICY_DOCUMENT],
        ] as const
    ).map(([id, document]) => [
        id,
        Object.freeze({ id, sha256: createHash('sha256').update(document).digest('hex'), document }),
    ]),
);

export const VALIDATION_POLICY_LIMITS = Object.freeze({
    maxRootNames: 256,
    maxRootNameBytes: 1_024,
    maxIriBytes: 4_096,
});

/** Global settings only. Selected source/owner/placeholder and citation receipts must be bound separately. */
export interface OntologyValidationSettings {
    readonly shaclRequired: boolean;
    readonly competencyQuestionsRequired: boolean;
    readonly citationObservationOwners: 'all' | 'root';
    readonly citationVocabulary: CitationVocabulary;
    readonly citationRootNames: ReadonlyArray<string>;
    readonly gitAvailable: boolean;
}

export interface OntologyValidationPolicyCapture {
    readonly schema: 'erden.ontology-validation-settings/v1';
    readonly policy: Readonly<{ id: OntologyValidationPolicyId; sha256: string; document: string }>;
    readonly settings: OntologyValidationSettings;
    /** SHA-256 of the canonical policy identity and effective global settings document, including its LF. */
    readonly sha256: string;
}

export class ValidationPolicyCaptureError extends Error {
    readonly code = 'VALIDATION_POLICY_CAPTURE_INVALID';
    constructor() {
        super('The validation policy settings cannot be captured');
        this.name = 'ValidationPolicyCaptureError';
        Object.freeze(this);
    }
}

function iri(value: string): string {
    if (
        !value.isWellFormed() ||
        Buffer.byteLength(value) > VALIDATION_POLICY_LIMITS.maxIriBytes ||
        !/^[A-Za-z][A-Za-z0-9+.-]*:[^<>"{}|^`\\\u0000-\u0020\u007f-\u009f]*$/u.test(value)
    ) {
        throw new ValidationPolicyCaptureError();
    }
    return value;
}

/** Resolve once before asynchronous validation, and use these same settings for execution and capture. */
export function resolveOntologyValidationSettings(input: OntologyValidationInput, gitAvailable: boolean) {
    const vocabulary = input.citationVocabulary ?? DEFAULT_CITATION_VOCABULARY;
    const citationVocabulary = Object.freeze({
        sourcePath: vocabulary.sourcePath,
        sourceRoot: vocabulary.sourceRoot,
        atCommit: vocabulary.atCommit,
        inRepository: vocabulary.inRepository,
        wasGeneratedBy: vocabulary.wasGeneratedBy,
        label: vocabulary.label,
    });
    const citationRoots = Object.freeze({ ...input.citationRoots });
    const settings: OntologyValidationSettings = Object.freeze({
        shaclRequired: input.shacl.required,
        competencyQuestionsRequired: input.cq.required,
        citationObservationOwners: input.citationObservationOwners ?? 'all',
        citationVocabulary,
        citationRootNames: Object.freeze(Object.keys(citationRoots).sort(compareCodePoints)),
        gitAvailable,
    });
    return Object.freeze({ settings, citationRoots });
}

/** A transient policy record, not evidence of successful publication or a complete comparison basis. */
export function captureOntologyValidationPolicy(
    settings: OntologyValidationSettings,
    under: Readonly<{ id: string; sha256: string }> = {
        id: ONTOLOGY_VALIDATION_POLICY_ID,
        sha256: ONTOLOGY_VALIDATION_POLICY_SHA256,
    },
): OntologyValidationPolicyCapture {
    try {
        const known = KNOWN_POLICIES.get(under.id);
        if (known === undefined || known.sha256 !== under.sha256) {
            throw new ValidationPolicyCaptureError();
        }
        if (
            typeof settings.shaclRequired !== 'boolean' ||
            typeof settings.competencyQuestionsRequired !== 'boolean' ||
            typeof settings.gitAvailable !== 'boolean' ||
            !['all', 'root'].includes(settings.citationObservationOwners) ||
            settings.citationRootNames.length > VALIDATION_POLICY_LIMITS.maxRootNames
        ) {
            throw new ValidationPolicyCaptureError();
        }
        const rootNames = settings.citationRootNames
            .map((name) => {
                if (
                    !name.isWellFormed() ||
                    name.length === 0 ||
                    Buffer.byteLength(name) > VALIDATION_POLICY_LIMITS.maxRootNameBytes
                ) {
                    throw new ValidationPolicyCaptureError();
                }
                return name;
            })
            .sort(compareCodePoints);
        if (new Set(rootNames).size !== rootNames.length) {
            throw new ValidationPolicyCaptureError();
        }
        const vocabulary = settings.citationVocabulary;
        const snapshot: OntologyValidationSettings = Object.freeze({
            shaclRequired: settings.shaclRequired,
            competencyQuestionsRequired: settings.competencyQuestionsRequired,
            citationObservationOwners: settings.citationObservationOwners,
            citationVocabulary: Object.freeze({
                sourcePath: iri(vocabulary.sourcePath),
                sourceRoot: iri(vocabulary.sourceRoot),
                atCommit: iri(vocabulary.atCommit),
                inRepository: iri(vocabulary.inRepository),
                wasGeneratedBy: iri(vocabulary.wasGeneratedBy),
                label: iri(vocabulary.label),
            }),
            citationRootNames: Object.freeze(rootNames),
            gitAvailable: settings.gitAvailable,
        });
        const policy = known;
        const schema = 'erden.ontology-validation-settings/v1';
        const document = `${JSON.stringify({ schema, policy: { id: policy.id, sha256: policy.sha256 }, settings: snapshot })}\n`;
        return Object.freeze({
            schema,
            policy,
            settings: snapshot,
            sha256: createHash('sha256').update(document).digest('hex'),
        });
    } catch {
        throw new ValidationPolicyCaptureError();
    }
}
