import { basename, extname, isAbsolute, posix, relative, resolve } from 'node:path';

import { Context, Effect } from 'effect';

import {
    checkLockConsistency,
    parseLockfile,
    type LockPackageNode,
    type LockfileV1,
    type LockToolchain,
    CurrentToolchain,
    nodeCurrentToolchainService,
    type CurrentToolchainError,
    ManifestAmbiguityError,
    ManifestParseError,
    MANIFEST_FILENAMES,
    outsideProfileSourceField,
    type LoadedManifestV1,
    CheckProjectOperationalError,
    type CheckProjectError,
    type CheckProjectErrorDiagnostic,
    CHECK_REPORT_VERSION,
    compareCheckReportLocations,
    compareUnsupportedShaclConstructs,
    decodeCheckProjectReport,
    REASONING_COMPLETENESS,
    SHACL_UNSUPPORTED_CONSTRUCT_CODE,
    UNDECLARED_ANNOTATION_PROPERTY_WARNING,
    undeclaredAnnotationPropertyWarning,
    UNREASONED_EXAMPLE_LIMIT,
    UNREASONED_NOTE,
    type CheckProjectReport,
    type CheckReportLocation,
    type CheckReportUndeclaredAnnotationProperty,
    type CheckReportUnreasoned,
    type CheckReportUnsupportedShaclConstruct,
} from '@erden/contracts';
import {
    CompetencyQuestionArtifactError,
    ShaclAnswerUntrustedError,
    ShaclEngineUnavailableError,
    ShaclLimitsError,
    ShaclProcessError,
    ShaclRefusedError,
    ShaclRequestEncodingError,
    DEFAULT_REASONER_LIMITS,
    OntologyInconsistencyError,
    OntologyService,
    ReasonerMaterializationError,
    ReasonerNormalizationError,
    ReasonerProcessError,
    ReasonerService,
    TrustedNegativeReasonerOutcomeError,
    makeNodeOntologyPorts,
    makeOntologyService,
    nodeReasonerService,
    identifyOntologySources,
    isOntologyFileSelector,
    OntologySourceParseError,
    OntologySourceRefusedError,
    locateProfileFindings,
    locateStatements,
    partitionForBundledReasoner,
    type ProfilePartition,
    type ProfilePartitionFinding,
    type StatementLocation,
    ontologySourceDescriptorMediaType,
    type AssembledOntology,
    type ByteBackedQuestionSource,
    type ByteBackedShapeSource,
    type ByteBackedTurtleSource,
    type CitationValidation,
    type CompetencyQuestionValidation,
    type LoadedCompetencyQuestion,
    type LoadedShapeSource,
    type OntologyCheckReport,
    type OntologySourceIdentity,
    type OntologyServiceError,
    type ProjectSourceOwner,
    type ReasonedOntology,
    type ReasonerLimits,
    type ReasonerServiceError,
    type ShaclValidation,
} from '@erden/ontology';
import { decodeCanonicalPackageManifest, GENERATED_MANIFEST_PATH, normalizePackagePath } from '@erden/package-format';

import type { ApplicationOperation } from '../index.js';
import { ManifestService, makeManifestService } from '../manifest/index.js';
import {
    nodeProjectDependencyStateService,
    ProjectDependencyStateService,
    isProjectDependencyStateError,
    type ProjectDependencyStateServiceShape,
} from '../project-dependency-state/index.js';
import type { ProjectLockInspection } from '../project-lock/index.js';
import {
    InstalledClosureReader,
    nodeInstalledClosureReader,
    type AuthenticatedInstalledFile,
    type InstalledClosureReaderShape,
    type LocalPackageStoreError,
    type ResolvedInstalledClosure,
    type ResolvedInstalledLayer,
} from '../store/index.js';
import { REASONER_SOURCE_BUILD_GUIDANCE, REASONER_SOURCE_BUILD_MISSING } from '../toolchain-guidance.js';

import type { CheckPhaseTimer } from './phase-timing.js';

export {
    DEFAULT_REASONER_LIMITS,
    parseReasonerLimits,
    REASONER_LIMIT_ENVIRONMENT_NAMES,
    REASONER_LIMIT_SETTINGS,
    ReasonerLimitSettingError,
    type ReasonerLimits,
    type ReasonerLimitSetting,
} from '@erden/ontology';

export interface CheckProjectOptions {
    readonly from?: string;
    readonly manifestPath?: string;
    readonly offline?: boolean;
    /** The deployment's reasoner limits; omitted means the documented defaults of `limits.ts`. */
    readonly reasonerLimits?: ReasonerLimits;
    /** Phase timing for measurement; absent, nothing is timed. */
    readonly timer?: CheckPhaseTimer;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
function stageOrder(stage: string): string {
    return `${stage}\u0000`;
}

function sortedUnique(values: ReadonlyArray<string>): ReadonlyArray<string> {
    return [...new Set(values)].sort(compareText);
}

function uniqueByKey<A>(values: ReadonlyArray<A>, key: (value: A) => string): ReadonlyArray<A> {
    const byKey = new Map<string, A>();
    for (const value of values) {
        byKey.set(key(value), value);
    }
    return [...byKey].sort(([left], [right]) => compareText(left, right)).map(([, value]) => value);
}

function portableSlashes(value: string): string {
    return value.replaceAll('\\', '/');
}

function isSafePortablePath(value: string): boolean {
    return (
        value.length > 0 &&
        !value.startsWith('/') &&
        !/^[A-Za-z]:/u.test(value) &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
        value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    );
}

function portableRelativePath(projectRoot: string, locator: string, fallback: string): string {
    const resolvedRelative = portableSlashes(relative(projectRoot, locator));
    return !isAbsolute(resolvedRelative) && isSafePortablePath(resolvedRelative) ? resolvedRelative : fallback;
}

function portableLogicalPath(value: string, fallback: string): string {
    const portable = portableSlashes(value);
    return isSafePortablePath(portable) ? portable : fallback;
}

function portableManifestFile(loaded: LoadedManifestV1): string {
    const file = portableSlashes(basename(loaded.filePath));
    return file.length === 0 ? 'erden.config' : file;
}

function selectorKind(locator: string, extension: '.ttl' | '.rq'): 'file' | 'directory' {
    return extname(locator).toLowerCase() === extension ? 'file' : 'directory';
}

/** Ontology file selectors may name any RDF format Erden reads; directory selectors still mean Turtle only. */
function ontologySelectorKind(locator: string): 'file' | 'directory' {
    return isOntologyFileSelector(locator) ? 'file' : 'directory';
}

export function ownerFor(loaded: LoadedManifestV1, role: ProjectSourceOwner['role'] = 'root'): ProjectSourceOwner {
    return Object.freeze({
        canonicalIri: loaded.manifest.canonicalIri,
        role,
        ownedIriPrefixes: Object.freeze([...loaded.manifest.ownedIriPrefixes]),
    });
}

function indexedId(stage: string, index: number): string {
    return `root:${stage}:${String(index).padStart(4, '0')}`;
}

export interface CheckSourceProject {
    readonly loaded: LoadedManifestV1;
    readonly owner: ProjectSourceOwner;
    readonly idNamespace: string;
    readonly logicalPrefix: string | null;
}

function sourceId(project: CheckSourceProject, stage: string, index: number): string {
    return project.owner.role === 'root'
        ? indexedId(stage, index)
        : `${project.idNamespace}:${stage}:${String(index).padStart(4, '0')}`;
}

function sourceLocationsForProject(project: CheckSourceProject) {
    return {
        ontology: project.loaded.resolvedSources.ontology.map((locator, index) => ({
            idPrefix: sourceId(project, 'ontology', index),
            owner: project.owner,
            selector: { kind: ontologySelectorKind(locator), locator },
            baseIri: project.owner.canonicalIri,
            provenance: Object.freeze({ _tag: 'Asserted' as const }),
            ...outsideProfileSourceField(project.loaded.manifest),
        })),
        shapes: project.loaded.resolvedSources.shapes.map((locator, index) => ({
            idPrefix: sourceId(project, 'shapes', index),
            owner: project.owner,
            selector: { kind: selectorKind(locator, '.ttl'), locator },
            baseIri: project.owner.canonicalIri,
            mediaType: 'text/turtle' as const,
        })),
        competencyQuestions: project.loaded.resolvedSources.competencyQuestions.map((locator, index) => ({
            idPrefix: sourceId(project, 'competency-questions', index),
            owner: project.owner,
            selector: { kind: selectorKind(locator, '.rq'), locator },
        })),
    };
}

// Semantic text is preserved exactly in the JSON report. Terminal escaping belongs only to the renderer.
function sanitizeMessage(message: string): string {
    return message;
}

/** Each operational diagnostic is bounded; the renderer then escapes it for the terminal. */
export const CHECK_DIAGNOSTIC_TEXT_BYTES = 4096;
const SAFE_DETAIL_KEYS = ['property', 'predicate', 'subject', 'datatype', 'termType', 'context', 'candidates'] as const;

function boundedDiagnosticText(value: string): string {
    const wellFormed = value.toWellFormed();
    if (Buffer.byteLength(wellFormed, 'utf8') <= CHECK_DIAGNOSTIC_TEXT_BYTES) {
        return wellFormed;
    }
    let bytes = 0;
    let end = 0;
    for (const character of wellFormed) {
        const size = Buffer.byteLength(character, 'utf8');
        if (bytes + size > CHECK_DIAGNOSTIC_TEXT_BYTES - 3) {
            break;
        }
        bytes += size;
        end += character.length;
    }
    return `${wellFormed.slice(0, end)}\u2026`;
}

function safeDetailText(value: unknown): string | null {
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }
    const values = denseOwnArray(value, 64);
    if (values !== undefined && values.length > 0 && values.every((item) => typeof item === 'string')) {
        return values.join(', ');
    }
    return null;
}

/**
 * The cause's own message for errors whose text Erden composes from the project's own IRIs and fixed wording, plus
 * the named safe details the message does not already contain. Other causes keep the generic stage message, because
 * their text can carry host paths.
 */
function ownDiagnosticMessage(cause: unknown, stage: 'sources' | 'reasoning' | 'validation'): string | null {
    const own =
        stage === 'reasoning'
            ? cause instanceof ReasonerNormalizationError ||
              cause instanceof ReasonerProcessError ||
              cause instanceof OntologyInconsistencyError ||
              cause instanceof ReasonerMaterializationError
            : stage === 'validation' &&
              (cause instanceof CompetencyQuestionArtifactError ||
                  cause instanceof ShaclRefusedError ||
                  cause instanceof ShaclEngineUnavailableError ||
                  cause instanceof ShaclAnswerUntrustedError ||
                  cause instanceof ShaclProcessError ||
                  cause instanceof ShaclRequestEncodingError ||
                  cause instanceof ShaclLimitsError);
    if (!own) {
        return null;
    }
    const message = (cause as Error).message;
    const details = cause instanceof ReasonerNormalizationError ? cause.details : {};
    const extra = SAFE_DETAIL_KEYS.flatMap((key) => {
        const text = safeDetailText(ownDataValue(details, key));
        return text === null || message.includes(text) ? [] : [`${key}: ${text}`];
    });
    return boundedDiagnosticText(extra.length === 0 ? message : `${message} (${extra.join('; ')})`);
}

/** For a request over the ceiling: the sources that contribute the most axioms, as project paths. */
function largestSourcesText(details: unknown, path: (locator: string) => string): string | null {
    const sources = ownDataValue(details, 'sources');
    if (!Array.isArray(sources) || sources.length === 0) {
        return null;
    }
    const parts = sources.flatMap((share: unknown) => {
        const locator = ownDataValue(share, 'locator');
        const axioms = ownDataValue(share, 'axioms');
        return typeof locator === 'string' && typeof axioms === 'number'
            ? [`${path(locator)} (${String(axioms)} axioms)`]
            : [];
    });
    return parts.length === 0 ? null : `the largest sources are ${parts.join(', ')}`;
}

