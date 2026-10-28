import type { Quad, Store } from 'n3';

import type {
    AssertedStatement,
    CheckedCertificate,
    Diagnostic,
    InferredStatement,
    Lemma,
    ProofRule,
    ReasonerProtocolVersion,
    RequiredTool,
} from '@erden/reasoner-protocol';

import type { ShaclEvidence, ShaclSelfTestEvidence } from './shacl-evidence/model.js';
import type { OntologyMediaType } from './source-formats/formats.js';
import type { OntologyValidationPolicyCapture } from './validation-policy.js';

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL = 'http://www.w3.org/2002/07/owl#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const SHACL = 'http://www.w3.org/ns/shacl#';
export const PROV = 'http://www.w3.org/ns/prov#';
export const EVIDENCE = 'https://erden.cbnsndwch.dev/onto/evidence#';
export const SHAPE_EXTENSIONS = 'https://erden.cbnsndwch.dev/onto/shapes#';

export type ProjectRole = 'root' | 'dependency';
export type RequiredStage = 'source' | 'shacl' | 'competency-questions';

export interface ProjectSourceOwner {
    readonly canonicalIri: string;
    readonly role: ProjectRole;
    readonly ownedIriPrefixes: ReadonlyArray<string>;
}

export interface AssertedSourceProvenance {
    readonly _tag: 'Asserted';
    readonly revision?: string;
}

export interface InferredSourceProvenance {
    readonly _tag: 'Inferred';
    readonly reasoner: string;
    readonly operation: string;
    readonly statementId: string;
    readonly rule: ProofRule;
    readonly premises: ReadonlyArray<string>;
    readonly justificationDigest: string;
    readonly contributingSourceIds: ReadonlyArray<string>;
    readonly contributingOwners: ReadonlyArray<ProjectSourceOwner>;
    readonly certificateDigest: string;
}

export type DataSourceProvenance = AssertedSourceProvenance | InferredSourceProvenance;

/** One ontology source. The name predates multi-format sources; the media type is the closed format union. */
export interface TurtleSourceDescriptor {
    readonly id: string;
    readonly owner: ProjectSourceOwner;
    readonly locator: string;
    readonly baseIri: string;
    readonly mediaType: OntologyMediaType;
    readonly provenance: DataSourceProvenance;
    /**
     * The owning project's policy for statements outside the V1 profile. Absent means `refuse`; `report` reasons
     * over the profile and lists the rest.
     */
    readonly outsideProfile?: 'refuse' | 'report';
}

export type OntologySourceDescriptor = TurtleSourceDescriptor;

export interface ShapeSourceDescriptor {
    readonly id: string;
    readonly owner: ProjectSourceOwner;
    readonly locator: string;
    readonly baseIri: string;
    readonly mediaType: 'text/turtle';
}

export interface LoadedShapeSource extends ShapeSourceDescriptor {
    readonly contentDigest: string;
    readonly bytes: Uint8Array;
    readonly text: string;
}

export interface ByteBackedTurtleSource {
    readonly descriptor: TurtleSourceDescriptor;
    readonly bytes: Uint8Array;
}

export interface ByteBackedShapeSource {
    readonly descriptor: ShapeSourceDescriptor;
    readonly bytes: Uint8Array;
}

export interface ByteBackedQuestionSource {
    readonly descriptor: QuestionSourceLocationDescriptor;
    readonly bytes: Uint8Array;
}

export interface ResourceSelector {
    readonly kind: 'file' | 'directory';
    readonly locator: string;
}

/**
 * Where ontology sources come from. A file selector's extension names its format; a directory selector
 * discovers Turtle only. The media type is derived per discovered file, so a location does not carry one.
 */
export interface TurtleSourceLocationDescriptor extends Omit<TurtleSourceDescriptor, 'id' | 'locator' | 'mediaType'> {
    readonly idPrefix: string;
    readonly selector: ResourceSelector;
}

export interface ShapeSourceLocationDescriptor extends Omit<ShapeSourceDescriptor, 'id' | 'locator'> {
    readonly idPrefix: string;
    readonly selector: ResourceSelector;
}

