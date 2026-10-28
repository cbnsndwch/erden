import { normalizePackagePath } from '@erden/package-format';

import { compareCodePoints } from './constants.js';
import { normalizeManifestV1 } from './parsers.js';
import type { ManifestV1 } from './schema.js';

export type PublicationManifestPathKind =
    | 'citation-root'
    | 'competency-question-selector'
    | 'ontology-selector'
    | 'shape-selector';

const branded = new WeakSet<object>();

/** A path accepted for local tooling but not representable inside one published package. */
export class PublicationManifestPathError extends Error {
    readonly code = 'PUBLICATION_MANIFEST_PATH_UNSAFE' as const;
    readonly kind: PublicationManifestPathKind;
    readonly entry: string;
    override readonly cause!: unknown;

    constructor(kind: PublicationManifestPathKind, entry: string, cause?: unknown) {
        super(`The publication manifest contains a nonportable ${kind}`);
        this.name = 'PublicationManifestPathError';
        this.kind = kind;
        this.entry = entry;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        branded.add(this);
        Object.freeze(this);
    }
}

export function isPublicationManifestPathError(value: unknown): value is PublicationManifestPathError {
    return value !== null && typeof value === 'object' && branded.has(value);
}

function packagePath(value: string, kind: PublicationManifestPathKind, entry: string): string {
    try {
        const normalized = normalizePackagePath(value);
        if (normalized !== value) {
            throw new Error('path is not canonical');
        }
        return normalized;
    } catch (cause) {
        throw new PublicationManifestPathError(kind, entry, cause);
    }
}

function selectorPaths(
    values: ReadonlyArray<string>,
    kind: Exclude<PublicationManifestPathKind, 'citation-root'>,
): ReadonlyArray<string> {
    return Object.freeze(values.map((value, index) => packagePath(value, kind, String(index))));
}

function citationRootPaths(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    const entries = Object.keys(values)
        .sort(compareCodePoints)
        .map((name): readonly [string, string] => {
            const value = values[name];
            if (value === undefined) {
                throw new PublicationManifestPathError('citation-root', name);
            }
            return [name, value === '.' ? value : packagePath(value, 'citation-root', name)];
        });
    return Object.freeze(Object.fromEntries(entries));
}

/**
 * Refine the local schema-v1 manifest for publication without changing local path semantics.
 * Every selector is one canonical package path. Citation roots additionally allow `.` to name
 * the package root. Absolute, drive/UNC, backslash, traversal, dot-segment, control-character,
 * and non-normalized spellings are rejected by the package-path contract.
 */
/**
 * Refine the local schema-v1 manifest for publication without changing local path semantics.
 * Every selector is one canonical package path. Citation roots additionally allow `.` to name
 * the package root. Absolute, drive/UNC, backslash, traversal, dot-segment, control-character,
 * and non-normalized spellings are rejected by the package-path contract.
 */
export function normalizePublicationManifestV1(value: unknown): ManifestV1 {
    const manifest = normalizeManifestV1(value);
    return Object.freeze({
        ...manifest,
        sources: Object.freeze({
            ontology: selectorPaths(manifest.sources.ontology, 'ontology-selector'),
            shapes: selectorPaths(manifest.sources.shapes, 'shape-selector'),
            competencyQuestions: selectorPaths(manifest.sources.competencyQuestions, 'competency-question-selector'),
        }),
        citationRoots: citationRootPaths(manifest.citationRoots),
    });
}