/**
 * A refused or unparsable non-Turtle source names its reason and the parser's own text; both come from the
 * source's content and the pinned parser, never from a host path, which the diagnostic's file field carries.
 */
function sourceDiagnosticMessage(cause: unknown): string | null {
    if (cause instanceof OntologySourceRefusedError) {
        return boundedDiagnosticText(`Refused (${cause.reason}): ${cause.detail}`);
    }
    if (cause instanceof OntologySourceParseError) {
        const parserText = cause.cause instanceof Error ? cause.cause.message : String(cause.cause);
        return boundedDiagnosticText(`The ${cause.mediaType} parser rejected the source: ${parserText}`);
    }
    return null;
}

/** Diagnostics listed for one refuse-mode failure; a larger census ends with a count of the rest. */
export const OUTSIDE_PROFILE_DIAGNOSTIC_LIMIT = 10_000;

/**
 * One finding's message: the `[group/construct]` label, the root statement and its size as before, then the OWL 2
 * construct and the finding in functional-style syntax, which also names an anonymous finding by its content.
 */
export function outsideProfileFindingMessage(finding: ProfilePartitionFinding): string {
    return boundedDiagnosticText(
        `[${finding.group}/${finding.construct}] ${finding.subject ?? '(anonymous)'} ${finding.predicate}${finding.object === null ? '' : ` ${finding.object}`}${finding.datatype === undefined || finding.datatype === finding.object ? '' : ` (datatype ${finding.datatype})`}${finding.statementKeys.length === 1 ? '' : ` (${String(finding.statementKeys.length)} statements)`}${finding.owlConstruct === null ? '' : ` is ${finding.owlConstruct}`}: ${finding.description}`,
    );
}

/**
 * One diagnostic per refuse-mode finding, so an author sees every construct outside the profile in one run, each at
 * the file, line and column of its root statement. Past the limit, a last diagnostic says how many were not listed.
 */
function outsideProfileDiagnostics(
    cause: unknown,
    diagnosticPath: (value: string) => string,
): ReadonlyArray<CheckProjectErrorDiagnostic> | null {
    if (!(cause instanceof ReasonerNormalizationError) || cause.code !== 'OUTSIDE_PROFILE') {
        return null;
    }
    const findings = cause.details.findings as ReadonlyArray<ProfilePartitionFinding>;
    const locations = (cause.details['locations'] ?? []) as ReadonlyArray<StatementLocation | null>;
    const listed = findings
        .slice(0, OUTSIDE_PROFILE_DIAGNOSTIC_LIMIT)
        .map((finding, index): CheckProjectErrorDiagnostic => {
            const location = locations[index] ?? null;
            const locator = location?.locator ?? finding.locators[0];
            return {
                code: 'OUTSIDE_PROFILE',
                message: outsideProfileFindingMessage(finding),
                file: locator === undefined ? null : diagnosticPath(locator),
                line: location?.line ?? null,
                column: location?.column ?? null,
                finding: {
                    group: finding.group,
                    construct: finding.construct,
                    owlConstruct: finding.owlConstruct,
                    subject: finding.subject,
                    predicate: finding.predicate,
                    object: finding.object,
                    ...(finding.datatype === undefined ? {} : { datatype: finding.datatype }),
                    statementCount: finding.statementKeys.length,
                    description: boundedDiagnosticText(finding.description),
                },
            };
        });
    const rest = findings.length - listed.length;
    return rest > 0
        ? [
              ...listed,
              {
                  code: 'OUTSIDE_PROFILE',
                  message: `${String(rest)} more findings are outside what Erden reasons over yet and are not listed: this list stops at ${String(listed.length)} of ${String(findings.length)}; set outsideProfile to report to count them all by construct`,
                  file: null,
                  line: null,
                  column: null,
              },
          ]
        : listed;
}

function ontologyError(
    cause: OntologyServiceError | ReasonerServiceError,
    stage: 'sources' | 'reasoning' | 'validation',
    projectRoot: string,
): CheckProjectOperationalError {
    const record = cause as unknown as {
        readonly code?: unknown;
        readonly locator?: unknown;
        readonly location?: {
            readonly file?: unknown;
            readonly line?: unknown;
            readonly column?: unknown;
        };
    };
    const code = typeof record.code === 'string' ? record.code : 'ONTOLOGY_OPERATION_FAILED';
    function diagnosticPath(value: string): string {
        return value.startsWith('dependencies/')
            ? portableLogicalPath(value, 'external/resource')
            : portableRelativePath(projectRoot, value, 'external/resource');
    }
    const locationFile =
        typeof record.location?.file === 'string'
            ? diagnosticPath(record.location.file)
            : typeof record.locator === 'string'
              ? diagnosticPath(record.locator)
              : null;
    const outsideProfile = outsideProfileDiagnostics(cause, diagnosticPath);
    if (outsideProfile !== null) {
        return new CheckProjectOperationalError(
            `CHECK_${code}`,
            stage,
            boundedDiagnosticText((cause as Error).message),
            outsideProfile,
            cause,
        );
    }
    const own = ownDiagnosticMessage(cause, stage);
    const sources = cause instanceof ReasonerProcessError ? largestSourcesText(cause.details, diagnosticPath) : null;
    return new CheckProjectOperationalError(
        `CHECK_${code}`,
        stage,
        stage === 'reasoning'
            ? 'Trusted reasoning could not complete'
            : stage === 'validation'
              ? 'Ontology validation could not complete'
              : 'Project sources could not be discovered or assembled',
        [
            {
                code,
                message:
                    (own !== null && sources !== null ? boundedDiagnosticText(`${own}; ${sources}`) : own) ??
                    sourceDiagnosticMessage(cause) ??
                    (stage === 'reasoning'
                        ? 'The bundled reasoner did not produce a trusted complete decision'
                        : stage === 'validation'
                          ? 'A validation engine or required validation resource was unavailable'
                          : 'A declared project source was unavailable, malformed, or unsupported'),
                file: locationFile,
                line: typeof record.location?.line === 'number' ? record.location.line : null,
                column: typeof record.location?.column === 'number' ? record.location.column : null,
            },
        ],
        cause,
    );
}

function dependencyError(
    code: string,
    message: string,
    guidance: string,
    cause?: unknown,
): CheckProjectOperationalError {
    return new CheckProjectOperationalError(
        code,
        'dependencies',
        message,
        [
            {
                code: 'dependency-install-guidance',
                message: guidance,
                file: null,
                line: null,
                column: null,
            },
        ],
        cause,
    );
}

function currentToolchainError(cause: CurrentToolchainError): CheckProjectOperationalError {
    const refused = cause.refusedRuntime;
    if (refused !== undefined) {
        return dependencyError(
            'CHECK_TOOLCHAIN_UNAVAILABLE',
            `No qualified bundled reasoner exists for this runtime (${refused.runtime}, ${refused.failureCode})`,
            `Supported platforms: ${refused.supportedPlatforms.join(', ')}. Run Erden on one of them.`,
            cause,
        );
    }
    if (cause.reasonerFailureCode === REASONER_SOURCE_BUILD_MISSING) {
        return dependencyError(
            'CHECK_TOOLCHAIN_UNAVAILABLE',
            `The bundled reasoner is not built in this Erden source checkout (${REASONER_SOURCE_BUILD_MISSING})`,
            REASONER_SOURCE_BUILD_GUIDANCE,
            cause,
        );
    }
    return dependencyError(
        'CHECK_TOOLCHAIN_UNAVAILABLE',
        'The current Erden validator and bundled reasoner identity could not be authenticated',
        'Repair the local Erden runtime before checking this project.',
        cause,
    );
}

const absentOwnValue = Symbol('absent-own-value');

function ownDataValue(input: unknown, key: string): unknown {
    if (input === null || typeof input !== 'object') {
        return absentOwnValue;
    }
    try {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        return descriptor !== undefined && 'value' in descriptor ? descriptor.value : absentOwnValue;
    } catch {
        return absentOwnValue;
    }
}

function denseOwnArray(input: unknown, maximum = 1024): ReadonlyArray<unknown> | undefined {
    try {
        if (!Array.isArray(input)) {
            return undefined;
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
        const length: unknown =
            lengthDescriptor !== undefined && 'value' in lengthDescriptor
                ? (lengthDescriptor.value as unknown)
                : undefined;
        if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) {
            return undefined;
        }
        const values: unknown[] = [];
        for (let index = 0; index < (length as number); index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
            if (descriptor === undefined || !('value' in descriptor)) {
                return undefined;
            }
            values.push(descriptor.value);
        }
        return values;
    } catch {
        return undefined;
    }
}

function safeManifestDiagnostics(input: unknown): ReadonlyArray<CheckProjectErrorDiagnostic> {
    const values = denseOwnArray(ownDataValue(input, 'diagnostics'));
    if (values === undefined) {
        return [];
    }
    const diagnostics: CheckProjectErrorDiagnostic[] = [];
    for (const value of values) {
        const code = ownDataValue(value, 'code');
        const message = ownDataValue(value, 'message');
        const location = ownDataValue(value, 'location');
        const file = ownDataValue(location, 'file');
        const line = ownDataValue(location, 'line');
        const column = ownDataValue(location, 'column');
        if (
            typeof code !== 'string' ||
            typeof message !== 'string' ||
            typeof file !== 'string' ||
            typeof line !== 'number' ||
            typeof column !== 'number'
        ) {
            return [];
        }
        diagnostics.push({
            code,
            message: sanitizeMessage(message),
            file: portableSlashes(basename(file)),
            line,
            column,
        });
    }
    return diagnostics;
}

function safeManifestCandidates(input: unknown): ReadonlyArray<CheckProjectErrorDiagnostic> {
    const values = denseOwnArray(ownDataValue(input, 'candidates'));
    if (values === undefined || values.some((value) => typeof value !== 'string')) {
        return [];
    }
    return values.map((candidate) => ({
        code: 'manifest-candidate',
        message: portableSlashes(basename(candidate as string)),
        file: portableSlashes(basename(candidate as string)),
        line: null,
        column: null,
    }));
}

function projectLockError(cause: unknown): CheckProjectOperationalError {
    if (!isProjectDependencyStateError(cause)) {
        return dependencyError(
            'CHECK_LOCK_INVALID',
            'The canonical project lock could not be authenticated',
            'Run erden install to create or refresh the canonical erden.lock, then check again.',
            cause,
        );
    }
    const causeMessage = ownDataValue(cause, 'message');
    const projectStateAmbiguity =
        cause.code === 'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE' &&
        (causeMessage === 'A portable manifest-name collision makes project selection ambiguous' ||
            causeMessage === 'More than one recognized root manifest makes project selection ambiguous');
    let nested: unknown = ownDataValue(cause, 'cause');
    let ambiguity: ManifestAmbiguityError | undefined;
    let parseFailure: ManifestParseError | undefined;
    const seen = new WeakSet<object>();
    for (let depth = 0; depth < 8; depth += 1) {
        try {
            if (nested instanceof ManifestAmbiguityError) {
                ambiguity = nested;
                break;
            }
            if (nested instanceof ManifestParseError) {
                parseFailure = nested;
                break;
            }
            if (nested === null || typeof nested !== 'object') {
                break;
            }
            if (seen.has(nested)) {
                break;
            }
            seen.add(nested);
            const next = ownDataValue(nested, 'cause');
            if (next === absentOwnValue) {
                break;
            }
            nested = next;
        } catch {
            break;
        }
    }
    if (ambiguity !== undefined || projectStateAmbiguity) {
        return new CheckProjectOperationalError(
            'CHECK_MANIFEST_AMBIGUOUS',
            'manifest',
            'More than one Erden manifest exists at the selected project level',
            ambiguity === undefined ? [] : safeManifestCandidates(ambiguity),
            cause,
        );
    }
    if (parseFailure !== undefined) {
        return new CheckProjectOperationalError(
            'CHECK_MANIFEST_INVALID',
            'manifest',
            'The selected Erden manifest is invalid',
            safeManifestDiagnostics(parseFailure),
            cause,
        );
    }
    if (cause.code === 'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT') {
        // Check never writes project state; the writer, erden install, recovers an interrupted transaction.
        return dependencyError(
            'CHECK_LOCK_INVALID',
            'An interrupted erden install left dependency transaction files in the project',
            'Run erden install to recover the interrupted install, then check again.',
            cause,
        );
    }
    if (cause.code === 'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE') {
        return new CheckProjectOperationalError(
            'CHECK_MANIFEST_UNAVAILABLE',
            'manifest',
            'The Erden manifest could not be located or read',
            [],
            cause,
        );
    }
    return dependencyError(
        'CHECK_LOCK_INVALID',
        'The canonical project lock could not be authenticated',
        'Run erden install to create or refresh the canonical erden.lock, then check again.',
        cause,
    );
}

