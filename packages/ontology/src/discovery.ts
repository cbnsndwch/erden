import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { TextDecoder } from 'node:util';

import { Effect } from 'effect';
import { DataFactory, Parser } from 'n3';

import { RequiredStageUnavailableError, TurtleSourceParseError, UnsupportedSemanticFormatError } from './errors.js';
import type {
    LoadedCompetencyQuestion,
    LoadedShapeSource,
    QuestionSourceLocationDescriptor,
    RequiredStage,
    ResourceSelector,
    ShapeSourceLocationDescriptor,
    TurtleSourceDescriptor,
    TurtleSourceLocationDescriptor,
} from './model.js';
import { compareCodePoints, portableLocator } from './order.js';
import type { TextResourcePort } from './ports.js';
import { parseCompetencyQuestionMetadata } from './questions.js';
import {
    isOntologyDirectoryMember,
    ONTOLOGY_DIRECTORY_EXTENSION,
    ONTOLOGY_SOURCE_EXTENSIONS,
    ontologyMediaTypeForLocator,
} from './source-formats/formats.js';

interface SelectorExtensions {
    /** Extensions a file selector may name; the first is the one named in errors for single-format stages. */
    readonly file: ReadonlyArray<string>;
    readonly directory: (locator: string) => boolean;
    readonly directoryExtension: string;
}

function singleExtension(extension: '.ttl' | '.rq'): SelectorExtensions {
    return {
        file: [extension],
        directory: (locator) => locator.toLowerCase().endsWith(extension),
        directoryExtension: extension,
    };
}

const ONTOLOGY_SELECTOR_EXTENSIONS: SelectorExtensions = Object.freeze({
    file: ONTOLOGY_SOURCE_EXTENSIONS,
    directory: isOntologyDirectoryMember,
    directoryExtension: ONTOLOGY_DIRECTORY_EXTENSION,
});

function resourcesForSelector(
    resources: TextResourcePort,
    stage: RequiredStage,
    selector: ResourceSelector,
    extensions: SelectorExtensions,
): Effect.Effect<ReadonlyArray<string>, RequiredStageUnavailableError | UnsupportedSemanticFormatError> {
    return Effect.gen(function* () {
        if (selector.kind === 'file') {
            const lower = selector.locator.toLowerCase();
            if (!extensions.file.some((extension) => lower.endsWith(extension))) {
                return yield* Effect.fail(
                    new UnsupportedSemanticFormatError(
                        stage,
                        selector.locator,
                        extensions.file.length === 1 ? (extensions.file[0] ?? '') : extensions.file,
                    ),
                );
            }
            return [selector.locator];
        }
        const listed = yield* resources
            .listFiles(selector.locator)
            .pipe(Effect.mapError((cause) => new RequiredStageUnavailableError(stage, selector.locator, cause)));
        const matched = listed
            .filter(extensions.directory)
            .sort((left, right) => compareCodePoints(portableLocator(left), portableLocator(right)));
        if (matched.length === 0) {
            return yield* Effect.fail(
                new RequiredStageUnavailableError(
                    stage,
                    selector.locator,
                    `the declared directory selector contains no ${extensions.directoryExtension} resources`,
                ),
            );
        }
        return matched;
    });
}

function requireLocations(
    stage: RequiredStage,
    required: boolean,
    locations: ReadonlyArray<unknown>,
): Effect.Effect<void, RequiredStageUnavailableError> {
    return required && locations.length === 0
        ? Effect.fail(new RequiredStageUnavailableError(stage, null, 'no source locations were supplied'))
        : Effect.void;
}

export function discoverTurtleSources(
    resources: TextResourcePort,
    locations: ReadonlyArray<TurtleSourceLocationDescriptor>,
    required = true,
): Effect.Effect<
    ReadonlyArray<TurtleSourceDescriptor>,
    RequiredStageUnavailableError | UnsupportedSemanticFormatError
> {
    return Effect.gen(function* () {
        yield* requireLocations('source', required, locations);
        const discovered: TurtleSourceDescriptor[] = [];
        for (const location of locations) {
            const locators = yield* resourcesForSelector(
                resources,
                'source',
                location.selector,
                ONTOLOGY_SELECTOR_EXTENSIONS,
            );
            for (const locator of locators) {
                const mediaType = ontologyMediaTypeForLocator(locator);
                if (mediaType === undefined) {
                    return yield* Effect.fail(
                        new UnsupportedSemanticFormatError('source', locator, ONTOLOGY_SOURCE_EXTENSIONS),
                    );
                }
                discovered.push(
                    Object.freeze({
                        id:
                            location.selector.kind === 'file'
                                ? location.idPrefix
                                : `${location.idPrefix}:${portableLocator(basename(locator))}`,
                        owner: location.owner,
                        locator,
                        baseIri: location.baseIri,
                        mediaType,
                        provenance: location.provenance,
                        ...(location.outsideProfile === 'report' ? { outsideProfile: 'report' as const } : {}),
                    }),
                );
            }
        }
        if (required && discovered.length === 0) {
            return yield* Effect.fail(
                new RequiredStageUnavailableError('source', null, 'no Turtle files were discovered'),
            );
        }
        return discovered;
    });
}

