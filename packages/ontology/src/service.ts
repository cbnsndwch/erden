import { Context, Effect } from 'effect';

import { assembleOntology, type AssembleOntologyError, type OntologyAssemblyLimits } from './assembly.js';
import { validateCitations } from './citations.js';
import { validateCoreOntology } from './core-validation.js';
import { discoverCompetencyQuestions, discoverShapeSources, discoverTurtleSources } from './discovery.js';
import {
    CompetencyQuestionArtifactError,
    RequiredStageUnavailableError,
    type ResourceAccessError,
    type TurtleSourceParseError,
    type UnsupportedSemanticFormatError,
} from './errors.js';
import type {
    AssembledOntology,
    ByteBackedQuestionSource,
    ByteBackedShapeSource,
    ByteBackedTurtleSource,
    CitationValidation,
    CompetencyQuestionValidation,
    LoadedCompetencyQuestion,
    LoadedShapeSource,
    OntologyCheckInput,
    OntologyCheckReport,
    OntologyValidationInput,
    QuestionSourceLocationDescriptor,
    ShaclValidation,
    ShapeSourceDescriptor,
    ShapeSourceLocationDescriptor,
    TurtleSourceDescriptor,
    TurtleSourceLocationDescriptor,
} from './model.js';
import type { OntologyPorts } from './ports.js';
import type { TextResourcePort } from './ports.js';
import { runCompetencyQuestions } from './questions.js';
import { offerAssembledOntology } from './reasoner/ownership.js';
import { nodeShaclEnginePort } from './shacl-engine/port.js';
import { validateShacl, validateShaclWithEvidence, type ShaclValidationError } from './shacl.js';
import {
    captureOntologyValidationPolicy,
    resolveOntologyValidationSettings,
    ValidationPolicyCaptureError,
} from './validation-policy.js';

export type OntologyServiceError =
    | AssembleOntologyError
    | CompetencyQuestionArtifactError
    | ResourceAccessError
    | ShaclValidationError
    | ValidationPolicyCaptureError;

export interface OntologyServiceShape {
    readonly captureDataSources: (
        sources: ReadonlyArray<TurtleSourceDescriptor>,
    ) => Effect.Effect<ReadonlyArray<ByteBackedTurtleSource>, OntologyServiceError>;
    readonly assembleByteBacked: (
        sources: ReadonlyArray<ByteBackedTurtleSource>,
        limits?: OntologyAssemblyLimits,
    ) => Effect.Effect<AssembledOntology, OntologyServiceError>;
    readonly loadByteBackedShapes: (
        sources: ReadonlyArray<ByteBackedShapeSource>,
    ) => Effect.Effect<ReadonlyArray<LoadedShapeSource>, OntologyServiceError>;
    readonly loadByteBackedQuestions: (
        sources: ReadonlyArray<ByteBackedQuestionSource>,
    ) => Effect.Effect<ReadonlyArray<LoadedCompetencyQuestion>, OntologyServiceError>;
    readonly discoverDataSources: (
        locations: ReadonlyArray<TurtleSourceLocationDescriptor>,
        required?: boolean,
    ) => Effect.Effect<
        ReadonlyArray<TurtleSourceDescriptor>,
        RequiredStageUnavailableError | UnsupportedSemanticFormatError
    >;
    readonly discoverShapeSources: (
        locations: ReadonlyArray<ShapeSourceLocationDescriptor>,
        required: boolean,
    ) => Effect.Effect<
        ReadonlyArray<LoadedShapeSource>,
        RequiredStageUnavailableError | TurtleSourceParseError | UnsupportedSemanticFormatError
    >;
    readonly discoverCompetencyQuestions: (
        locations: ReadonlyArray<QuestionSourceLocationDescriptor>,
        required: boolean,
    ) => Effect.Effect<
        ReadonlyArray<LoadedCompetencyQuestion>,
        RequiredStageUnavailableError | UnsupportedSemanticFormatError
    >;
    readonly assemble: (
        sources: ReadonlyArray<TurtleSourceDescriptor>,
    ) => Effect.Effect<AssembledOntology, AssembleOntologyError>;
    readonly shacl: (
        graph: AssembledOntology,
        sources: ReadonlyArray<ShapeSourceDescriptor>,
        required: boolean,
    ) => Effect.Effect<ShaclValidation | null, ShaclValidationError>;
    readonly competencyQuestions: (
        graph: AssembledOntology,
        questions: ReadonlyArray<LoadedCompetencyQuestion>,
    ) => Effect.Effect<CompetencyQuestionValidation, CompetencyQuestionArtifactError>;
    readonly citations: (
        graph: AssembledOntology,
        roots: Readonly<Record<string, string>>,
        vocabulary?: OntologyCheckInput['citationVocabulary'],
    ) => Effect.Effect<CitationValidation, ResourceAccessError>;
    readonly validateAssembled: (
        graph: AssembledOntology,
        input: OntologyValidationInput,
    ) => Effect.Effect<OntologyCheckReport, OntologyServiceError>;
    readonly check: (input: OntologyCheckInput) => Effect.Effect<OntologyCheckReport, OntologyServiceError>;
}