function installError(cause: LocalPackageStoreError): CheckProjectOperationalError {
    return dependencyError(
        cause.code === 'INSTALL_MISSING'
            ? 'CHECK_INSTALL_MISSING'
            : cause.code === 'INSTALL_BUSY'
              ? 'CHECK_INSTALL_BUSY'
              : 'CHECK_INSTALL_INVALID',
        cause.code === 'INSTALL_MISSING'
            ? 'The exact locked dependency installation is missing'
            : cause.code === 'INSTALL_BUSY'
              ? 'The exact locked dependency installation is busy'
              : 'The exact locked dependency installation could not be authenticated',
        'Run erden install to materialize the exact locked dependency closure, then check again.',
        cause,
    );
}

/** What changed between the toolchain that wrote a lock and this release's, tool by tool, with both versions. */
function describeToolchainChange(locked: LockToolchain, current: LockToolchain): string {
    const changes = (['reasoner', 'validator'] as const).flatMap((tool) => {
        const before = locked[tool];
        const after = current[tool];
        if (before.version !== after.version) {
            return [
                `erden.lock was written with ${tool} ${before.version}; this Erden release has ${tool} ${after.version}`,
            ];
        }
        return before.sha256 === after.sha256
            ? []
            : [`erden.lock was written with a different build of ${tool} ${after.version} than this Erden release has`];
    });
    return changes.length === 0
        ? 'This Erden release has a different validator or reasoner than the one that wrote erden.lock'
        : changes.join('; ');
}

function requireAvailableLock(
    inspection: ProjectLockInspection,
    subject: 'root' | 'dependency',
    toolchain: LockToolchain,
): Effect.Effect<LockfileV1, CheckProjectOperationalError> {
    if (inspection.status === 'available') {
        return Effect.succeed(inspection.lock);
    }
    const reasons = inspection.status === 'stale' ? ` (${inspection.reasons.join(', ')})` : '';
    const toolchainChange =
        inspection.status === 'stale' && inspection.reasons.includes('toolchain-changed')
            ? describeToolchainChange(inspection.lock.toolchain, toolchain)
            : undefined;
    return Effect.fail(
        dependencyError(
            inspection.status === 'missing' ? 'CHECK_LOCK_MISSING' : 'CHECK_LOCK_STALE',
            subject === 'root'
                ? inspection.status === 'missing'
                    ? 'The project has no canonical erden.lock'
                    : `The project erden.lock does not match its manifest and current toolchain${reasons}`
                : inspection.status === 'missing'
                  ? 'An installed dependency has no canonical erden.lock'
                  : `An installed dependency erden.lock does not match its manifest and current toolchain${reasons}`,
            subject === 'root'
                ? toolchainChange !== undefined
                    ? `${toolchainChange}. Run erden install to re-lock the project with the current toolchain, then check again.`
                    : 'Run erden install to create or refresh the canonical erden.lock, then check again.'
                : 'Run erden install to replace the invalid dependency installation, then check again.',
        ),
    );
}

function edgeKey(
    edge: Readonly<{
        readonly canonicalIri: string;
        readonly requested: string;
        readonly version: string;
        readonly archiveSha256: string;
    }>,
): string {
    return `${edge.canonicalIri}\u0000${edge.version}\u0000${edge.requested}\u0000${edge.archiveSha256}`;
}

function sameDirectEdges(lock: LockfileV1, node: LockPackageNode): boolean {
    const actual = lock.directDependencies
        .map(({ canonicalIri, requested, version, archiveSha256 }) => ({
            canonicalIri,
            requested,
            version,
            archiveSha256,
        }))
        .sort((left, right) => compareText(edgeKey(left), edgeKey(right)));
    const expected = node.dependencies
        .map((edge) => ({ ...edge }))
        .sort((left, right) => compareText(edgeKey(left), edgeKey(right)));
    return (
        actual.length === expected.length &&
        actual.every((edge, index) => edgeKey(edge) === edgeKey(expected[index] as typeof edge))
    );
}

function sameEdges(
    left: ReadonlyArray<
        Readonly<{
            readonly canonicalIri: string;
            readonly requested: string;
            readonly version: string;
            readonly archiveSha256: string;
        }>
    >,
    right: ReadonlyArray<
        Readonly<{
            readonly canonicalIri: string;
            readonly requested: string;
            readonly version: string;
            readonly archiveSha256: string;
        }>
    >,
): boolean {
    const leftKeys = left.map(edgeKey).sort(compareText);
    const rightKeys = right.map(edgeKey).sort(compareText);
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}

function nodeKey(node: LockPackageNode): string {
    return `${node.canonicalIri}\u0000${node.version}\u0000${node.archiveSha256}\u0000${node.dependencies.map(edgeKey).join('\u0001')}`;
}

function reachablePackages(lock: LockfileV1, root: LockPackageNode): ReadonlyArray<LockPackageNode> {
    const byIri = new Map(lock.packages.map((node) => [node.canonicalIri, node]));
    const pending = root.dependencies.map((edge) => edge.canonicalIri);
    const reached = new Map<string, LockPackageNode>();
    while (pending.length > 0) {
        const canonicalIri = pending.shift();
        if (canonicalIri === undefined || reached.has(canonicalIri)) {
            continue;
        }
        const node = byIri.get(canonicalIri);
        if (node === undefined) {
            return [];
        }
        reached.set(canonicalIri, node);
        for (const edge of node.dependencies) {
            pending.push(edge.canonicalIri);
        }
    }
    return [...reached.values()].sort((left, right) => compareText(left.canonicalIri, right.canonicalIri));
}

function sameReachableGraph(
    consumerLock: LockfileV1,
    consumerNode: LockPackageNode,
    dependencyLock: LockfileV1,
): boolean {
    const expected = reachablePackages(consumerLock, consumerNode);
    return (
        expected.length === dependencyLock.packages.length &&
        expected.every((node, index) => nodeKey(node) === nodeKey(dependencyLock.packages[index] as LockPackageNode))
    );
}

function ownerValue(owner: ProjectSourceOwner) {
    return {
        role: owner.role,
        canonicalIri: owner.canonicalIri,
        ownedIriPrefixes: sortedUnique(owner.ownedIriPrefixes),
    };
}

function mergeOwners(owners: ReadonlyArray<ProjectSourceOwner>) {
    const merged = new Map<
        string,
        {
            role: ProjectSourceOwner['role'];
            canonicalIri: string;
            prefixes: Set<string>;
        }
    >();
    for (const owner of owners) {
        const key = `${owner.role}\u0000${owner.canonicalIri}`;
        const current = merged.get(key) ?? {
            role: owner.role,
            canonicalIri: owner.canonicalIri,
            prefixes: new Set<string>(),
        };
        for (const prefix of owner.ownedIriPrefixes) {
            current.prefixes.add(prefix);
        }
        merged.set(key, current);
    }
    return [...merged]
        .sort(([left], [right]) => compareText(left, right))
        .map(([, owner]) =>
            ownerValue({
                role: owner.role,
                canonicalIri: owner.canonicalIri,
                ownedIriPrefixes: [...owner.prefixes],
            }),
        );
}

interface ReasonerDiagnosticValue {
    readonly severity: 'warning' | 'error';
    readonly code: string;
    readonly message: string;
    readonly axiomIds: ReadonlyArray<string>;
    readonly locations?: ReadonlyArray<CheckReportLocation>;
}

/**
 * The diagnostics with where their axioms are written: each axiom's root statements, located in the reported
 * ontology files, reading each source with something to locate once. A diagnostic none of whose statements can be
 * located (no axioms, a blank-node statement, a source whose positions cannot be established) has no locations.
 */
function locatedDiagnostics(
    graph: AssembledOntology,
    files: ReportedFiles,
    diagnostics: ReadonlyArray<ReasonerDiagnosticValue>,
    axiomRoots: ReadonlyMap<string, ReadonlyArray<string>> | undefined,
): ReadonlyArray<ReasonerDiagnosticValue> {
    if (axiomRoots === undefined || diagnostics.every((item) => item.axiomIds.length === 0)) {
        return diagnostics;
    }
    const roots = axiomRoots;
    function keysOf(item: ReasonerDiagnosticValue): ReadonlyArray<string> {
        return item.axiomIds.flatMap((id) => roots.get(id) ?? []);
    }
    const keys = [...new Set(diagnostics.flatMap(keysOf))];
    const { location } = ontologyFileMaps(graph, files);
    const found = locateStatements(
        graph,
        keys.map((key) => ({ key })),
    );
    const byKey = new Map(keys.map((key, index) => [key, location(found[index]).location]));
    return diagnostics.map((item) => {
        const unique = new Map<string, CheckReportLocation>();
        for (const key of keysOf(item)) {
            const at = byKey.get(key);
            if (at !== undefined) {
                unique.set(`${at.file}\u0000${String(at.line)}\u0000${String(at.column)}`, at);
            }
        }
        const locations = [...unique.values()].sort(compareCheckReportLocations);
        return locations.length === 0 ? item : { ...item, locations };
    });
}

function diagnosticValues(diagnostics: ReadonlyArray<ReasonerDiagnosticValue>) {
    return uniqueByKey(
        diagnostics.map((item) => ({
            severity: item.severity,
            code: item.code,
            message: sanitizeMessage(item.message),
            axiomIds: sortedUnique(item.axiomIds),
            ...(item.locations === undefined || item.locations.length === 0
                ? {}
                : { locations: item.locations as [CheckReportLocation, ...CheckReportLocation[]] }),
        })),
        (item) => `${item.severity}\u0000${item.code}\u0000${item.message}\u0000${JSON.stringify(item.axiomIds)}`,
    );
}

function objectValue(value: ReasonedOntology['reasoning']['inferredStatements'][number]['object']): string {
    return typeof value === 'string'
        ? value
        : value.language === null
          ? `${JSON.stringify(value.lexicalForm)}^^${value.datatype}`
          : `${JSON.stringify(value.lexicalForm)}@${value.language}`;
}

function inferenceValues(graph: ReasonedOntology) {
    const contributors = new Map<
        string,
        {
            sourceIds: Set<string>;
            owners: ProjectSourceOwner[];
        }
    >();
    for (const entry of graph.provenance) {
        for (const contribution of entry.inferred) {
            const id = contribution.provenance.statementId;
            const current = contributors.get(id) ?? { sourceIds: new Set<string>(), owners: [] };
            for (const sourceId of contribution.provenance.contributingSourceIds) {
                current.sourceIds.add(sourceId);
            }
            current.owners.push(...contribution.provenance.contributingOwners);
            contributors.set(id, current);
        }
    }
    return graph.reasoning.inferredStatements
        .map((statement) => {
            const contribution = contributors.get(statement.id);
            return {
                id: statement.id,
                rule: statement.provenance.rule,
                subject: statement.subject,
                predicate: statement.predicate,
                object: objectValue(statement.object),
                premiseIds: sortedUnique(statement.provenance.premiseIds),
                contributingSourceIds: sortedUnique([...(contribution?.sourceIds ?? [])]),
                contributingOwners: mergeOwners(contribution?.owners ?? []),
                justificationDigest: statement.provenance.justificationDigest,
            };
        })
        .sort((left, right) => compareText(left.id, right.id));
}

