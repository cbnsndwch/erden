import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
    compareCodePoints,
    MANIFEST_FILENAMES,
    manifestFormatForExplicitFilename,
    manifestFormatForFilename,
    SUPPORTED_MANIFEST_EXTENSIONS,
    type ManifestFormat,
    InvalidManifestPathError,
    ManifestAmbiguityError,
    ManifestIoError,
    ManifestNotFoundError,
    parseManifestText,
    type LoadedManifestV1,
} from '@erden/contracts';

export interface ManifestDiscoveryOptions {
    readonly from?: string;
    readonly explicitPath?: string;
}

export interface ManifestLocation {
    readonly filePath: string;
    readonly projectRoot: string;
    readonly format: ManifestFormat;
}

export type ManifestDiscoveryError = InvalidManifestPathError | ManifestAmbiguityError | ManifestNotFoundError;

function asLocation(filePath: string, explicit: boolean): ManifestLocation {
    const filename = basename(filePath);
    const format = explicit ? manifestFormatForExplicitFilename(filename) : manifestFormatForFilename(filename);
    if (format === undefined) {
        throw new InvalidManifestPathError(
            filePath,
            explicit
                ? `expected a supported extension: ${SUPPORTED_MANIFEST_EXTENSIONS.join(', ')}`
                : `expected one of ${MANIFEST_FILENAMES.join(', ')}`,
        );
    }
    return Object.freeze({ filePath, projectRoot: dirname(filePath), format });
}

function initialSearchDirectory(from: string): string {
    const absolute = resolve(from);
    if (!existsSync(absolute)) {
        return absolute;
    }
    return statSync(absolute).isDirectory() ? absolute : dirname(absolute);
}

export function discoverManifest(options: ManifestDiscoveryOptions = {}): ManifestLocation {
    const from = resolve(options.from ?? process.cwd());
    if (options.explicitPath !== undefined) {
        const explicitPath = resolve(from, options.explicitPath);
        if (!existsSync(explicitPath)) {
            throw new InvalidManifestPathError(explicitPath, 'the file does not exist');
        }
        if (!statSync(explicitPath).isFile()) {
            throw new InvalidManifestPathError(explicitPath, 'the path is not a file');
        }
        return asLocation(explicitPath, true);
    }
    let directory = initialSearchDirectory(from);
    for (;;) {
        const candidates = MANIFEST_FILENAMES.map((filename) => join(directory, filename))
            .filter((filePath) => existsSync(filePath) && statSync(filePath).isFile())
            .sort(compareCodePoints);
        if (candidates.length > 1) {
            throw new ManifestAmbiguityError(directory, candidates);
        }
        const candidate = candidates[0];
        if (candidate !== undefined) {
            return asLocation(candidate, false);
        }
        const parent = dirname(directory);
        if (parent === directory) {
            throw new ManifestNotFoundError(from, MANIFEST_FILENAMES);
        }
        directory = parent;
    }
}

export function loadManifest(options: ManifestDiscoveryOptions = {}): LoadedManifestV1 {
    const location = discoverManifest(options);
    let text: string;
    try {
        text = readFileSync(location.filePath, 'utf8');
    } catch (error) {
        throw new ManifestIoError(location.filePath, error);
    }
    return parseManifestText({ filePath: location.filePath, text });
}
