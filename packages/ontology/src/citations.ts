import { isAbsolute, relative, resolve, win32 } from 'node:path';

import { Effect } from 'effect';
import { DataFactory, type Store } from 'n3';

import { CitationMetadataAmbiguityError, type ResourceAccessError } from './errors.js';
import {
    DEFAULT_CITATION_VOCABULARY,
    type CitationFileResult,
    type CitationResult,
    type CitationStatus,
    type CitationValidation,
    type CitationVocabulary,
} from './model.js';
import { compareCodePoints } from './order.js';
import type { CitationFilePort, GitPort } from './ports.js';

function namedNode(value: string) {
    return DataFactory.namedNode(value);
}

function singularValue(dataset: Store, subject: string, predicate: string): string | null {
    const found = [
        ...new Set(
            dataset.getQuads(namedNode(subject), namedNode(predicate), null, null).map((quad) => quad.object.value),
        ),
    ].sort(compareCodePoints);
    if (found.length > 1) {
        throw new CitationMetadataAmbiguityError(subject, predicate, found);
    }
    return found[0] ?? null;
}

function values(dataset: Store, subject: string, predicate: string): ReadonlyArray<string> {
    return dataset
        .getQuads(namedNode(subject), namedNode(predicate), null, null)
        .map((quad) => quad.object.value)
        .sort(compareCodePoints);
}

const STATUS_PRIORITY: ReadonlyArray<CitationStatus> = [
    'ambiguous-metadata',
    'unsafe-source-path',
    'missing-source-path',
    'commit-not-in-repo',
    'changed-since',
    'uncommitted-edit',
    'not-in-git',
    'no-commit-cited',
    'git-unavailable',
    'no-source-root',
    'unchanged',
    'ok',
];

function resultStatus(
    noSourceRoot: boolean,
    files: ReadonlyArray<CitationFileResult>,
    unsafeSourcePath: boolean,
): CitationStatus {
    if (unsafeSourcePath) {
        return 'unsafe-source-path';
    }
    if (files.some((file) => file.exists === false)) {
        return 'missing-source-path';
    }
    const states = new Set<CitationStatus>(files.flatMap((file) => (file.git === null ? [] : [file.git.state])));
    if (noSourceRoot) {
        states.add('no-source-root');
    }
    return STATUS_PRIORITY.find((status) => states.has(status)) ?? 'ok';
}

function isPortableRelativeSourcePath(value: string): boolean {
    return (
        value.length > 0 &&
        value.isWellFormed() &&
        !isAbsolute(value) &&
        !win32.isAbsolute(value) &&
        !/^[A-Za-z]:/u.test(value) &&
        !/[\\\u0000-\u001f\u007f-\u009f]/u.test(value) &&
        value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    );
}

function isContainedBy(root: string, candidate: string): boolean {
    const fromRoot = relative(resolve(root), candidate);
    return (
        fromRoot.length > 0 &&
        !isAbsolute(fromRoot) &&
        !win32.isAbsolute(fromRoot) &&
        fromRoot !== '..' &&
        !fromRoot.startsWith(`..\\`) &&
        !fromRoot.startsWith('../')
    );
}

export interface CitationValidationInput {
    readonly dataset: Store;
    readonly roots: Readonly<Record<string, string>>;
    readonly vocabulary?: CitationVocabulary;
    readonly observations?: ReadonlyArray<string>;
}

export type CitationValidationError = ResourceAccessError;