/** The proof steps that are not RDF statements, in id order; none for an answer without them. */
function lemmaValues(graph: ReasonedOntology) {
    const lemmas = [...graph.reasoning.lemmas]
        .map((lemma) => ({
            id: lemma.id,
            rule: lemma.rule,
            premiseIds: sortedUnique(lemma.premiseIds),
            conclusion: lemma.conclusion,
            justificationDigest: lemma.justificationDigest,
        }))
        .sort((left, right) => compareText(left.id, right.id));
    const [first, ...rest] = lemmas;
    return first === undefined ? {} : { lemmas: [first, ...rest] as const };
}

function unsatisfiableValues(graph: ReasonedOntology) {
    return uniqueByKey(
        graph.reasoning.unsatisfiableClasses.map((item) => ({
            classIri: item.classIri,
            premiseIds: sortedUnique(item.premiseIds),
            contributingSourceIds: sortedUnique(item.contributingSourceIds),
            contributingOwners: mergeOwners(item.contributingOwners),
            justificationDigest: item.justificationDigest,
        })),
        (item) =>
            `${item.classIri}\u0000${item.justificationDigest}\u0000${JSON.stringify(item.premiseIds)}\u0000${JSON.stringify(item.contributingSourceIds)}\u0000${JSON.stringify(item.contributingOwners)}`,
    );
}

function logicalSourcePath(project: CheckSourceProject, locator: string, fallback: string): string {
    if (project.logicalPrefix !== null && locator.startsWith(`${project.logicalPrefix}/`)) {
        return locator;
    }
    const local = portableRelativePath(project.loaded.projectRoot, locator, fallback);
    return project.logicalPrefix === null ? local : `${project.logicalPrefix}/${local}`;
}

function sourceSelectors(projects: ReadonlyArray<CheckSourceProject>) {
    const values = projects.flatMap((project) => [
        ...project.loaded.resolvedSources.ontology.map((locator, index) => ({
            id: sourceId(project, 'ontology-selector', index),
            stage: 'ontology' as const,
            kind: ontologySelectorKind(locator),
            selector: logicalSourcePath(project, locator, `external/ontology/${String(index).padStart(4, '0')}`),
        })),
        ...project.loaded.resolvedSources.shapes.map((locator, index) => ({
            id: sourceId(project, 'shapes-selector', index),
            stage: 'shapes' as const,
            kind: selectorKind(locator, '.ttl'),
            selector: logicalSourcePath(project, locator, `external/shapes/${String(index).padStart(4, '0')}`),
        })),
        ...project.loaded.resolvedSources.competencyQuestions.map((locator, index) => ({
            id: sourceId(project, 'competency-questions-selector', index),
            stage: 'competency-questions' as const,
            kind: selectorKind(locator, '.rq'),
            selector: logicalSourcePath(
                project,
                locator,
                `external/competency-questions/${String(index).padStart(4, '0')}`,
            ),
        })),
    ]);
    return values.sort((left, right) =>
        compareText(`${stageOrder(left.stage)}${left.id}`, `${stageOrder(right.stage)}${right.id}`),
    );
}

function sourceFiles(
    projects: ReadonlyArray<CheckSourceProject>,
    graph: AssembledOntology,
    shapes: ReadonlyArray<LoadedShapeSource>,
    questions: ReadonlyArray<LoadedCompetencyQuestion>,
    identities: ReadonlyArray<OntologySourceIdentity>,
) {
    const identityById = new Map(identities.map((identity) => [identity.sourceId, identity]));
    function identityFields(sourceId: string) {
        const identity = identityById.get(sourceId);
        return identity === undefined
            ? {}
            : {
                  mediaType: identity.mediaType,
                  parser: identity.parser,
                  ...(identity.graphHash === undefined ? {} : { graphHash: identity.graphHash }),
              };
    }
    const byOwner = new Map(
        projects.map((project) => [`${project.owner.role}\u0000${project.owner.canonicalIri}`, project]),
    );
    function pathFor(owner: ProjectSourceOwner, locator: string, fallback: string): string {
        const project = byOwner.get(`${owner.role}\u0000${owner.canonicalIri}`);
        return project === undefined ? fallback : logicalSourcePath(project, locator, fallback);
    }
    return [
        ...graph.sources.map((source, index) => ({
            stage: 'ontology' as const,
            id: source.descriptor.id,
            file: pathFor(
                source.descriptor.owner,
                source.descriptor.locator,
                `external/ontology-file/${String(index).padStart(4, '0')}`,
            ),
            contentDigest: source.contentDigest,
            ...identityFields(source.descriptor.id),
        })),
        ...shapes.map((source, index) => ({
            stage: 'shapes' as const,
            id: source.id,
            file: pathFor(source.owner, source.locator, `external/shape-file/${String(index).padStart(4, '0')}`),
            contentDigest: source.contentDigest,
        })),
        ...questions.map((source, index) => ({
            stage: 'competency-questions' as const,
            id: source.id,
            file: pathFor(
                source.owner,
                source.locator,
                `external/competency-question-file/${String(index).padStart(4, '0')}`,
            ),
            contentDigest: source.contentDigest,
        })),
    ].sort((left, right) =>
        compareText(
            `${stageOrder(left.stage)}${left.file}\u0000${left.id}`,
            `${stageOrder(right.stage)}${right.file}\u0000${right.id}`,
        ),
    );
}

function citationRoots(loaded: LoadedManifestV1) {
    return Object.keys(loaded.resolvedCitationRoots)
        .sort(compareText)
        .map((name, index) => ({
            name,
            selector: portableRelativePath(
                loaded.projectRoot,
                loaded.resolvedCitationRoots[name] as string,
                `external/citation-root/${String(index).padStart(4, '0')}`,
            ),
        }));
}

/** What the report records about the ontology sources beyond their bytes: identity and the profile partition. */
interface SourceEvidence {
    readonly identities: ReadonlyArray<OntologySourceIdentity>;
    readonly partition: ProfilePartition;
}

type ReportedFiles = ReadonlyArray<Readonly<{ readonly stage: string; readonly id: string; readonly file: string }>>;

/** Reported ontology file paths by source ID and by source locator, for findings and locations. */
function ontologyFileMaps(graph: AssembledOntology, files: ReportedFiles) {
    const fileById = new Map(files.filter((item) => item.stage === 'ontology').map((item) => [item.id, item.file]));
    const fileByLocator = new Map(
        graph.sources.flatMap((source) => {
            const file = fileById.get(source.descriptor.id);
            return file === undefined ? [] : [[source.descriptor.locator, file] as const];
        }),
    );
    return {
        filesOf: (sourceIds: ReadonlyArray<string>): ReadonlyArray<string> =>
            [...new Set(sourceIds.flatMap((id) => (fileById.has(id) ? [fileById.get(id) as string] : [])))].sort(
                compareText,
            ),
        location: (found: StatementLocation | null | undefined): { readonly location?: CheckReportLocation } => {
            const file = found === null || found === undefined ? undefined : fileByLocator.get(found.locator);
            return file === undefined || found === null || found === undefined
                ? {}
                : { location: { file, line: found.line, column: found.column } };
        },
    };
}

/** The optional unreasoned section: present only when a project in report mode left statements out. */
function unreasonedValue(
    partition: ProfilePartition,
    files: ReportedFiles,
    graph: AssembledOntology,
): { readonly unreasoned?: CheckReportUnreasoned } {
    const reported = partition.findings.filter((finding) => finding.policy === 'report');
    if (reported.length === 0) {
        return {};
    }
    const { filesOf, location } = ontologyFileMaps(graph, files);
    const byConstruct = new Map<string, ProfilePartitionFinding[]>();
    for (const finding of reported) {
        const key = `${finding.group}\u0000${finding.construct}`;
        byConstruct.set(key, [...(byConstruct.get(key) ?? []), finding]);
    }
    const grouped = [...byConstruct.entries()].sort(([left], [right]) => compareText(left, right));
    // Only the examples are located, so a source is read again at most once, and only when it has examples.
    const examples = grouped.flatMap(([, findings]) => findings.slice(0, UNREASONED_EXAMPLE_LIMIT));
    const located = new Map(
        locateProfileFindings(graph, examples).map((item, index) => [examples[index] as ProfilePartitionFinding, item]),
    );
    const constructs = grouped.map(([, findings]) => {
        const first = findings[0] as ProfilePartitionFinding;
        const owlCounts = new Map<string, number>();
        for (const finding of findings) {
            if (finding.owlConstruct !== null) {
                owlCounts.set(finding.owlConstruct, (owlCounts.get(finding.owlConstruct) ?? 0) + 1);
            }
        }
        return {
            group: first.group,
            construct: first.construct,
            findingCount: findings.length,
            statementCount: findings.reduce((total, finding) => total + finding.statementKeys.length, 0),
            ...(owlCounts.size === 0
                ? {}
                : {
                      owlConstructs: [...owlCounts.entries()]
                          .sort(([left], [right]) => compareText(left, right))
                          .map(([name, findingCount]) => ({ name, findingCount })),
                  }),
            examples: findings.slice(0, UNREASONED_EXAMPLE_LIMIT).map((finding) => ({
                subject: finding.subject,
                predicate: finding.predicate,
                object: finding.object,
                ...(finding.datatype === undefined ? {} : { datatype: finding.datatype }),
                statementCount: finding.statementKeys.length,
                files: filesOf(finding.sourceIds),
                ...(finding.owlConstruct === null ? {} : { owlConstruct: finding.owlConstruct }),
                description: finding.description,
                ...location(located.get(finding)),
            })),
        };
    });
    return {
        unreasoned: {
            rules: { id: partition.rulesId, digest: `sha256:${partition.rulesSha256}` },
            note: UNREASONED_NOTE,
            findingCount: reported.length,
            statementCount: constructs.reduce((total, item) => total + item.statementCount, 0),
            constructs,
            imports: partition.imports.map((item) => ({
                ontology: item.ontology,
                iri: item.iri,
                status: item.status,
                files: filesOf(item.sourceIds),
            })),
        },
    };
}

/**
 * Undeclared predicates read as annotation properties: the optional report section, present only when there is one,
 * and its warnings, which the report's own evidence determines.
 */
function undeclaredAnnotationValue(
    partition: ProfilePartition,
    files: ReportedFiles,
    graph: AssembledOntology,
): {
    readonly section: {
        readonly undeclaredAnnotationProperties?: ReadonlyArray<CheckReportUndeclaredAnnotationProperty>;
    };
    readonly warnings: ReadonlyArray<{ readonly stage: 'reasoning'; readonly code: string; readonly message: string }>;
} {
    const properties = partition.undeclaredAnnotationProperties;
    if (properties.length === 0) {
        return { section: {}, warnings: [] };
    }
    const { filesOf, location } = ontologyFileMaps(graph, files);
    const located = locateStatements(
        graph,
        properties.map((item) => ({
            key: item.firstKey,
            ...(item.locators[0] === undefined ? {} : { preferredLocator: item.locators[0] }),
        })),
    );
    const items = properties.map((item, index): CheckReportUndeclaredAnnotationProperty => {
        const first = location(located[index]).location;
        return {
            property: item.property,
            statementCount: item.statementCount,
            files: filesOf(item.sourceIds),
            ...(first === undefined ? {} : { firstUse: first }),
        };
    });
    return {
        section: { undeclaredAnnotationProperties: items },
        warnings: items.map((item) => ({
            stage: 'reasoning' as const,
            code: UNDECLARED_ANNOTATION_PROPERTY_WARNING,
            message: undeclaredAnnotationPropertyWarning(item),
        })),
    };
}