export interface QuestionSourceLocationDescriptor {
    readonly idPrefix: string;
    readonly owner: ProjectSourceOwner;
    readonly selector: ResourceSelector;
    readonly placeholders?: Readonly<Record<string, string>>;
}

export interface LoadedTurtleSource {
    readonly descriptor: TurtleSourceDescriptor;
    readonly sourceIndex: number;
    readonly tripleCount: number;
    readonly contentDigest: string;
    readonly bytes: Uint8Array;
    readonly text: string;
}

export interface QuadContributor {
    readonly sourceId: string;
    readonly sourceIndex: number;
    readonly owner: ProjectSourceOwner;
    readonly locator: string;
    readonly provenance: DataSourceProvenance;
}

export interface QuadProvenance {
    readonly key: string;
    readonly quad: Quad;
    readonly asserted: ReadonlyArray<QuadContributor & { readonly provenance: AssertedSourceProvenance }>;
    readonly inferred: ReadonlyArray<QuadContributor & { readonly provenance: InferredSourceProvenance }>;
}

export interface AssembledOntology {
    readonly dataset: Store;
    readonly sources: ReadonlyArray<LoadedTurtleSource>;
    readonly provenance: ReadonlyArray<QuadProvenance>;
}

export interface UnsatisfiableNamedClass {
    readonly classIri: string;
    readonly premiseIds: ReadonlyArray<string>;
    readonly justificationDigest: string;
    readonly contributingSourceIds: ReadonlyArray<string>;
    readonly contributingOwners: ReadonlyArray<ProjectSourceOwner>;
}

export interface ReasoningSummary {
    readonly consistency: 'consistent';
    readonly protocolVersion: ReasonerProtocolVersion;
    readonly profileId: string;
    readonly profileDigest: string;
    readonly tool: RequiredTool;
    readonly inputDigest: string;
    readonly certificate: CheckedCertificate;
    readonly diagnostics: ReadonlyArray<Diagnostic>;
    readonly assertedStatements: ReadonlyArray<AssertedStatement>;
    readonly inferredStatements: ReadonlyArray<InferredStatement>;
    /** Proof steps whose conclusion is not an RDF statement, which inferred statements may cite; empty for V1. */
    readonly lemmas: ReadonlyArray<Lemma>;
    readonly unsatisfiableClasses: ReadonlyArray<UnsatisfiableNamedClass>;
    readonly inferredStatementCount: number;
    readonly materializedStatementCount: number;
}

export interface ReasonedOntology extends AssembledOntology {
    readonly reasoning: ReasoningSummary;
}

export interface CompetencyQuestionMetadata {
    readonly ask: string | null;
    readonly expect: string | null;
    readonly from: string | null;
    readonly status: string | null;
    readonly closes: string | null;
}

export type CompetencyQuestionMetadataCode =
    | 'missing-ask'
    | 'missing-expect'
    | 'missing-from'
    | 'missing-closes'
    | 'invalid-expectation';

export interface CompetencyQuestionMetadataDiagnostic {
    readonly code: CompetencyQuestionMetadataCode;
    readonly message: string;
}

export interface LoadedCompetencyQuestion {
    readonly id: string;
    readonly owner: ProjectSourceOwner;
    readonly locator: string;
    readonly contentDigest: string;
    readonly bytes: Uint8Array;
    readonly text: string;
    readonly placeholders: Readonly<Record<string, string>>;
    readonly metadata: CompetencyQuestionMetadata;
    readonly diagnostics: ReadonlyArray<CompetencyQuestionMetadataDiagnostic>;
}

export interface BorrowedTermValidation {
    readonly used: ReadonlyArray<string>;
    readonly declared: ReadonlyArray<string>;
    readonly missing: ReadonlyArray<string>;
    readonly conforms: boolean;
}

export type MissingPropertyPart = 'domain' | 'range' | 'domain+range';

export interface PropertyDomainRangeFinding {
    readonly property: string;
    readonly missing: MissingPropertyPart;
}

export interface PropertyDomainRangeValidation {
    readonly properties: ReadonlyArray<string>;
    readonly findings: ReadonlyArray<PropertyDomainRangeFinding>;
    readonly conforms: boolean;
}

