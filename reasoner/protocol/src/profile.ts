export const REASONER_PROTOCOL_VERSION = 1 as const;
export const REASONER_PROFILE_V1_ID = 'erden-required-constructs-v1' as const;
/** The profile every request names: V2, a strict superset of V1. */
export const REASONER_PROFILE_ID = 'erden-required-constructs-v2' as const;
export const REASONER_OPERATION = 'classify-and-materialize' as const;
export const ERDEN_PROOF_CHECKER_ID = 'erden-proof-checker-v3' as const;

const V1_RULES = Object.freeze([
    'subclass-type',
    'subclass-transitive',
    'object-property-domain',
    'data-property-domain',
    'object-property-range',
    'equivalent-class-subclass',
    'equivalent-class-type',
    'inverse-object-property',
    'transitive-object-property',
    'union-domain-type',
    'thing-subclass-type',
]);

/**
 * Version 3 keeps every V1 rule of version 2 (which added `union-domain-type` and `thing-subclass-type`) and adds the
 * rules of the Horn calculus and its lemmas: proof steps whose conclusion is a subsumption of a context by a class
 * expression, or a class expression of one individual (`proof-horn.ts`).
 */
export const ERDEN_PROOF_CHECKER_SPEC = Object.freeze({
    id: ERDEN_PROOF_CHECKER_ID,
    version: 3,
    rules: V1_RULES,
    hornRules: Object.freeze([
        'conjunct',
        'told',
        'and-intro',
        'and-elim',
        'union-intro',
        'exists-intro',
        'exists-bottom',
        'forall-filler',
        'inverse-pushback',
        'inverse-filler',
        'transitive-filler',
        'transitive-pushback',
        'transitive-exists',
        'functional-merge',
        'functional-pushback',
        'functional-same-as',
        'functional-filler',
        'max-zero',
        'max-zero-pushback',
        'disjoint',
        'complement',
        'sub-property',
        'transitive-edge',
        'data-domain',
        'same-as-symmetric',
        'same-as-transitive',
        'same-as-copy',
        'union-case',
        'chain-exists',
        'chain-forall',
        'chain-edge',
    ]),
    maxUnionCases: 4096,
    evidence: Object.freeze([
        'acyclic-inferred-premise-graph',
        'acyclic-lemma-premise-graph',
        'disjoint-class-inconsistency',
        'disjoint-superclass-unsatisfiability',
        'derived-nothing-inconsistency',
        'derived-nothing-unsatisfiability',
        'functional-data-property-distinct-values',
    ]),
    semantics: 'structural-v1-atomic-conclusions-and-horn-lemmas',
});

/** SHA-256 of the canonical JSON encoding of ERDEN_PROOF_CHECKER_SPEC. */
export const ERDEN_PROOF_CHECKER_SHA256 =
    'sha256:945ef6fb5e692112780308adccbb02695ef6a83183af6416284642ed475dee44' as const;

const V1_GRAPH = Object.freeze({
    graphName: 'default-only',
    entityTerms: 'named-iris-only',
    literals: 'rdf-literals-with-named-datatypes',
});
const V1_AXIOMS = Object.freeze([
    'declaration',
    'subclass',
    'class-assertion',
    'object-property-domain',
    'data-property-domain',
    'annotation-property-domain',
    'object-property-range',
    'data-property-range',
    'annotation-property-range',
    'equivalent-named-classes',
    'disjoint-named-classes',
    'inverse-object-properties',
    'transitive-object-property',
    'object-property-assertion',
    'data-property-assertion',
    'annotation-assertion',
    'finite-acyclic-object-union-of-named-classes-as-domain',
]);
const V1_DEMO_CONSTRUCTS = Object.freeze([
    'ontology-class-and-property-declarations',
    'named-subclass-hierarchy',
    'named-individual-class-assertions',
    'object-and-data-property-assertions',
    'domain-and-range-entailments',
    'annotation-assertions-with-language-and-datatype-literals',
    'finite-object-union-domain-over-named-classes',
]);
const V1_FAIL_CLOSED = Object.freeze([
    'owl-imports',
    'named-graph-or-graph-ambiguity',
    'blank-or-anonymous-entity-terms-outside-normalized-class-expressions',
    'unknown-reserved-rdf-rdfs-owl-terms',
    'construct-outside-allowlist',
    'owl-bottom-object-property',
    'owl-bottom-data-property',
    'cyclic-class-expression',
    'owl-thing-equivalent-to-owl-nothing-with-empty-domain',
    'unknown-result',
    'semantic-boundary-exhaustion',
    'reasoning-budget-exhaustion',
    'non-decided-or-unchecked-certificate',
    'missing-asserted-or-inferred-provenance',
    'missing-justification-or-certificate-digest',
    'protocol-version-mismatch',
    'tool-version-or-executable-digest-mismatch',
    'profile-id-or-profile-digest-mismatch',
    'adapter-or-calculus-digest-mismatch',
]);

/** The V1 reasoning claim is this allowlist, not unrestricted OWL 2 DL. Kept for its digest and history. */
export const ERDEN_REQUIRED_CONSTRUCTS_V1 = Object.freeze({
    id: REASONER_PROFILE_V1_ID,
    claim: 'erden-v1-allowlist-not-owl2-dl',
    graph: V1_GRAPH,
    axioms: V1_AXIOMS,
    demoConstructs: V1_DEMO_CONSTRUCTS,
    failClosed: V1_FAIL_CLOSED,
});