function sourcesValue(
    loaded: LoadedManifestV1,
    projects: ReadonlyArray<CheckSourceProject>,
    graph: AssembledOntology,
    shapes: ReadonlyArray<LoadedShapeSource>,
    questions: ReadonlyArray<LoadedCompetencyQuestion>,
    identities: ReadonlyArray<OntologySourceIdentity>,
) {
    return {
        selectors: sourceSelectors(projects),
        files: sourceFiles(projects, graph, shapes, questions, identities),
        citationRoots: citationRoots(loaded),
    };
}

function duplicateDiscoveredSourceError(
    projectRoot: string,
    groups: ReadonlyArray<
        Readonly<{
            readonly stage: 'ontology' | 'shapes' | 'competency-questions';
            readonly id: string;
            readonly locator: string;
        }>
    >,
): CheckProjectOperationalError | null {
    const seen = new Map<
        string,
        {
            readonly id: string;
            readonly locator: string;
        }
    >();
    const diagnostics: CheckProjectErrorDiagnostic[] = [];
    for (const group of groups) {
        const portableIdentity = portableSlashes(resolve(projectRoot, group.locator))
            .normalize('NFC')
            .toLocaleLowerCase('en-US');
        const identity = `${group.stage}\u0000${portableIdentity}`;
        const previous = seen.get(identity);
        if (previous === undefined) {
            seen.set(identity, { id: group.id, locator: group.locator });
            continue;
        }
        const ids = [previous.id, group.id].sort(compareText);
        diagnostics.push({
            code: 'duplicate-discovered-source',
            message: `Discovered source is selected more than once by ${ids.join(' and ')}`,
            file: portableRelativePath(
                projectRoot,
                group.locator,
                `external/${group.stage}/${String(diagnostics.length).padStart(4, '0')}`,
            ),
            line: null,
            column: null,
        });
    }
    if (diagnostics.length === 0) {
        return null;
    }
    diagnostics.sort((left, right) =>
        compareText(`${left.file ?? ''}\u0000${left.message}`, `${right.file ?? ''}\u0000${right.message}`),
    );
    return new CheckProjectOperationalError(
        'CHECK_DUPLICATE_DISCOVERED_SOURCE',
        'sources',
        'Project source selectors resolve to duplicate discovered sources',
        diagnostics,
    );
}

const notRunStages = {
    core: { status: 'not-run' as const, failureCodes: [], borrowedTerms: null, propertyDomainRange: null },
    shacl: { status: 'not-run' as const, failureCodes: [], details: null },
    competencyQuestions: { status: 'not-run' as const, failureCodes: [], details: null },
    citations: { status: 'not-run' as const, failureCodes: [], details: null },
};

function warningValues(
    values: ReadonlyArray<{
        readonly stage: 'reasoning' | 'shacl' | 'competency-questions' | 'citations';
        readonly code: string;
        readonly message: string;
    }>,
) {
    return uniqueByKey(values, (item) => `${item.stage}\u0000${item.code}\u0000${item.message}`);
}

function failedReasoningReport(
    loaded: LoadedManifestV1,
    projects: ReadonlyArray<CheckSourceProject>,
    graph: AssembledOntology,
    shapes: ReadonlyArray<LoadedShapeSource>,
    questions: ReadonlyArray<LoadedCompetencyQuestion>,
    evidence: SourceEvidence,
    reasoning: {
        readonly outcome: 'decided' | 'refused' | 'incompatible';
        readonly consistency: 'consistent' | 'inconsistent' | null;
        readonly protocolVersion: ReasonedOntology['reasoning']['protocolVersion'];
        readonly requestId: string;
        readonly inputDigest: string;
        readonly profile: Readonly<{
            readonly id: string;
            readonly digest: string;
        }>;
        readonly tool: ReasonedOntology['reasoning']['tool'];
        readonly diagnostics: ReadonlyArray<{
            readonly severity: 'warning' | 'error';
            readonly code: string;
            readonly message: string;
            readonly axiomIds: ReadonlyArray<string>;
        }>;
        readonly failureCode: string;
        readonly expected?: string;
        readonly actual?: string;
        readonly inputAxiomCount?: number;
        /** The root statements each request axiom was read from, to locate the diagnostics' axioms. */
        readonly axiomRoots?: ReadonlyMap<string, ReadonlyArray<string>>;
    },
    limits: ReasonerLimits,
): CheckProjectReport {
    const sources = sourcesValue(loaded, projects, graph, shapes, questions, evidence.identities);
    const undeclared = undeclaredAnnotationValue(evidence.partition, sources.files, graph);
    const located = locatedDiagnostics(graph, sources.files, reasoning.diagnostics, reasoning.axiomRoots);
    return decodeCheckProjectReport({
        schema: CHECK_REPORT_VERSION,
        manifest: {
            schemaVersion: 1,
            file: portableManifestFile(loaded),
            canonicalIri: loaded.manifest.canonicalIri,
            alias: loaded.manifest.alias,
            title: loaded.manifest.title ?? null,
            ...(loaded.manifest.outsideProfile === 'report' ? { outsideProfile: 'report' as const } : {}),
        },
        sources,
        reasoning: {
            protocolVersion: reasoning.protocolVersion,
            outcome: reasoning.outcome,
            negativeOutcome:
                reasoning.outcome === 'refused'
                    ? { outcome: 'refused', reason: reasoning.failureCode }
                    : reasoning.outcome === 'incompatible'
                      ? {
                            outcome: 'incompatible',
                            reason: reasoning.failureCode,
                            expected: reasoning.expected as string,
                            actual: reasoning.actual as string,
                        }
                      : null,
            consistency: reasoning.consistency,
            requestId: reasoning.requestId,
            inputDigest: reasoning.inputDigest,
            profile: { ...reasoning.profile },
            tool: { ...reasoning.tool },
            diagnostics: diagnosticValues(located),
            inferred: [],
            unsatisfiableClasses: [],
            ...(reasoning.outcome === 'decided' && reasoning.consistency === 'consistent'
                ? { completeness: REASONING_COMPLETENESS }
                : {}),
            inferredStatementCount: 0,
            materializedStatementCount: 0,
            limits: limitsValue(limits),
            ...(reasoning.inputAxiomCount === undefined ? {} : { inputAxiomCount: reasoning.inputAxiomCount }),
        },
        stages: {
            sources: {
                status: 'passed',
                failureCodes: [],
                ontologyFiles: graph.sources.length,
                shapeFiles: shapes.length,
                competencyQuestionFiles: questions.length,
            },
            reasoning: { status: 'failed', failureCodes: [reasoning.failureCode] },
            ...notRunStages,
        },
        ...unreasonedValue(evidence.partition, sources.files, graph),
        ...undeclared.section,
        warnings: warningValues([
            ...reasoning.diagnostics
                .filter((item) => item.severity === 'warning')
                .map((item) => ({
                    stage: 'reasoning' as const,
                    code: item.code,
                    message: sanitizeMessage(item.message),
                })),
            ...undeclared.warnings,
        ]),
        outcome: 'failed',
    });
}

function limitsValue(limits: ReasonerLimits) {
    return {
        maxWallTimeMs: limits.maxWallTimeMs,
        maxInputAxioms: limits.maxInputAxioms,
        maxInferences: limits.maxInferences,
        maxRequestBytes: limits.maxRequestBytes,
    };
}

function constructReport(
    stage: 'reasoning' | 'validation',
    build: () => CheckProjectReport,
): Effect.Effect<CheckProjectReport, CheckProjectOperationalError> {
    return Effect.try({
        try: build,
        catch: (cause) =>
            new CheckProjectOperationalError(
                'CHECK_REPORT_CONSTRUCTION_FAILED',
                stage,
                'A deterministic check report could not be constructed from the completed operation',
                [
                    {
                        code: 'report-contract-invalid',
                        message: 'Internal check results did not satisfy the versioned report contract',
                        file: null,
                        line: null,
                        column: null,
                    },
                ],
                cause,
            ),
    });
}

/** A refused SHACL step's constructs, each with its reported shape file and, when known, its position. */
function unsupportedShaclValue(
    validation: ShaclValidation,
    files: ReportedFiles,
): { readonly unsupported?: ReadonlyArray<CheckReportUnsupportedShaclConstruct> } {
    if (validation.unsupported === undefined) {
        return {};
    }
    const fileById = new Map(files.filter((item) => item.stage === 'shapes').map((item) => [item.id, item.file]));
    const unsupported = validation.unsupported
        .map((item): CheckReportUnsupportedShaclConstruct => {
            const file = fileById.get(item.sourceId);
            if (file === undefined) {
                throw new TypeError('An unsupported SHACL construct must come from a reported shape file');
            }
            return {
                kind: item.kind,
                shape: item.shape,
                construct: item.construct,
                message: sanitizeMessage(item.message),
                sourceId: item.sourceId,
                file,
                ...(item.position === null
                    ? {}
                    : { location: { file, line: item.position.line, column: item.position.column } }),
            };
        })
        .sort(compareUnsupportedShaclConstructs);
    return { unsupported };
}

function shaclValue(validation: ShaclValidation | null, files: ReportedFiles) {
    return validation === null
        ? null
        : {
              conforms: validation.conforms,
              counts: { ...validation.counts },
              findings: validation.findings
                  .map((finding) => ({
                      focus: finding.focus,
                      path: finding.path,
                      severity: finding.severity,
                      message: sanitizeMessage(finding.message),
                      shape: finding.shape,
                      shapeSourceIds: sortedUnique(finding.shapeSourceIds),
                      shapeOwners: mergeOwners(finding.shapeOwners),
                      ...(finding.value === undefined ? {} : { value: finding.value }),
                      ...(finding.component === undefined ? {} : { component: finding.component }),
                      ...(finding.sourceShape === undefined ? {} : { sourceShape: finding.sourceShape }),
                      ...(finding.sourceConstraint === undefined ? {} : { sourceConstraint: finding.sourceConstraint }),
                  }))
                  .sort(
                      (left, right) =>
                          compareText(
                              `${left.severity}\u0000${left.focus ?? ''}\u0000${left.path ?? ''}\u0000${left.shape ?? ''}\u0000${left.message}\u0000${JSON.stringify(left.shapeSourceIds)}\u0000${JSON.stringify(left.shapeOwners)}`,
                              `${right.severity}\u0000${right.focus ?? ''}\u0000${right.path ?? ''}\u0000${right.shape ?? ''}\u0000${right.message}\u0000${JSON.stringify(right.shapeSourceIds)}\u0000${JSON.stringify(right.shapeOwners)}`,
                          ) ||
                          compareText(
                              `${left.value ?? ''}\u0000${left.component ?? ''}\u0000${left.sourceShape ?? ''}`,
                              `${right.value ?? ''}\u0000${right.component ?? ''}\u0000${right.sourceShape ?? ''}`,
                          ),
                  ),
              shapes: uniqueByKey(
                  validation.shapes.map((shape) => ({
                      ...shape,
                      sourceIds: sortedUnique(shape.sourceIds),
                      owners: mergeOwners(shape.owners),
                  })),
                  (item) =>
                      `${item.shape}\u0000${item.targetKind}\u0000${item.targetTerm ?? ''}\u0000${JSON.stringify(item.sourceIds)}\u0000${JSON.stringify(item.owners)}`,
              ),
              selfTest: uniqueByKey(
                  validation.selfTest.map((item) => ({
                      ...item,
                      reason: item.reason === null ? null : sanitizeMessage(item.reason),
                  })),
                  (item) => `${item.shape}\u0000${String(item.fired)}\u0000${item.reason ?? ''}`,
              ),
              sourceDigests: validation.sourceDigests
                  .map((item) => ({ ...item }))
                  .sort((left, right) => compareText(left.sourceId, right.sourceId)),
              ...unsupportedShaclValue(validation, files),
              ...(validation.engine === undefined ? {} : { engine: { ...validation.engine } }),
          };
}