export type ShaclSeverity = string;

export interface ShaclFinding {
    readonly focus: string | null;
    readonly path: string | null;
    readonly severity: ShaclSeverity;
    readonly message: string;
    readonly shape: string | null;
    readonly shapeSourceIds: ReadonlyArray<string>;
    readonly shapeOwners: ReadonlyArray<ProjectSourceOwner>;
    /** The offending value as an N-Triples term, or null; absent from findings recorded before erden-shacl. */
    readonly value?: string | null;
    /** The constraint component IRI (`sh:sourceConstraintComponent`). */
    readonly component?: string;
    /** The result's own source shape (a property shape where that is the source; `shape` names its node shape). */
    readonly sourceShape?: string;
    /** A SPARQL result's `sh:sparql` node, when the source shape has exactly one; otherwise absent. */
    readonly sourceConstraint?: string;
}

/** The SHACL engine that decided a validation: erden-shacl's name, version and digests. */
export interface ShaclEngineIdentity {
    readonly name: string;
    readonly version: string;
    readonly engineDigest: string;
    readonly executableDigest: string;
}

export interface ShapeSummary {
    readonly shape: string;
    readonly targetKind: 'targetClass' | 'targetSubjectsOf' | 'targetObjectsOf' | 'none';
    readonly targetTerm: string | null;
    readonly targetCount: number;
    readonly resultCount: number;
    readonly sourceIds: ReadonlyArray<string>;
    readonly owners: ReadonlyArray<ProjectSourceOwner>;
}

export interface ShapeSelfTestResult {
    readonly shape: string;
    readonly fired: boolean;
    readonly reason: string | null;
}

/** The kinds of SHACL construct the refusal scan in `shacl-support.ts` looks for. */
export const UNSUPPORTED_SHACL_CONSTRUCT_KINDS = [
    'sparql-constraint',
    'js-constraint',
    'expression-constraint',
    'custom-target',
    'constraint-component',
    'owl-imports',
    'entailment',
] as const;
export type UnsupportedShaclConstructKind = (typeof UNSUPPORTED_SHACL_CONSTRUCT_KINDS)[number];

/** One statement of the selected shapes that the bundled SHACL engine cannot run, so the SHACL step is refused. */
export interface UnsupportedShaclConstruct {
    readonly kind: UnsupportedShaclConstructKind;
    /** The affected shape; for an anonymous shape, the named shape that owns it. Null when there is none. */
    readonly shape: string | null;
    /** The constraint component, target type or term the statement uses. */
    readonly construct: string;
    /** What is unsupported, in plain words. */
    readonly message: string;
    readonly sourceId: string;
    /** Where the statement is written; null when the source's positions cannot be established. */
    readonly position: Readonly<{ readonly line: number; readonly column: number }> | null;
}

export interface ShaclValidation {
    readonly conforms: boolean;
    readonly findings: ReadonlyArray<ShaclFinding>;
    readonly shapes: ReadonlyArray<ShapeSummary>;
    readonly selfTest: ReadonlyArray<ShapeSelfTestResult>;
    readonly counts: {
        readonly violation: number;
        readonly warning: number;
        readonly info: number;
    };
    readonly sourceDigests: ReadonlyArray<
        Readonly<{
            readonly sourceId: string;
            readonly contentDigest: string;
        }>
    >;
    /**
     * Present only when the step was refused: every unsupported construct of the selected shapes. A refused step
     * runs no shape, so it has no findings, shape summaries or self-tests, and it does not conform.
     */
    readonly unsupported?: ReadonlyArray<UnsupportedShaclConstruct>;
    /** The engine that ran the shapes; absent when the step was refused before any engine ran. */
    readonly engine?: ShaclEngineIdentity;
}

export interface CompetencyQuestionResult {
    readonly id: string;
    readonly owner: ProjectSourceOwner;
    readonly locator: string;
    readonly execution: 'executed' | 'dormant-dependency';
    readonly metadata: CompetencyQuestionMetadata;
    readonly metadataDiagnostics: ReadonlyArray<CompetencyQuestionMetadataDiagnostic>;
    readonly rows: number | null;
    readonly ok: boolean | null;
    readonly expectedToFail: boolean;
    readonly blocking: boolean;
    readonly reason: string;
    readonly sample: ReadonlyArray<Readonly<Record<string, string>>>;
}