export function discoverShapeSources(
    resources: TextResourcePort,
    locations: ReadonlyArray<ShapeSourceLocationDescriptor>,
    required: boolean,
): Effect.Effect<
    ReadonlyArray<LoadedShapeSource>,
    RequiredStageUnavailableError | TurtleSourceParseError | UnsupportedSemanticFormatError
> {
    return Effect.gen(function* () {
        yield* requireLocations('shacl', required, locations);
        const discovered: LoadedShapeSource[] = [];
        for (const location of locations) {
            const locators = yield* resourcesForSelector(
                resources,
                'shacl',
                location.selector,
                singleExtension('.ttl'),
            );
            for (const locator of locators) {
                const id =
                    location.selector.kind === 'file'
                        ? location.idPrefix
                        : `${location.idPrefix}:${portableLocator(basename(locator))}`;
                const bytes = yield* resources
                    .readBytes(locator)
                    .pipe(Effect.mapError((cause) => new RequiredStageUnavailableError('shacl', locator, cause)));
                let text: string;
                try {
                    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                } catch {
                    return yield* Effect.fail(
                        new RequiredStageUnavailableError('shacl', locator, 'the SHACL source is not valid UTF-8'),
                    );
                }
                try {
                    new Parser({
                        baseIRI: location.baseIri,
                        blankNodePrefix: `erden_shape_preflight_${String(discovered.length).padStart(8, '0')}_`,
                        format: 'text/turtle',
                        factory: DataFactory,
                    }).parse(text);
                } catch (cause) {
                    const context =
                        cause !== null && typeof cause === 'object' && 'context' in cause
                            ? (
                                  cause as {
                                      readonly context?: {
                                          readonly line?: unknown;
                                          readonly token?: {
                                              readonly start?: unknown;
                                          };
                                      };
                                  }
                              ).context
                            : undefined;
                    return yield* Effect.fail(
                        new TurtleSourceParseError(
                            id,
                            {
                                file: locator,
                                line: typeof context?.line === 'number' ? context.line : 1,
                                column: (typeof context?.token?.start === 'number' ? context.token.start : 0) + 1,
                            },
                            cause,
                        ),
                    );
                }
                discovered.push(
                    Object.freeze({
                        id,
                        owner: location.owner,
                        locator,
                        baseIri: location.baseIri,
                        mediaType: location.mediaType,
                        contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                        bytes: Uint8Array.from(bytes),
                        text,
                    }),
                );
            }
        }
        if (required && discovered.length === 0) {
            return yield* Effect.fail(
                new RequiredStageUnavailableError('shacl', null, 'no Turtle shape files were discovered'),
            );
        }
        return discovered;
    });
}

export function discoverCompetencyQuestions(
    resources: TextResourcePort,
    locations: ReadonlyArray<QuestionSourceLocationDescriptor>,
    required: boolean,
): Effect.Effect<
    ReadonlyArray<LoadedCompetencyQuestion>,
    RequiredStageUnavailableError | UnsupportedSemanticFormatError
> {
    return Effect.gen(function* () {
        yield* requireLocations('competency-questions', required, locations);
        const discovered: LoadedCompetencyQuestion[] = [];
        for (const location of locations) {
            const locators = yield* resourcesForSelector(
                resources,
                'competency-questions',
                location.selector,
                singleExtension('.rq'),
            );
            for (const locator of locators) {
                const sourceBytes = yield* resources
                    .readBytes(locator)
                    .pipe(
                        Effect.mapError(
                            (cause) => new RequiredStageUnavailableError('competency-questions', locator, cause),
                        ),
                    );
                let sourceText: string;
                try {
                    sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
                } catch {
                    return yield* Effect.fail(
                        new RequiredStageUnavailableError(
                            'competency-questions',
                            locator,
                            'the competency-question source is not valid UTF-8',
                        ),
                    );
                }
                const parsed = parseCompetencyQuestionMetadata(sourceText);
                discovered.push(
                    Object.freeze({
                        id:
                            location.selector.kind === 'file'
                                ? location.idPrefix
                                : `${location.idPrefix}:${portableLocator(basename(locator))}`,
                        locator,
                        contentDigest: `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`,
                        bytes: Uint8Array.from(sourceBytes),
                        text: sourceText,
                        placeholders: Object.freeze({ ...(location.placeholders ?? {}) }),
                        metadata: Object.freeze({ ...parsed.metadata }),
                        diagnostics: Object.freeze(parsed.diagnostics.map((item) => Object.freeze({ ...item }))),
                        owner: Object.freeze({
                            ...location.owner,
                            ownedIriPrefixes: Object.freeze([...location.owner.ownedIriPrefixes]),
                        }),
                    }),
                );
            }
        }
        if (required && discovered.length === 0) {
            return yield* Effect.fail(
                new RequiredStageUnavailableError('competency-questions', null, 'no SPARQL .rq files were discovered'),
            );
        }
        return discovered;
    });
}