function competencyQuestionValue(
    projects: ReadonlyArray<CheckSourceProject>,
    validation: CompetencyQuestionValidation | null,
) {
    if (validation === null) {
        return null;
    }
    const byOwner = new Map(
        projects.map((project) => [`${project.owner.role}\u0000${project.owner.canonicalIri}`, project]),
    );
    return {
        conforms: validation.conforms,
        executed: validation.executed,
        dormant: validation.dormant,
        questions: uniqueByKey(
            validation.questions.map((question, index) => ({
                id: question.id,
                owner: ownerValue(question.owner),
                file: (() => {
                    const project = byOwner.get(`${question.owner.role}\u0000${question.owner.canonicalIri}`);
                    const fallback = `external/competency-question-file/${String(index).padStart(4, '0')}`;
                    return project === undefined ? fallback : logicalSourcePath(project, question.locator, fallback);
                })(),
                execution: question.execution,
                rows: question.rows,
                ok: question.ok,
                expectedToFail: question.expectedToFail,
                closes: question.metadata.closes,
                blocking: question.blocking,
                reason: sanitizeMessage(question.reason),
                metadataDiagnostics: uniqueByKey(
                    question.metadataDiagnostics.map((item) => ({
                        code: item.code,
                        message: sanitizeMessage(item.message),
                    })),
                    (item) => `${item.code}\u0000${item.message}`,
                ),
            })),
            (item) => item.id,
        ),
    };
}

function citationValue(loaded: LoadedManifestV1, validation: CitationValidation) {
    return {
        conforms: validation.conforms,
        warnings: validation.warnings,
        citations: uniqueByKey(
            validation.citations.map((citation, citationIndex) => {
                const root =
                    loaded.resolvedCitationRoots[citation.root] ??
                    loaded.resolvedCitationRoots.default ??
                    loaded.projectRoot;
                return {
                    observation: citation.observation,
                    label: citation.label,
                    commit: citation.commit,
                    repository: citation.repository,
                    root: citation.root,
                    affectedFacts: sortedUnique(citation.affectedFacts),
                    metadataDiagnostics: uniqueByKey(
                        citation.metadataDiagnostics.map((item) => ({
                            predicate: item.predicate,
                            values: sortedUnique(item.values),
                        })),
                        (item) => `${item.predicate}\u0000${JSON.stringify(item.values)}`,
                    ),
                    files: citation.files
                        .map((file, fileIndex) => ({
                            path:
                                file.absolutePath === null
                                    ? portableLogicalPath(
                                          file.path,
                                          `external/citation-file/${String(citationIndex).padStart(4, '0')}-${String(fileIndex).padStart(4, '0')}`,
                                      )
                                    : portableRelativePath(
                                          root,
                                          file.absolutePath,
                                          `external/citation-file/${String(citationIndex).padStart(4, '0')}-${String(fileIndex).padStart(4, '0')}`,
                                      ),
                            exists: file.exists,
                            gitState: file.git?.state ?? null,
                        }))
                        .sort((left, right) =>
                            compareText(
                                `${left.path}\u0000${String(left.exists)}\u0000${left.gitState ?? ''}`,
                                `${right.path}\u0000${String(right.exists)}\u0000${right.gitState ?? ''}`,
                            ),
                        ),
                    status: citation.status,
                    blocking: citation.blocking,
                    warning: citation.warning,
                };
            }),
            (item) => item.observation,
        ),
    };
}