export interface CompetencyQuestionValidation {
    readonly conforms: boolean;
    readonly questions: ReadonlyArray<CompetencyQuestionResult>;
    readonly executed: number;
    readonly dormant: number;
}

export interface CitationVocabulary {
    readonly sourcePath: string;
    readonly sourceRoot: string;
    readonly atCommit: string;
    readonly inRepository: string;
    readonly wasGeneratedBy: string;
    readonly label: string;
}

export const DEFAULT_CITATION_VOCABULARY: CitationVocabulary = Object.freeze({
    sourcePath: `${EVIDENCE}sourcePath`,
    sourceRoot: `${EVIDENCE}sourceRoot`,
    atCommit: `${EVIDENCE}atCommit`,
    inRepository: `${EVIDENCE}inRepository`,
    wasGeneratedBy: `${PROV}wasGeneratedBy`,
    label: `${RDFS}label`,
});

export type GitFileState =
    | 'git-unavailable'
    | 'not-in-git'
    | 'no-commit-cited'
    | 'commit-not-in-repo'
    | 'changed-since'
    | 'uncommitted-edit'
    | 'unchanged';

export interface GitInspection {
    readonly state: GitFileState;
    readonly repositoryRoot?: string;
}

export interface CitationFileResult {
    readonly path: string;
    readonly absolutePath: string | null;
    readonly exists: boolean | null;
    readonly git: GitInspection | null;
}

export type CitationStatus =
    | 'ok'
    | 'ambiguous-metadata'
    | 'unsafe-source-path'
    | 'missing-source-path'
    | 'no-source-root'
    | GitFileState;

export interface CitationResult {
    readonly observation: string;
    readonly label: string | null;
    readonly commit: string | null;
    readonly repository: string | null;
    readonly root: string;
    readonly affectedFacts: ReadonlyArray<string>;
    readonly metadataDiagnostics: ReadonlyArray<
        Readonly<{
            readonly predicate: string;
            readonly values: ReadonlyArray<string>;
        }>
    >;
    readonly files: ReadonlyArray<CitationFileResult>;
    readonly status: CitationStatus;
    readonly blocking: boolean;
    readonly warning: boolean;
}

export interface CitationValidation {
    readonly conforms: boolean;
    readonly citations: ReadonlyArray<CitationResult>;
    readonly warnings: number;
}

export interface StageRequirement {
    readonly required: boolean;
}

export interface OntologyCheckInput {
    readonly dataSources: ReadonlyArray<TurtleSourceDescriptor>;
    readonly shapeSources: ReadonlyArray<ShapeSourceDescriptor>;
    readonly competencyQuestions: ReadonlyArray<LoadedCompetencyQuestion>;
    readonly shacl: StageRequirement;
    readonly cq: StageRequirement;
    readonly citationRoots?: Readonly<Record<string, string>>;
    readonly citationVocabulary?: CitationVocabulary;
    readonly citationObservationOwners?: 'all' | 'root';
    /** Capture typed SHACL evidence from this exact run before display conversion. */
    readonly captureShaclEvidence?: boolean;
    /** Capture the behavioral policy and effective global settings used by this run. */
    readonly captureValidationPolicy?: boolean;
}

export type OntologyValidationInput = Omit<OntologyCheckInput, 'dataSources'>;

export interface OntologyCheckReport {
    readonly conforms: boolean;
    readonly graph: AssembledOntology;
    readonly borrowedTerms: BorrowedTermValidation;
    readonly propertyDomainRange: PropertyDomainRangeValidation;
    readonly shacl: ShaclValidation | null;
    readonly shaclEvidence?: ShaclEvidence | null;
    readonly shaclSelfTestEvidence?: ShaclSelfTestEvidence | null;
    readonly validationPolicy?: OntologyValidationPolicyCapture;
    readonly competencyQuestions: CompetencyQuestionValidation | null;
    readonly citations: CitationValidation;
}
