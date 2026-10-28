import { Context, Effect } from 'effect';

import type { ManifestSerializationFormat } from '@erden/contracts';
import {
    InvalidManifestPathError,
    ManifestAmbiguityError,
    ManifestIoError,
    ManifestNotFoundError,
    ManifestParseError,
    parseManifestText,
    type LoadedManifestV1,
    type ParseManifestTextInput,
    serializeManifestV1,
} from '@erden/contracts';

import {
    discoverManifest,
    loadManifest,
    type ManifestDiscoveryError,
    type ManifestDiscoveryOptions,
    type ManifestLocation,
} from './discovery.js';

export type ManifestServiceError = ManifestDiscoveryError | ManifestIoError | ManifestParseError;

function normalizeError(error: unknown): ManifestServiceError {
    if (
        error instanceof InvalidManifestPathError ||
        error instanceof ManifestAmbiguityError ||
        error instanceof ManifestIoError ||
        error instanceof ManifestNotFoundError ||
        error instanceof ManifestParseError
    ) {
        return error;
    }
    return new ManifestIoError('<manifest>', error);
}

export interface ManifestServiceShape {
    readonly discover: (options?: ManifestDiscoveryOptions) => Effect.Effect<ManifestLocation, ManifestServiceError>;
    readonly parse: (input: ParseManifestTextInput) => Effect.Effect<LoadedManifestV1, ManifestServiceError>;
    readonly load: (options?: ManifestDiscoveryOptions) => Effect.Effect<LoadedManifestV1, ManifestServiceError>;
    readonly serialize: (
        manifest: unknown,
        format: ManifestSerializationFormat,
    ) => Effect.Effect<string, ManifestServiceError>;
}

export const ManifestService = Context.Service<ManifestServiceShape>('@erden/project/ManifestService');

export function makeManifestService(): ManifestServiceShape {
    return Object.freeze({
        discover: (options = {}) =>
            Effect.try({
                try: () => discoverManifest(options),
                catch: normalizeError,
            }),
        parse: (input: ParseManifestTextInput) =>
            Effect.try({
                try: () => parseManifestText(input),
                catch: normalizeError,
            }),
        load: (options = {}) =>
            Effect.try({
                try: () => loadManifest(options),
                catch: normalizeError,
            }),
        serialize: (manifest: unknown, format: ManifestSerializationFormat) =>
            Effect.try({
                try: () => serializeManifestV1(manifest, format),
                catch: normalizeError,
            }),
    });
}