function completedReport(
    loaded: LoadedManifestV1,
    projects: ReadonlyArray<CheckSourceProject>,
    graph: ReasonedOntology,
    shapes: ReadonlyArray<LoadedShapeSource>,
    questions: ReadonlyArray<LoadedCompetencyQuestion>,
    validation: OntologyCheckReport,
    requestId: string,
    evidence: SourceEvidence,
    limits: ReasonerLimits,
    inputAxiomCount: number,
): CheckProjectReport {
    const coreConforms = validation.borrowedTerms.conforms && validation.propertyDomainRange.conforms;
    const sources = sourcesValue(loaded, projects, graph, shapes, questions, evidence.identities);
    const shacl = shaclValue(validation.shacl, sources.files);
    const cqs = competencyQuestionValue(projects, validation.competencyQuestions);
    const citations = citationValue(loaded, validation.citations);
    const warnings = [
        ...graph.reasoning.diagnostics
            .filter((item) => item.severity === 'warning')
            .map((item) => ({
                stage: 'reasoning' as const,
                code: item.code,
                message: sanitizeMessage(item.message),
            })),
        ...graph.reasoning.unsatisfiableClasses.map((item) => ({
            stage: 'reasoning' as const,
            code: 'unsatisfiable-class',
            message: `${item.classIri} is unsatisfiable`,
        })),
        ...(shacl?.findings ?? [])
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
        ...validation.citations.citations
            .filter((item) => item.warning)
            .map((item) => ({
                stage: 'citations' as const,
                code: item.status,
                message: `${item.observation} has citation status ${item.status}`,
            })),
        ...validation.citations.citations
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
    const outcome = validation.conforms ? ('passed' as const) : ('failed' as const);
    const undeclared = undeclaredAnnotationValue(evidence.partition, sources.files, graph);
    return decodeCheckProjectReport({
        schema: CHECK_REPORT_VERSION,
        manifest: {
            schemaVersion: 1,
            file: portableManifestFile(loaded),
            canonicalIri: loaded.manifest.canonicalIri,
            alias: loaded.manifest.alias,
            title: loaded.manifest.title ?? null,
            ...(loaded.manifest.outsideProfile === 'report' ? { outsideProfile: 'report' as const } : {}),
        },
        sources,
        reasoning: {
            protocolVersion: graph.reasoning.protocolVersion,
            outcome: 'decided',
            negativeOutcome: null,
            consistency: 'consistent',
            requestId,
            inputDigest: graph.reasoning.inputDigest,
            profile: { id: graph.reasoning.profileId, digest: graph.reasoning.profileDigest },
            tool: { ...graph.reasoning.tool },
            diagnostics: diagnosticValues(graph.reasoning.diagnostics),
            inferred: inferenceValues(graph),
            ...lemmaValues(graph),
            unsatisfiableClasses: unsatisfiableValues(graph),
            completeness: REASONING_COMPLETENESS,
            inferredStatementCount: graph.reasoning.inferredStatementCount,
            materializedStatementCount: graph.reasoning.materializedStatementCount,
            limits: limitsValue(limits),
            inputAxiomCount,
        },
        stages: {
            sources: {
                status: 'passed',
                failureCodes: [],
                ontologyFiles: graph.sources.length,
                shapeFiles: shapes.length,
                competencyQuestionFiles: questions.length,
            },
            reasoning: { status: 'passed', failureCodes: [] },
            core: {
                status: coreConforms ? 'passed' : 'failed',
                failureCodes: [
                    ...(validation.borrowedTerms.conforms ? [] : ['borrowed-terms']),
                    ...(validation.propertyDomainRange.conforms ? [] : ['property-domain-range']),
                ],
                borrowedTerms: {
                    ...validation.borrowedTerms,
                    used: sortedUnique(validation.borrowedTerms.used),
                    declared: sortedUnique(validation.borrowedTerms.declared),
                    missing: sortedUnique(validation.borrowedTerms.missing),
                },
                propertyDomainRange: {
                    ...validation.propertyDomainRange,
                    properties: sortedUnique(validation.propertyDomainRange.properties),
                    findings: uniqueByKey(
                        validation.propertyDomainRange.findings,
                        (item) => `${item.property}\u0000${item.missing}`,
                    ),
                },
            },
            shacl: {
                status: shacl === null ? 'skipped' : shacl.conforms ? 'passed' : 'failed',
                failureCodes:
                    shacl === null || shacl.conforms
                        ? []
                        : shacl.unsupported === undefined
                          ? ['shacl-conformance']
                          : [SHACL_UNSUPPORTED_CONSTRUCT_CODE],
                details: shacl,
            },
            competencyQuestions: {
                status: cqs === null ? 'skipped' : cqs.conforms ? 'passed' : 'failed',
                failureCodes: cqs === null || cqs.conforms ? [] : ['competency-question-conformance'],
                details: cqs,
            },
            citations: {
                status: citations.conforms ? 'passed' : 'failed',
                failureCodes: citations.conforms ? [] : ['citation-conformance'],
                details: citations,
            },
        },
        ...unreasonedValue(evidence.partition, sources.files, graph),
        ...undeclared.section,
        warnings: warningValues([...warnings, ...undeclared.warnings]),
        outcome,
    });
}

export interface LoadedDependencyProjects {
    readonly projects: ReadonlyArray<CheckSourceProject>;
    readonly dataSources: ReadonlyArray<ByteBackedTurtleSource>;
    readonly shapeSources: ReadonlyArray<ByteBackedShapeSource>;
    readonly competencyQuestions: ReadonlyArray<ByteBackedQuestionSource>;
}

function sameToolchain(left: LockToolchain, right: LockToolchain): boolean {
    return (
        left.validator.version === right.validator.version &&
        left.validator.sha256 === right.validator.sha256 &&
        left.reasoner.version === right.reasoner.version &&
        left.reasoner.sha256 === right.reasoner.sha256
    );
}

function dependencyFileError(cause?: unknown): CheckProjectOperationalError {
    return dependencyError(
        'CHECK_DEPENDENCY_SOURCE_INVALID',
        'An installed dependency contains an invalid or unauthenticated declared source',
        'Run erden install to replace the invalid dependency installation, then check again.',
        cause,
    );
}

function emptyDependencySelectorError(logicalPrefix: string, selector: string): CheckProjectOperationalError {
    return new CheckProjectOperationalError(
        'CHECK_DEPENDENCY_SOURCE_INVALID',
        'dependencies',
        'An installed dependency selector resolved to no authenticated package files',
        [
            Object.freeze({
                code: 'dependency-selector-empty',
                message: 'Every declared dependency selector must resolve to at least one matching package file',
                file: `${logicalPrefix}/${selector}`,
                line: null,
                column: null,
            }),
        ],
    );
}

function canonicalPackageSelector(value: string): string {
    const normalized = normalizePackagePath(value);
    if (normalized !== value) {
        throw new Error('dependency selector is not in canonical package-path form');
    }
    return normalized;
}

export function loadDependencyProjects(
    lock: LockfileV1,
    closure: ResolvedInstalledClosure,
    toolchain: LockToolchain,
    manifestService: Readonly<{
        readonly parse: (
            input: Parameters<Context.Service.Shape<typeof ManifestService>['parse']>[0],
        ) => Effect.Effect<LoadedManifestV1, unknown>;
    }>,
    reader: Readonly<{
        readonly readFile: (
            input: Parameters<InstalledClosureReaderShape['readFile']>[0],
        ) => Effect.Effect<AuthenticatedInstalledFile, unknown>;
    }>,
): Effect.Effect<LoadedDependencyProjects, CheckProjectOperationalError> {
    return Effect.gen(function* () {
        const layers = new Map<string, ResolvedInstalledLayer>(
            closure.layers.map((layer) => [layer.canonicalIri, layer]),
        );
        const projects: CheckSourceProject[] = [];
        const dataSources: ByteBackedTurtleSource[] = [];
        const shapeSources: ByteBackedShapeSource[] = [];
        const competencyQuestions: ByteBackedQuestionSource[] = [];
        for (let index = 0; index < lock.packages.length; index += 1) {
            const node = lock.packages[index];
            if (node === undefined) {
                continue;
            }
            const layer = layers.get(node.canonicalIri);
            if (layer === undefined || layer.version !== node.version || layer.archiveSha256 !== node.archiveSha256) {
                return yield* Effect.fail(
                    dependencyError(
                        'CHECK_INSTALL_INVALID',
                        'The authenticated installation does not contain the exact locked dependency layer',
                        'Run erden install to materialize the exact locked dependency closure, then check again.',
                    ),
                );
            }
            const fileByPath = new Map(layer.files.map((file) => [file.path, file]));
            const manifestPaths = layer.files
                .map((file) => file.path)
                .filter((path) => !path.includes('/') && (MANIFEST_FILENAMES as ReadonlyArray<string>).includes(path));
            if (
                manifestPaths.length !== 1 ||
                !fileByPath.has('erden.lock') ||
                !fileByPath.has(GENERATED_MANIFEST_PATH)
            ) {
                return yield* Effect.fail(
                    dependencyError(
                        'CHECK_DEPENDENCY_MANIFEST_INVALID',
                        'An installed dependency must contain exactly one root manifest and one canonical lock',
                        'Run erden install to replace the invalid dependency installation, then check again.',
                    ),
                );
            }
            const captured = new Map<string, Uint8Array>();
            const dependencyNode = node;
            function read(path: string): Effect.Effect<Uint8Array, CheckProjectOperationalError> {
                const existing = captured.get(path);
                if (existing !== undefined) {
                    return Effect.succeed(existing);
                }
                return reader.readFile({ closure, canonicalIri: dependencyNode.canonicalIri, path }).pipe(
                    Effect.mapError(dependencyFileError),
                    Effect.map((file) => {
                        const bytes = Uint8Array.from(file.bytes);
                        captured.set(path, bytes);
                        return bytes;
                    }),
                );
            }
            const manifestPath = manifestPaths[0] as string;
            const manifestBytes = yield* read(manifestPath);
            const manifestText = yield* Effect.try({
                try: () => new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
                catch: dependencyFileError,
            });
            const loaded = yield* manifestService
                .parse({
                    filePath: resolve(layer.root, manifestPath),
                    text: manifestText,
                })
                .pipe(
                    Effect.mapError((cause) =>
                        dependencyError(
                            'CHECK_DEPENDENCY_MANIFEST_INVALID',
                            'An installed dependency root manifest could not be parsed',
                            'Run erden install to replace the invalid dependency installation, then check again.',
                            cause,
                        ),
                    ),
                );
            if (relative(layer.root, loaded.projectRoot) !== '' || loaded.manifest.canonicalIri !== node.canonicalIri) {
                return yield* Effect.fail(
                    dependencyError(
                        'CHECK_DEPENDENCY_IDENTITY_MISMATCH',
                        'An installed dependency manifest does not match its locked canonical identity',
                        'Run erden install to replace the invalid dependency installation, then check again.',
                    ),
                );
            }
            const lockBytes = yield* read('erden.lock');
            const embeddedLock = yield* Effect.try({
                try: () => parseLockfile(lockBytes),
                catch: dependencyFileError,
            });
            const consistency = yield* Effect.try({
                try: () => checkLockConsistency(loaded.manifest, toolchain, embeddedLock),
                catch: dependencyFileError,
            });
            const generatedBytes = yield* read(GENERATED_MANIFEST_PATH);
            const packageManifest = yield* Effect.try({
                try: () => decodeCanonicalPackageManifest(generatedBytes),
                catch: dependencyFileError,
            });
            if (
                consistency.status !== 'consistent' ||
                embeddedLock.root.canonicalIri !== node.canonicalIri ||
                !sameToolchain(embeddedLock.toolchain, toolchain) ||
                packageManifest.canonicalIri !== node.canonicalIri ||
                packageManifest.version !== node.version ||
                !sameToolchain(packageManifest.toolchain, toolchain)
            ) {
                return yield* Effect.fail(
                    dependencyError(
                        'CHECK_DEPENDENCY_IDENTITY_MISMATCH',
                        'An installed dependency manifest, lock, package identity, or toolchain does not match the consumer lock',
                        'Run erden install to replace the invalid dependency installation, then check again.',
                    ),
                );
            }
            if (
                !sameDirectEdges(embeddedLock, node) ||
                !sameEdges(packageManifest.dependencies, node.dependencies) ||
                !sameReachableGraph(lock, node, embeddedLock)
            ) {
                return yield* Effect.fail(
                    dependencyError(
                        'CHECK_DEPENDENCY_EDGE_MISMATCH',
                        'An installed dependency package graph does not match the exact reachable graph selected by the consumer lock',
                        'Run erden install to replace the invalid dependency installation, then check again.',
                    ),
                );
            }
            const project = Object.freeze({
                loaded,
                owner: ownerFor(loaded, 'dependency'),
                idNamespace: `dependency:${String(index).padStart(4, '0')}`,
                logicalPrefix: `dependencies/${node.archiveSha256}`,
            }) satisfies CheckSourceProject;
            projects.push(project);
            const selections = [
                ...loaded.manifest.sources.ontology.map((selector, selectorIndex) => ({
                    stage: 'ontology' as const,
                    extension: '.ttl' as const,
                    selector,
                    selectorIndex,
                })),
                ...loaded.manifest.sources.shapes.map((selector, selectorIndex) => ({
                    stage: 'shapes' as const,
                    extension: '.ttl' as const,
                    selector,
                    selectorIndex,
                })),
                ...loaded.manifest.sources.competencyQuestions.map((selector, selectorIndex) => ({
                    stage: 'competency-questions' as const,
                    extension: '.rq' as const,
                    selector,
                    selectorIndex,
                })),
            ];
            for (const selection of selections) {
                const selector = yield* Effect.try({
                    try: () => canonicalPackageSelector(selection.selector),
                    catch: dependencyFileError,
                });
                const fileSelection =
                    selection.stage === 'ontology'
                        ? isOntologyFileSelector(selector)
                        : posix.extname(selector).toLowerCase() === selection.extension;
                const selected = fileSelection
                    ? fileByPath.has(selector)
                        ? [selector]
                        : []
                    : layer.files
                          .map((file) => file.path)
                          .filter(
                              (path) =>
                                  posix.dirname(path) === selector &&
                                  posix.extname(path).toLowerCase() === selection.extension,
                          )
                          .sort(compareText);
                if (selected.length === 0) {
                    return yield* Effect.fail(emptyDependencySelectorError(project.logicalPrefix, selector));
                }
                for (const path of selected) {
                    const logicalLocator = `${project.logicalPrefix}/${path}`;
                    const idPrefix = sourceId(project, selection.stage, selection.selectorIndex);
                    const id = fileSelection ? idPrefix : `${idPrefix}:${posix.basename(path)}`;
                    const bytes = yield* read(path);
                    if (selection.stage === 'ontology') {
                        dataSources.push(
                            Object.freeze({
                                descriptor: Object.freeze({
                                    id,
                                    owner: project.owner,
                                    locator: logicalLocator,
                                    baseIri: project.owner.canonicalIri,
                                    mediaType: ontologySourceDescriptorMediaType(path),
                                    provenance: Object.freeze({ _tag: 'Asserted' as const }),
                                    ...outsideProfileSourceField(project.loaded.manifest),
                                }),
                                bytes,
                            }),
                        );
                    } else if (selection.stage === 'shapes') {
                        shapeSources.push(
                            Object.freeze({
                                descriptor: Object.freeze({
                                    id,
                                    owner: project.owner,
                                    locator: logicalLocator,
                                    baseIri: project.owner.canonicalIri,
                                    mediaType: 'text/turtle' as const,
                                }),
                                bytes,
                            }),
                        );
                    } else {
                        competencyQuestions.push(
                            Object.freeze({
                                descriptor: Object.freeze({
                                    idPrefix: id,
                                    owner: project.owner,
                                    selector: Object.freeze({ kind: 'file' as const, locator: logicalLocator }),
                                }),
                                bytes,
                            }),
                        );
                    }
                }
            }
        }
        return Object.freeze({
            projects: Object.freeze(projects),
            dataSources: Object.freeze(dataSources),
            shapeSources: Object.freeze(shapeSources),
            competencyQuestions: Object.freeze(competencyQuestions),
        });
    });
}

export interface CheckProjectSemanticKernelInput {
    readonly loaded: LoadedManifestV1;
    readonly projects: ReadonlyArray<CheckSourceProject>;
    readonly dataSources: ReadonlyArray<ByteBackedTurtleSource>;
    readonly shapeSources: ReadonlyArray<LoadedShapeSource>;
    readonly competencyQuestions: ReadonlyArray<LoadedCompetencyQuestion>;
    readonly ontologyService: Context.Service.Shape<typeof OntologyService>;
    readonly reasonerService: Context.Service.Shape<typeof ReasonerService>;
    /** The one limits value this check runs with; it reaches the reasoner and the report unchanged. */
    readonly limits: ReasonerLimits;
    /** The toolchain the project's locks were checked against; the reasoner must be the one it names. */
    readonly toolchain: LockToolchain;
    /** Phase timing for measurement; absent, nothing is timed. */
    readonly timer?: CheckPhaseTimer;
}

/** Shared semantic kernel used after an adapter has captured and authenticated exact source bytes. */
export function runCheckProjectSemanticKernel(
    {
        loaded,
        projects,
        dataSources,
        shapeSources,
        competencyQuestions,
        ontologyService,
        reasonerService,
        limits,
        toolchain,
        timer,
    }: CheckProjectSemanticKernelInput,
    capture?: (
        graph: ReasonedOntology,
        validation: OntologyCheckReport,
        report: CheckProjectReport,
    ) => Effect.Effect<void, CheckProjectError>,
): Effect.Effect<CheckProjectReport, CheckProjectError> {
    return Effect.gen(function* () {
        const duplicateSources = duplicateDiscoveredSourceError(loaded.projectRoot, [
            ...dataSources.map((source) => ({
                stage: 'ontology' as const,
                id: source.descriptor.id,
                locator: source.descriptor.locator,
            })),
            ...shapeSources.map((source) => ({ stage: 'shapes' as const, id: source.id, locator: source.locator })),
            ...competencyQuestions.map((source) => ({
                stage: 'competency-questions' as const,
                id: source.id,
                locator: source.locator,
            })),
        ]);
        if (duplicateSources !== null) {
            return yield* Effect.fail(duplicateSources);
        }
        const graph = yield* ontologyService
            .assembleByteBacked(dataSources)
            .pipe(Effect.mapError((cause) => ontologyError(cause, 'sources', loaded.projectRoot)));
        const identities = yield* identifyOntologySources(graph);
        timer?.mark('parse');
        // One step decides and materializes, so nothing the decision made is validated, digested or checked twice.
        const reasoned = yield* Effect.matchEffect(
            reasonerService.decideAndMaterialize(graph, {
                limits,
                lockedReasoner: {
                    version: toolchain.reasoner.version,
                    calculusDigest: `sha256:${toolchain.reasoner.sha256}`,
                },
                ...(timer === undefined ? {} : { timer }),
            }),
            {
                onFailure: (cause) =>
                    cause instanceof TrustedNegativeReasonerOutcomeError
                        ? Effect.succeed({ _tag: 'Negative' as const, cause })
                        : Effect.fail(ontologyError(cause, 'reasoning', loaded.projectRoot)),
                onSuccess: ({ decision, reasoned: materialized }) =>
                    Effect.succeed({ _tag: 'Decision' as const, decision, materialized }),
            },
        );
        // The reasoner refused or answered: either way normalization applied this partition and accepted it.
        const evidence: SourceEvidence = {
            identities,
            partition:
                reasoned._tag === 'Decision'
                    ? reasoned.decision.normalization.partition
                    : (reasoned.cause.context.partition ?? partitionForBundledReasoner(graph)),
        };
        if (reasoned._tag === 'Negative') {
            const context = reasoned.cause.context;
            return yield* constructReport('reasoning', () =>
                failedReasoningReport(
                    loaded,
                    projects,
                    graph,
                    shapeSources,
                    competencyQuestions,
                    evidence,
                    {
                        outcome: context.outcome,
                        consistency: null,
                        protocolVersion: context.protocolVersion,
                        requestId: context.requestId,
                        inputDigest: context.inputDigest,
                        profile: context.profile,
                        tool: context.tool,
                        diagnostics: context.diagnostics,
                        failureCode: context.reason,
                        ...(context.outcome === 'incompatible'
                            ? { expected: context.expected, actual: context.actual }
                            : {}),
                        ...(context.inputAxiomCount === undefined ? {} : { inputAxiomCount: context.inputAxiomCount }),
                        ...(context.axiomRoots === undefined ? {} : { axiomRoots: context.axiomRoots }),
                    },
                    limits,
                ),
            );
        }
        const decision = reasoned.decision;
        if (decision.response.result.consistency === 'inconsistent') {
            return yield* constructReport('reasoning', () =>
                failedReasoningReport(
                    loaded,
                    projects,
                    graph,
                    shapeSources,
                    competencyQuestions,
                    evidence,
                    {
                        outcome: 'decided',
                        consistency: 'inconsistent',
                        protocolVersion: decision.response.protocolVersion,
                        requestId: decision.normalization.request.requestId,
                        inputDigest: decision.response.inputDigest,
                        profile: decision.response.profile,
                        tool: decision.response.tool,
                        diagnostics: decision.response.result.diagnostics,
                        failureCode: 'global-inconsistency',
                        inputAxiomCount: decision.normalization.request.ontology.axioms.length,
                        axiomRoots: decision.normalization.axiomRoots,
                    },
                    limits,
                ),
            );
        }
        if (decision.response.result.diagnostics.some((item) => item.severity === 'error')) {
            return yield* constructReport('reasoning', () =>
                failedReasoningReport(
                    loaded,
                    projects,
                    graph,
                    shapeSources,
                    competencyQuestions,
                    evidence,
                    {
                        outcome: 'decided',
                        consistency: 'consistent',
                        protocolVersion: decision.response.protocolVersion,
                        requestId: decision.normalization.request.requestId,
                        inputDigest: decision.response.inputDigest,
                        profile: decision.response.profile,
                        tool: decision.response.tool,
                        diagnostics: decision.response.result.diagnostics,
                        failureCode: 'reasoner-error-diagnostic',
                        inputAxiomCount: decision.normalization.request.ontology.axioms.length,
                        axiomRoots: decision.normalization.axiomRoots,
                    },
                    limits,
                ),
            );
        }
        const materialized = reasoned.materialized;
        if (materialized === null) {
            // decideAndMaterialize materializes every consistent answer without an error diagnostic.
            return yield* Effect.die(
                new TypeError('A consistent decision without error diagnostics was not materialized'),
            );
        }
        const validation = yield* ontologyService
            .validateAssembled(materialized, {
                shapeSources,
                competencyQuestions,
                shacl: { required: shapeSources.length > 0 },
                cq: { required: loaded.manifest.sources.competencyQuestions.length > 0 },
                citationRoots: loaded.resolvedCitationRoots,
                citationObservationOwners: 'root',
                ...(capture === undefined ? {} : { captureShaclEvidence: true, captureValidationPolicy: true }),
            })
            .pipe(Effect.mapError((cause) => ontologyError(cause, 'validation', loaded.projectRoot)));
        timer?.mark('validate');
        const report = yield* constructReport('validation', () =>
            completedReport(
                loaded,
                projects,
                materialized,
                shapeSources,
                competencyQuestions,
                validation,
                decision.normalization.request.requestId,
                evidence,
                limits,
                decision.normalization.request.ontology.axioms.length,
            ),
        );
        timer?.mark('report');
        if (report.outcome === 'passed' && capture !== undefined) {
            yield* capture(materialized, validation, report);
        }
        return report;
    });
}

function runCheckProject(
    options: CheckProjectOptions,
    manifestService: Context.Service.Shape<typeof ManifestService>,
    ontologyService: Context.Service.Shape<typeof OntologyService>,
    reasonerService: Context.Service.Shape<typeof ReasonerService>,
    projectStateService: Pick<ProjectDependencyStateServiceShape, 'inspect' | 'recheck'>,
    currentToolchainService: Context.Service.Shape<typeof CurrentToolchain>,
    installedClosureReader: InstalledClosureReaderShape,
): Effect.Effect<CheckProjectReport, CheckProjectError> {
    return Effect.gen(function* () {
        // CheckProject is read-only and has no registry/network capability; offline cannot affect report bytes.
        void options.offline;
        const toolchain = yield* currentToolchainService.inspect().pipe(Effect.mapError(currentToolchainError));
        const state = yield* projectStateService
            .inspect({
                ...(options.from === undefined ? {} : { from: options.from }),
                ...(options.manifestPath === undefined ? {} : { explicitPath: options.manifestPath }),
                toolchain,
            })
            .pipe(Effect.mapError(projectLockError));
        const loaded = state.project;
        const body = Effect.gen(function* () {
            const lock = yield* requireAvailableLock(state.lockInspection, 'root', toolchain);
            let dependencyProjects: LoadedDependencyProjects = Object.freeze({
                projects: Object.freeze([]),
                dataSources: Object.freeze([]),
                shapeSources: Object.freeze([]),
                competencyQuestions: Object.freeze([]),
            });
            if (lock.packages.length > 0) {
                const closure = yield* installedClosureReader
                    .resolve({
                        projectRoot: loaded.projectRoot,
                        lock,
                    })
                    .pipe(Effect.mapError(installError));
                dependencyProjects = yield* loadDependencyProjects(
                    lock,
                    closure,
                    toolchain,
                    manifestService,
                    installedClosureReader,
                );
            }
            const rootProject = Object.freeze({
                loaded,
                owner: ownerFor(loaded),
                idNamespace: 'root',
                logicalPrefix: null,
            }) satisfies CheckSourceProject;
            const projects = Object.freeze([rootProject, ...dependencyProjects.projects]);
            const locations = sourceLocationsForProject(rootProject);
            const rootDataDescriptors = yield* ontologyService
                .discoverDataSources(locations.ontology, true)
                .pipe(Effect.mapError((cause) => ontologyError(cause, 'sources', loaded.projectRoot)));
            const rootDataSources = yield* ontologyService
                .captureDataSources(rootDataDescriptors)
                .pipe(Effect.mapError((cause) => ontologyError(cause, 'sources', loaded.projectRoot)));
            const rootShapeSources = yield* ontologyService
                .discoverShapeSources(locations.shapes, locations.shapes.length > 0)
                .pipe(Effect.mapError((cause) => ontologyError(cause, 'sources', loaded.projectRoot)));
            const dependencyShapeSources = yield* ontologyService
                .loadByteBackedShapes(dependencyProjects.shapeSources)
                .pipe(Effect.mapError((cause) => ontologyError(cause, 'sources', loaded.projectRoot)));
            const shapeSources = Object.freeze([...rootShapeSources, ...dependencyShapeSources]);
            const rootCompetencyQuestions = yield* ontologyService
                .discoverCompetencyQuestions(locations.competencyQuestions, locations.competencyQuestions.length > 0)
                .pipe(Effect.mapError((cause) => ontologyError(cause, 'sources', loaded.projectRoot)));
            const dependencyCompetencyQuestions = yield* ontologyService
                .loadByteBackedQuestions(dependencyProjects.competencyQuestions)
                .pipe(Effect.mapError((cause) => ontologyError(cause, 'sources', loaded.projectRoot)));
            const competencyQuestions = Object.freeze([...rootCompetencyQuestions, ...dependencyCompetencyQuestions]);
            options.timer?.mark('load');
            return yield* runCheckProjectSemanticKernel({
                loaded,
                projects,
                dataSources: Object.freeze([...rootDataSources, ...dependencyProjects.dataSources]),
                shapeSources,
                competencyQuestions,
                ontologyService,
                reasonerService,
                limits: options.reasonerLimits ?? DEFAULT_REASONER_LIMITS,
                toolchain,
                ...(options.timer === undefined ? {} : { timer: options.timer }),
            });
        });
        return yield* Effect.matchEffect(body, {
            onFailure: (failure) =>
                projectStateService.recheck({ revision: state.revision }).pipe(
                    Effect.mapError(projectLockError),
                    Effect.flatMap(() => Effect.fail(failure)),
                ),
            onSuccess: (report) =>
                projectStateService
                    .recheck({ revision: state.revision })
                    .pipe(Effect.mapError(projectLockError), Effect.as(report)),
        });
    });
}

export function checkProject(
    options: CheckProjectOptions = {},
): Effect.Effect<
    CheckProjectReport,
    CheckProjectError,
    | Context.Service.Identifier<typeof ManifestService>
    | Context.Service.Identifier<typeof OntologyService>
    | Context.Service.Identifier<typeof ReasonerService>
    | Context.Service.Identifier<typeof ProjectDependencyStateService>
    | Context.Service.Identifier<typeof CurrentToolchain>
    | Context.Service.Identifier<typeof InstalledClosureReader>
> {
    return Effect.gen(function* () {
        const manifest = yield* Effect.service(ManifestService);
        const ontology = yield* Effect.service(OntologyService);
        const reasoner = yield* Effect.service(ReasonerService);
        const projectState = yield* Effect.service(ProjectDependencyStateService);
        const currentToolchain = yield* Effect.service(CurrentToolchain);
        const installedClosureReader = yield* Effect.service(InstalledClosureReader);
        return yield* runCheckProject(
            options,
            manifest,
            ontology,
            reasoner,
            projectState,
            currentToolchain,
            installedClosureReader,
        );
    });
}

export function defineCheckProjectOperation(
    options: CheckProjectOptions = {},
): ApplicationOperation<
    'CheckProject',
    CheckProjectReport,
    CheckProjectError,
    | Context.Service.Identifier<typeof ManifestService>
    | Context.Service.Identifier<typeof OntologyService>
    | Context.Service.Identifier<typeof ReasonerService>
    | Context.Service.Identifier<typeof ProjectDependencyStateService>
    | Context.Service.Identifier<typeof CurrentToolchain>
    | Context.Service.Identifier<typeof InstalledClosureReader>
> {
    return Object.freeze({ name: 'CheckProject', effect: checkProject(options) });
}

export interface CheckProjectServiceShape {
    readonly check: (options?: CheckProjectOptions) => Effect.Effect<CheckProjectReport, CheckProjectError>;
}

export const CheckProjectService = Context.Service<CheckProjectServiceShape>('@erden/project/CheckProjectService');

export function makeCheckProjectService(
    manifest: Context.Service.Shape<typeof ManifestService>,
    ontology: Context.Service.Shape<typeof OntologyService>,
    reasoner: Context.Service.Shape<typeof ReasonerService>,
    projectState: Pick<ProjectDependencyStateServiceShape, 'inspect' | 'recheck'> = nodeProjectDependencyStateService,
    currentToolchain: Context.Service.Shape<typeof CurrentToolchain> = nodeCurrentToolchainService,
    installedClosureReader: InstalledClosureReaderShape = nodeInstalledClosureReader,
): CheckProjectServiceShape {
    return Object.freeze({
        check: (options = {}) =>
            runCheckProject(
                options,
                manifest,
                ontology,
                reasoner,
                projectState,
                currentToolchain,
                installedClosureReader,
            ),
    });
}

export const nodeCheckProjectService = makeCheckProjectService(
    makeManifestService(),
    makeOntologyService(makeNodeOntologyPorts()),
    nodeReasonerService,
    nodeProjectDependencyStateService,
    nodeCurrentToolchainService,
    nodeInstalledClosureReader,
);