/** SHA-256 of the canonical JSON encoding of ERDEN_REQUIRED_CONSTRUCTS_V1. */
export const REASONER_PROFILE_V1_SHA256 =
    'sha256:0bc7dec03b01761e9762f4bc8d44b23c2f8288228cd8913d791771536bf179e5' as const;

/**
 * The V2 claim: V1 plus the Horn constructs of OWL 2 EL and RL that the Horn calculus decides,
 * still an Erden allowlist and not OWL 2 DL. A class expression is admitted only in the positions listed: positive
 * where something is asserted to be in it (a superclass, a range or domain, a class assertion), negative where
 * something is tested against it (a subclass, a disjointness member); an equivalence needs both. Nesting keeps the
 * polarity, except under a complement and in the filler of a maximum cardinality, which flip it.
 */
export const ERDEN_REQUIRED_CONSTRUCTS_V2 = Object.freeze({
    id: REASONER_PROFILE_ID,
    claim: 'erden-v2-allowlist-not-owl2-dl',
    extends: REASONER_PROFILE_V1_ID,
    graph: V1_GRAPH,
    axioms: Object.freeze([
        ...V1_AXIOMS,
        'subclass-of-class-expressions',
        'equivalent-class-expressions',
        'disjoint-class-expressions',
        'class-assertion-of-class-expression',
        'property-domain-class-expression',
        'object-property-range-class-expression',
        'sub-object-property',
        'object-property-chain',
        'equivalent-object-properties',
        'functional-object-property',
        'inverse-functional-object-property',
        'symmetric-object-property',
        'sub-data-property',
        'equivalent-data-properties',
        'functional-data-property',
    ]),
    classExpressions: Object.freeze({
        eitherPolarity: Object.freeze([
            'named-class',
            'owl-thing',
            'owl-nothing',
            'object-intersection-of',
            'object-some-values-from',
        ]),
        positiveOnly: Object.freeze([
            'object-all-values-from',
            'object-max-cardinality-0-or-1',
            'object-complement-of',
        ]),
        negativeOnly: Object.freeze(['object-union-of-named-classes']),
        propertyExpressions: Object.freeze(['object-property', 'object-inverse-of']),
    }),
    calculi: Object.freeze({
        'v1-content-only': 'erden-v1-decision-procedure',
        'beyond-v1': 'erden-horn-saturation',
    }),
    demoConstructs: V1_DEMO_CONSTRUCTS,
    failClosed: Object.freeze([
        ...V1_FAIL_CLOSED,
        'class-expression-outside-its-polarity',
        'union-domain-case-split-not-local',
        'non-regular-property-hierarchy',
        'uncheckable-functional-data-clash',
    ]),
});

/** SHA-256 of the canonical JSON encoding of ERDEN_REQUIRED_CONSTRUCTS_V2. */
export const REASONER_PROFILE_SHA256 =
    'sha256:ff36438e2500497ed8dc8b955cf7033c9bed781495c214793c0ba6859bbede5f' as const;

/** Raw PurRDF remains research evidence; no unwrapped PurRDF API or binary is selected. */
export const PURRDF_RESEARCH_REFERENCE = Object.freeze({
    rawEngineSelection: Object.freeze({
        status: 'not-selected' as const,
        scope: 'raw-or-unwrapped-purrdf-api-or-binary',
    }),
    commit: 'dfb1df73199668720116dfbc737c0585e23afb5e',
    tag: 'rust-v0.12.0',
    knownDivergences: Object.freeze([
        Object.freeze({
            code: 'bottom-object-property-missed-inconsistency',
            construct: 'http://www.w3.org/2002/07/owl#bottomObjectProperty',
            observed: 'inconsistent-input-reported-consistent',
            requiredV1Outcome: 'refused',
        }),
        Object.freeze({
            code: 'bottom-data-property-missed-inconsistency',
            construct: 'http://www.w3.org/2002/07/owl#bottomDataProperty',
            observed: 'inconsistent-input-reported-consistent',
            requiredV1Outcome: 'refused',
        }),
        Object.freeze({
            code: 'cyclic-expression-result-withheld',
            construct: 'cyclic-class-expression',
            observed: 'no-decided-certificate',
            requiredV1Outcome: 'refused',
        }),
        Object.freeze({
            code: 'thing-nothing-empty-domain-wrongly-satisfiable',
            construct: 'owl:Thing-equivalentClass-owl:Nothing-empty-domain',
            observed: 'inconsistent-input-reported-consistent',
            requiredV1Outcome: 'refused',
        }),
    ]),
});

/** Selection applies only to the wrapped, pinned executable and closed profile. */
export const ERDEN_REASONER_V1_SELECTION = Object.freeze({
    status: 'selected-for-erden-v1' as const,
    scope: 'wrapped-pinned-erden-reasoner-closed-profile-only',
    profileId: REASONER_PROFILE_ID,
    purrdfCrateVersion: '0.12.0',
    purrdfCommit: 'dfb1df73199668720116dfbc737c0585e23afb5e',
    rustVersion: '1.96.0',
    qualificationEvidence: 'reasoner/qualification/artifacts.json',
    arbitraryOwl2Dl: false,
    distributionComplete: true,
});