export const OntologyService = Context.Service<OntologyServiceShape>('@erden/ontology/OntologyService');

export function makeOntologyService(ports: OntologyPorts): OntologyServiceShape {
    const shaclEngine = ports.shaclEngine ?? nodeShaclEnginePort;
    function byteBackedResources(
        values: ReadonlyArray<
            Readonly<{
                readonly locator: string;
                readonly bytes: Uint8Array;
            }>
        >,
    ): TextResourcePort {
        const entries = new Map(values.map(({ locator, bytes }) => [locator, Uint8Array.from(bytes)]));
        function read(locator: string) {
            return Effect.sync(() => {
                const bytes = entries.get(locator);
                if (bytes === undefined) {
                    throw new Error('missing byte-backed ontology resource');
                }
                return Uint8Array.from(bytes);
            });
        }
        return Object.freeze({
            readBytes: read,
            readText: (locator: string) =>
                read(locator).pipe(Effect.map((bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes))),
            listFiles: () => Effect.succeed([]),
        });
    }
    function validateAssembled(
        graph: AssembledOntology,
        input: OntologyValidationInput,
    ): Effect.Effect<OntologyCheckReport, OntologyServiceError> {
        return Effect.gen(function* () {
            const git = ports.git;
            const { settings, citationRoots } = resolveOntologyValidationSettings(input, git !== undefined);
            const validationPolicy =
                input.captureValidationPolicy === true
                    ? yield* Effect.try({
                          try: () => captureOntologyValidationPolicy(settings),
                          catch: () => new ValidationPolicyCaptureError(),
                      })
                    : null;
            const { borrowedTerms, propertyDomainRange } = validateCoreOntology(graph);
            const captured =
                input.captureShaclEvidence === true
                    ? yield* validateShaclWithEvidence(
                          ports.resources,
                          graph,
                          input.shapeSources,
                          settings.shaclRequired,
                          shaclEngine,
                      )
                    : null;
            const shacl =
                captured === null
                    ? yield* validateShacl(
                          ports.resources,
                          graph,
                          input.shapeSources,
                          settings.shaclRequired,
                          shaclEngine,
                      )
                    : captured.validation;
            if (
                settings.competencyQuestionsRequired &&
                !input.competencyQuestions.some((question) => question.owner.role === 'root')
            ) {
                return yield* Effect.fail(
                    new RequiredStageUnavailableError(
                        'competency-questions',
                        null,
                        'no root-project competency questions were supplied for execution',
                    ),
                );
            }
            const competencyQuestions =
                input.competencyQuestions.length === 0
                    ? null
                    : yield* Effect.try({
                          try: () => runCompetencyQuestions(graph, input.competencyQuestions),
                          catch: (cause) =>
                              cause instanceof CompetencyQuestionArtifactError
                                  ? cause
                                  : new CompetencyQuestionArtifactError('unknown', cause),
                      });
            const citationVocabulary = settings.citationVocabulary;
            const citationObservations =
                settings.citationObservationOwners === 'root'
                    ? graph.provenance
                          .filter(
                              (entry) =>
                                  entry.quad.predicate.termType === 'NamedNode' &&
                                  entry.quad.predicate.value === citationVocabulary.sourcePath &&
                                  entry.asserted.some((contributor) => contributor.owner.role === 'root'),
                          )
                          .map((entry) => entry.quad.subject.value)
                    : undefined;
            const citations = yield* validateCitations(ports.citationFiles, git, {
                dataset: graph.dataset,
                roots: citationRoots,
                vocabulary: citationVocabulary,
                ...(citationObservations === undefined ? {} : { observations: citationObservations }),
            });
            return {
                conforms:
                    borrowedTerms.conforms &&
                    propertyDomainRange.conforms &&
                    (shacl?.conforms ?? true) &&
                    (competencyQuestions?.conforms ?? true) &&
                    citations.conforms,
                graph,
                borrowedTerms,
                propertyDomainRange,
                shacl,
                ...(captured === null
                    ? {}
                    : { shaclEvidence: captured.evidence, shaclSelfTestEvidence: captured.selfTestEvidence }),
                ...(validationPolicy === null ? {} : { validationPolicy }),
                competencyQuestions,
                citations,
            };
        });
    }
    const service: OntologyServiceShape = {
        captureDataSources: (sources) =>
            Effect.gen(function* () {
                const captured: ByteBackedTurtleSource[] = [];
                for (const descriptor of sources) {
                    const bytes = yield* ports.resources
                        .readBytes(descriptor.locator)
                        .pipe(
                            Effect.mapError(
                                (cause) => new RequiredStageUnavailableError('source', descriptor.locator, cause),
                            ),
                        );
                    captured.push(Object.freeze({ descriptor, bytes: Uint8Array.from(bytes) }));
                }
                return Object.freeze(captured);
            }),
        assembleByteBacked: (sources, limits) =>
            assembleOntology(
                byteBackedResources(sources.map(({ descriptor, bytes }) => ({ locator: descriptor.locator, bytes }))),
                sources.map(({ descriptor }) => descriptor),
                limits,
            ).pipe(Effect.map(offerAssembledOntology)),
        loadByteBackedShapes: (sources) =>
            discoverShapeSources(
                byteBackedResources(sources.map(({ descriptor, bytes }) => ({ locator: descriptor.locator, bytes }))),
                sources.map(({ descriptor }) => ({
                    idPrefix: descriptor.id,
                    owner: descriptor.owner,
                    selector: { kind: 'file' as const, locator: descriptor.locator },
                    baseIri: descriptor.baseIri,
                    mediaType: descriptor.mediaType,
                })),
                sources.length > 0,
            ),
        loadByteBackedQuestions: (sources) =>
            discoverCompetencyQuestions(
                byteBackedResources(
                    sources.map(({ descriptor, bytes }) => ({ locator: descriptor.selector.locator, bytes })),
                ),
                sources.map(({ descriptor }) => descriptor),
                sources.length > 0,
            ),
        discoverDataSources: (locations, required = true) =>
            discoverTurtleSources(ports.resources, locations, required),
        discoverShapeSources: (locations, required) => discoverShapeSources(ports.resources, locations, required),
        discoverCompetencyQuestions: (locations, required) =>
            discoverCompetencyQuestions(ports.resources, locations, required),
        assemble: (sources) => assembleOntology(ports.resources, sources),
        shacl: (graph, sources, required) => validateShacl(ports.resources, graph, sources, required, shaclEngine),
        competencyQuestions: (graph, questions) =>
            Effect.try({
                try: () => runCompetencyQuestions(graph, questions),
                catch: (cause) =>
                    cause instanceof CompetencyQuestionArtifactError
                        ? cause
                        : new CompetencyQuestionArtifactError('unknown', cause),
            }),
        citations: (graph, roots, vocabulary) =>
            validateCitations(ports.citationFiles, ports.git, {
                dataset: graph.dataset,
                roots,
                ...(vocabulary === undefined ? {} : { vocabulary }),
            }),
        validateAssembled,
        check: (input) =>
            Effect.gen(function* () {
                const graph = yield* assembleOntology(ports.resources, input.dataSources);
                return yield* validateAssembled(graph, input);
            }),
    };
    return Object.freeze(service);
}