export function validateCitations(
    files: CitationFilePort,
    git: GitPort | undefined,
    input: CitationValidationInput,
): Effect.Effect<CitationValidation, CitationValidationError> {
    return Effect.gen(function* () {
        const vocabulary = input.vocabulary ?? DEFAULT_CITATION_VOCABULARY;
        const observations =
            input.observations === undefined
                ? [
                      ...new Set(
                          input.dataset
                              .getQuads(null, namedNode(vocabulary.sourcePath), null, null)
                              .map((quad) => quad.subject.value),
                      ),
                  ].sort(compareCodePoints)
                : [...new Set(input.observations)].sort(compareCodePoints);
        const citations: CitationResult[] = [];
        for (const observation of observations) {
            const metadataDiagnostics: Array<{
                predicate: string;
                values: ReadonlyArray<string>;
            }> = [];
            function singular(subject: string, predicate: string): string | null {
                try {
                    return singularValue(input.dataset, subject, predicate);
                } catch (cause) {
                    if (!(cause instanceof CitationMetadataAmbiguityError)) {
                        throw cause;
                    }
                    metadataDiagnostics.push({ predicate: cause.predicate, values: cause.values });
                    return null;
                }
            }
            const commit = singular(observation, vocabulary.atCommit);
            const repository = singular(observation, vocabulary.inRepository);
            const rootName = singular(observation, vocabulary.sourceRoot) ?? 'default';
            const label = singular(observation, vocabulary.label);
            const root = input.roots[rootName] ?? input.roots.default;
            const sourcePaths = values(input.dataset, observation, vocabulary.sourcePath);
            const affectedFactIds = input.dataset
                .getQuads(null, namedNode(vocabulary.wasGeneratedBy), namedNode(observation), null)
                .map((quad) => quad.subject.value);
            const affectedFacts: string[] = [];
            for (const fact of affectedFactIds) {
                affectedFacts.push(singular(fact, vocabulary.label) ?? fact);
            }
            affectedFacts.sort(compareCodePoints);
            metadataDiagnostics.sort((left, right) =>
                compareCodePoints(
                    `${left.predicate}\u0000${JSON.stringify(left.values)}`,
                    `${right.predicate}\u0000${JSON.stringify(right.values)}`,
                ),
            );
            const fileResults: CitationFileResult[] = [];
            const unsafeSourcePath = sourcePaths.some(
                (sourcePath) =>
                    !isPortableRelativeSourcePath(sourcePath) ||
                    (root !== undefined && !isContainedBy(root, resolve(root, sourcePath))),
            );
            if (metadataDiagnostics.length > 0 || unsafeSourcePath) {
                for (const sourcePath of sourcePaths) {
                    fileResults.push({ path: sourcePath, absolutePath: null, exists: null, git: null });
                }
                const status = metadataDiagnostics.length > 0 ? 'ambiguous-metadata' : 'unsafe-source-path';
                citations.push({
                    observation,
                    label,
                    commit,
                    repository,
                    root: rootName,
                    affectedFacts,
                    metadataDiagnostics,
                    files: fileResults,
                    status,
                    blocking: true,
                    warning: false,
                });
                continue;
            }
            for (const sourcePath of sourcePaths) {
                if (root === undefined) {
                    fileResults.push({ path: sourcePath, absolutePath: null, exists: null, git: null });
                    continue;
                }
                const absolutePath = resolve(root, sourcePath);
                const exists = yield* files.exists(absolutePath);
                if (!exists) {
                    fileResults.push({ path: sourcePath, absolutePath, exists: false, git: null });
                    continue;
                }
                const gitInspection =
                    git === undefined
                        ? { state: 'git-unavailable' as const }
                        : yield* git.inspect({ absolutePath, commit });
                fileResults.push({ path: sourcePath, absolutePath, exists: true, git: gitInspection });
            }
            const status = resultStatus(root === undefined, fileResults, false);
            citations.push({
                observation,
                label,
                commit,
                repository,
                root: rootName,
                affectedFacts,
                metadataDiagnostics,
                files: fileResults,
                status,
                blocking:
                    status === 'unsafe-source-path' ||
                    status === 'missing-source-path' ||
                    status === 'commit-not-in-repo',
                warning: status === 'changed-since' || status === 'uncommitted-edit',
            });
        }
        return {
            conforms: citations.every((citation) => !citation.blocking),
            citations,
            warnings: citations.filter((citation) => citation.warning).length,
        };
    });
}
