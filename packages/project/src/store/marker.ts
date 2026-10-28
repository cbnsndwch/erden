import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

import {
    decodeLockfileValue,
    decodeLockToolchain,
    serializeLockfileBytes,
    type LockfileV1,
    type LockPackageNode,
    type LockToolchain,
    compareCodePoints,
    isCanonicalOntologyIri,
    isScopedAlias,
} from '@erden/contracts';
import {
    assertNoPortablePathConflicts,
    decodeCanonicalPackageManifest,
    encodeCanonicalPackageManifest,
    MAX_PACKAGE_COMPRESSED_BYTES,
    normalizePackagePath,
    PACKAGE_CODEC_LIMITS,
    type PackageManifestV1,
    type ValidatedPackageArchive,
} from '@erden/package-format';

import { isLocalPackageStoreError, LocalPackageStoreError, type LocalPackageStoreErrorCode } from './errors.js';
import { INSTALL_MARKER_FORMAT, STORE_OBJECT_MARKER_FORMAT, STORE_PROJECT_REFERENCE_FORMAT } from './model.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const STORE_MARKER_LIMITS = Object.freeze({
    maxObjectMarkerBytes: 16 * 1024 * 1024,
    maxInstallMarkerBytes: 64 * 1024 * 1024,
    maxObjectFiles: PACKAGE_CODEC_LIMITS.maxEntries,
    maxInstallLayers: 4_096,
    maxIdentifiers: 1_024 + 4_096,
    maxProjectReferenceBytes: 1024 * 1024,
    maxAdminMarkerBytes: 64 * 1024 * 1024,
    maxPruneClosureEntries: 250_000,
});

export interface StoreMarkerFile {
    readonly path: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly logicalMode: 0o644 | 0o755;
}

export interface StoreObjectMarker {
    readonly format: typeof STORE_OBJECT_MARKER_FORMAT;
    readonly archiveSha256: string;
    readonly archiveByteSize: number;
    readonly manifestSha256: string;
    readonly canonicalIri: string;
    readonly version: string;
    readonly dependencies: LockPackageNode['dependencies'];
    readonly toolchain: LockToolchain;
    readonly files: ReadonlyArray<StoreMarkerFile>;
}

export interface InstallMarkerLayer {
    readonly directory: string;
    readonly canonicalIri: string;
    readonly version: string;
    readonly archiveSha256: string;
    readonly manifestSha256: string;
    readonly identifiers: ReadonlyArray<string>;
}

export interface InstallMarker {
    readonly format: typeof INSTALL_MARKER_FORMAT;
    readonly lockSha256: string;
    readonly manifestDependencySha256: string;
    readonly toolchain: LockToolchain;
    readonly layers: ReadonlyArray<InstallMarkerLayer>;
}

export interface StoreProjectReferenceMarker {
    readonly format: typeof STORE_PROJECT_REFERENCE_FORMAT;
    readonly registrationId: string;
    readonly pathStyle: 'posix' | 'win32';
    readonly previous: Readonly<{
        readonly registrationId: string;
        readonly generationSha256: string;
    }> | null;
    readonly projectRoot: string;
    readonly manifestPath: string;
    readonly project: Readonly<{ readonly canonicalIri: string; readonly alias: string }>;
    readonly manifestSha256: string;
    readonly lockSha256: string;
    readonly manifestDependencySha256: string;
    readonly toolchain: LockToolchain;
    readonly archiveSha256s: ReadonlyArray<string>;
}

function deepFreeze<A>(value: A): A {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function rawCanonicalBytes(value: unknown): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

const unsafePathText =
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f\uD800-\uDFFF]/u;

function pathModule(style: 'posix' | 'win32'): typeof posix {
    return style === 'win32' ? win32 : posix;
}

function canonicalRegistrationPath(style: 'posix' | 'win32', value: string): string {
    const paths = pathModule(style);
    if (value.length === 0 || unsafePathText.test(value) || !paths.isAbsolute(value)) {
        throw new Error('reference path');
    }
    const resolved = paths.resolve(value).normalize('NFC');
    return style === 'win32' ? resolved.replaceAll('\\', '/').toUpperCase().toLowerCase().normalize('NFC') : resolved;
}

export function registrationIdFor(style: 'posix' | 'win32', manifestPath: string): string {
    return createHash('sha256').update(canonicalRegistrationPath(style, manifestPath), 'utf8').digest('hex');
}

function exactKeys(value: unknown, expected: ReadonlyArray<string>): value is Record<string, unknown> {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        return false;
    }
    const keys = Object.getOwnPropertyNames(value).sort(compareCodePoints);
    const wanted = [...expected].sort(compareCodePoints);
    return (
        Object.getOwnPropertySymbols(value).length === 0 &&
        keys.length === wanted.length &&
        keys.every(
            (key, index) =>
                key === wanted[index] &&
                (() => {
                    const descriptor = Object.getOwnPropertyDescriptor(value, key);
                    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
                })(),
        )
    );
}

function isClosedArray(value: unknown, maximum: number): value is ReadonlyArray<unknown> {
    if (
        !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0 ||
        value.length > maximum
    ) {
        return false;
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== value.length + 1 || !names.includes('length')) {
        return false;
    }
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            return false;
        }
    }
    return true;
}

function decodeUtf8Json(
    bytesInput: Uint8Array,
    label: string,
    maximumBytes: number,
    code: LocalPackageStoreErrorCode,
): unknown {
    try {
        const bytes = Uint8Array.from(bytesInput);
        if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
            throw new Error('marker size');
        }
        const text = decoder.decode(bytes);
        if (!text.isWellFormed() || text.startsWith('\uFEFF') || text.includes('\r') || !text.endsWith('\n')) {
            throw new Error('marker text');
        }
        const value: unknown = JSON.parse(text);
        if (!Buffer.from(rawCanonicalBytes(value)).equals(Buffer.from(bytes))) {
            throw new Error('marker canonical bytes');
        }
        return value;
    } catch (error) {
        if (isLocalPackageStoreError(error)) {
            throw error;
        }
        throw new LocalPackageStoreError(code, `${label} is not one canonical marker`, error);
    }
}

function decodeFiles(value: unknown): ReadonlyArray<StoreMarkerFile> {
    if (!Array.isArray(value) || value.length > STORE_MARKER_LIMITS.maxObjectFiles) {
        throw new Error('files');
    }
    const files = value.map((item) => {
        if (
            !exactKeys(item, ['path', 'byteSize', 'sha256', 'logicalMode']) ||
            typeof item.path !== 'string' ||
            !Number.isSafeInteger(item.byteSize) ||
            (item.byteSize as number) < 0 ||
            (item.byteSize as number) > PACKAGE_CODEC_LIMITS.maxEntryBytes ||
            typeof item.sha256 !== 'string' ||
            !SHA256.test(item.sha256) ||
            (item.logicalMode !== 0o644 && item.logicalMode !== 0o755)
        ) {
            throw new Error('file');
        }
        const normalized = normalizePackagePath(item.path);
        if (normalized !== item.path) {
            throw new Error('file path');
        }
        return Object.freeze({
            path: normalized,
            byteSize: item.byteSize as number,
            sha256: item.sha256,
            logicalMode: item.logicalMode,
        });
    });
    assertNoPortablePathConflicts(files.map(({ path }) => ({ path, kind: 'file' as const })));
    for (let index = 1; index < files.length; index += 1) {
        if (compareCodePoints(files[index - 1]?.path ?? '', files[index]?.path ?? '') >= 0) {
            throw new Error('file order');
        }
    }
    return Object.freeze(files);
}

function snapshotDependencies(value: LockPackageNode['dependencies']): LockPackageNode['dependencies'] {
    return Object.freeze(
        value.map((edge) =>
            Object.freeze({
                requested: edge.requested,
                canonicalIri: edge.canonicalIri,
                version: edge.version,
                archiveSha256: edge.archiveSha256,
            }),
        ),
    );
}

function validatedIdentity(
    canonicalIri: unknown,
    version: unknown,
    dependencies: unknown,
    toolchain: unknown,
): PackageManifestV1 {
    return decodeCanonicalPackageManifest(
        encodeCanonicalPackageManifest({
            formatVersion: 1,
            archiveRoot: 'package/',
            generatedManifestPath: '.erden/package-manifest.json',
            canonicalIri: canonicalIri as string,
            version: version as string,
            dependencies: dependencies as PackageManifestV1['dependencies'],
            toolchain: decodeLockToolchain(toolchain),
            files: [],
        }),
    );
}

export function buildStoreObjectMarker(
    expectedInput: LockPackageNode,
    toolchainInput: LockToolchain,
    validated: ValidatedPackageArchive,
): StoreObjectMarker {
    const identity = validatedIdentity(
        expectedInput.canonicalIri,
        expectedInput.version,
        expectedInput.dependencies,
        toolchainInput,
    );
    const marker = deepFreeze({
        format: STORE_OBJECT_MARKER_FORMAT,
        archiveSha256: validated.archiveSha256,
        archiveByteSize: validated.compressedBytes,
        manifestSha256: validated.manifestSha256,
        canonicalIri: identity.canonicalIri,
        version: identity.version,
        dependencies: snapshotDependencies(identity.dependencies),
        toolchain: decodeLockToolchain(identity.toolchain),
        files: decodeFiles(
            validated.files.map((file) => ({
                path: file.path,
                byteSize: file.byteSize,
                sha256: file.sha256,
                logicalMode: file.mode,
            })),
        ),
    });
    encodeStoreObjectMarker(marker);
    return marker;
}

export function encodeStoreObjectMarker(marker: StoreObjectMarker): Uint8Array {
    try {
        const bytes = rawCanonicalBytes(marker);
        if (bytes.byteLength > STORE_MARKER_LIMITS.maxObjectMarkerBytes) {
            throw new LocalPackageStoreError(
                'STORE_INVALID_INPUT',
                'The store object marker exceeds the closed v1 byte bound',
            );
        }
        decodeStoreObjectMarker(bytes);
        return bytes;
    } catch (error) {
        if (isLocalPackageStoreError(error) && error.code === 'STORE_INVALID_INPUT') {
            throw error;
        }
        throw new LocalPackageStoreError(
            'STORE_INVALID_INPUT',
            'The store object marker could not be encoded safely',
            error,
        );
    }
}

export function decodeStoreObjectMarker(bytes: Uint8Array): StoreObjectMarker {
    try {
        const value = decodeUtf8Json(
            bytes,
            'The store object marker',
            STORE_MARKER_LIMITS.maxObjectMarkerBytes,
            'STORE_REPAIR_REQUIRED',
        );
        if (
            !exactKeys(value, [
                'format',
                'archiveSha256',
                'archiveByteSize',
                'manifestSha256',
                'canonicalIri',
                'version',
                'dependencies',
                'toolchain',
                'files',
            ]) ||
            value.format !== STORE_OBJECT_MARKER_FORMAT ||
            typeof value.archiveSha256 !== 'string' ||
            !SHA256.test(value.archiveSha256) ||
            !Number.isSafeInteger(value.archiveByteSize) ||
            (value.archiveByteSize as number) <= 0 ||
            (value.archiveByteSize as number) > MAX_PACKAGE_COMPRESSED_BYTES ||
            typeof value.manifestSha256 !== 'string' ||
            !SHA256.test(value.manifestSha256) ||
            !Array.isArray(value.dependencies)
        ) {
            throw new Error('marker shape');
        }
        const manifest = validatedIdentity(value.canonicalIri, value.version, value.dependencies, value.toolchain);
        const marker = deepFreeze({
            format: STORE_OBJECT_MARKER_FORMAT,
            archiveSha256: value.archiveSha256,
            archiveByteSize: value.archiveByteSize as number,
            manifestSha256: value.manifestSha256,
            canonicalIri: manifest.canonicalIri,
            version: manifest.version,
            dependencies: snapshotDependencies(manifest.dependencies),
            toolchain: decodeLockToolchain(manifest.toolchain),
            files: decodeFiles(value.files),
        });
        if (!Buffer.from(rawCanonicalBytes(marker)).equals(Buffer.from(bytes))) {
            throw new Error('store marker rerender');
        }
        return marker;
    } catch (error) {
        if (isLocalPackageStoreError(error)) {
            throw error;
        }
        throw new LocalPackageStoreError(
            'STORE_REPAIR_REQUIRED',
            'The store object marker violates the closed v1 contract',
            error,
        );
    }
}

export function layerDirectoryFor(canonicalIri: string): string {
    return createHash('sha256').update(canonicalIri, 'utf8').digest('hex');
}

export function lockSha256(lockInput: LockfileV1): string {
    const lock = decodeLockfileValue(lockInput);
    return createHash('sha256').update(serializeLockfileBytes(lock)).digest('hex');
}

export function buildInstallMarker(
    lockInput: LockfileV1,
    objects: ReadonlyMap<string, StoreObjectMarker>,
): InstallMarker {
    const lock = decodeLockfileValue(lockInput);
    const directIdentifiers = new Map<string, string[]>();
    for (const direct of lock.directDependencies) {
        const identifiers = directIdentifiers.get(direct.canonicalIri) ?? [];
        identifiers.push(direct.identifier);
        directIdentifiers.set(direct.canonicalIri, identifiers);
    }
    const marker = deepFreeze({
        format: INSTALL_MARKER_FORMAT,
        lockSha256: lockSha256(lock),
        manifestDependencySha256: lock.manifestDependencySha256,
        toolchain: decodeLockToolchain(lock.toolchain),
        layers: lock.packages.map((node) => {
            const object = objects.get(node.archiveSha256);
            if (object === undefined) {
                throw new LocalPackageStoreError('STORE_OBJECT_MISSING', 'A locked package object is unavailable');
            }
            return {
                directory: layerDirectoryFor(node.canonicalIri),
                canonicalIri: node.canonicalIri,
                version: node.version,
                archiveSha256: node.archiveSha256,
                manifestSha256: object.manifestSha256,
                identifiers: [
                    ...new Set([node.canonicalIri, ...(directIdentifiers.get(node.canonicalIri) ?? [])]),
                ].sort(compareCodePoints),
            };
        }),
    });
    encodeInstallMarker(marker);
    return marker;
}

export function encodeInstallMarker(marker: InstallMarker): Uint8Array {
    try {
        const bytes = rawCanonicalBytes(marker);
        if (bytes.byteLength > STORE_MARKER_LIMITS.maxInstallMarkerBytes) {
            throw new LocalPackageStoreError(
                'STORE_INVALID_INPUT',
                'The project install marker exceeds the closed v1 byte bound',
            );
        }
        decodeInstallMarker(bytes);
        return bytes;
    } catch (error) {
        if (isLocalPackageStoreError(error) && error.code === 'STORE_INVALID_INPUT') {
            throw error;
        }
        throw new LocalPackageStoreError(
            'STORE_INVALID_INPUT',
            'The project install marker could not be encoded safely',
            error,
        );
    }
}

export function decodeInstallMarker(bytes: Uint8Array): InstallMarker {
    try {
        const value = decodeUtf8Json(
            bytes,
            'The project install marker',
            STORE_MARKER_LIMITS.maxInstallMarkerBytes,
            'INSTALL_REPAIR_REQUIRED',
        );
        if (
            !exactKeys(value, ['format', 'lockSha256', 'manifestDependencySha256', 'toolchain', 'layers']) ||
            value.format !== INSTALL_MARKER_FORMAT ||
            typeof value.lockSha256 !== 'string' ||
            !SHA256.test(value.lockSha256) ||
            typeof value.manifestDependencySha256 !== 'string' ||
            !SHA256.test(value.manifestDependencySha256) ||
            !Array.isArray(value.layers) ||
            value.layers.length > STORE_MARKER_LIMITS.maxInstallLayers
        ) {
            throw new Error('install marker');
        }
        let identifierCount = 0;
        const globallySeen = new Set<string>();
        const layers = value.layers.map((item) => {
            if (
                !exactKeys(item, [
                    'directory',
                    'canonicalIri',
                    'version',
                    'archiveSha256',
                    'manifestSha256',
                    'identifiers',
                ]) ||
                typeof item.directory !== 'string' ||
                !SHA256.test(item.directory) ||
                typeof item.canonicalIri !== 'string' ||
                !isCanonicalOntologyIri(item.canonicalIri) ||
                layerDirectoryFor(item.canonicalIri) !== item.directory ||
                typeof item.version !== 'string' ||
                typeof item.archiveSha256 !== 'string' ||
                !SHA256.test(item.archiveSha256) ||
                typeof item.manifestSha256 !== 'string' ||
                !SHA256.test(item.manifestSha256) ||
                !Array.isArray(item.identifiers) ||
                item.identifiers.some(
                    (identifier) =>
                        typeof identifier !== 'string' ||
                        (!isScopedAlias(identifier) && !isCanonicalOntologyIri(identifier)),
                )
            ) {
                throw new Error('layer');
            }
            validatedIdentity(item.canonicalIri, item.version, [], value.toolchain);
            identifierCount += item.identifiers.length;
            if (identifierCount > STORE_MARKER_LIMITS.maxIdentifiers) {
                throw new Error('identifier bound');
            }
            const identifiers = Object.freeze(
                item.identifiers.map((identifier: unknown): string => {
                    if (typeof identifier !== 'string') {
                        throw new Error('identifier');
                    }
                    return identifier;
                }),
            );
            for (let index = 1; index < identifiers.length; index += 1) {
                if (compareCodePoints(identifiers[index - 1] ?? '', identifiers[index] ?? '') >= 0) {
                    throw new Error('identifier order');
                }
            }
            if (!identifiers.includes(item.canonicalIri)) {
                throw new Error('canonical identifier');
            }
            for (const identifier of identifiers) {
                if (globallySeen.has(identifier)) {
                    throw new Error('duplicate identifier');
                }
                globallySeen.add(identifier);
            }
            return Object.freeze({
                directory: item.directory,
                canonicalIri: item.canonicalIri,
                version: item.version,
                archiveSha256: item.archiveSha256,
                manifestSha256: item.manifestSha256,
                identifiers,
            });
        });
        for (let index = 1; index < layers.length; index += 1) {
            if (compareCodePoints(layers[index - 1]?.canonicalIri ?? '', layers[index]?.canonicalIri ?? '') >= 0) {
                throw new Error('layer order');
            }
        }
        const marker = deepFreeze({
            format: INSTALL_MARKER_FORMAT,
            lockSha256: value.lockSha256,
            manifestDependencySha256: value.manifestDependencySha256,
            toolchain: decodeLockToolchain(value.toolchain),
            layers,
        });
        if (!Buffer.from(rawCanonicalBytes(marker)).equals(Buffer.from(bytes))) {
            throw new Error('install rerender');
        }
        return marker;
    } catch (error) {
        if (isLocalPackageStoreError(error)) {
            throw error;
        }
        throw new LocalPackageStoreError(
            'INSTALL_REPAIR_REQUIRED',
            'The project install marker violates the closed v1 contract',
            error,
        );
    }
}

function decodeReferenceLink(value: unknown): StoreProjectReferenceMarker['previous'] {
    if (value === null) {
        return null;
    }
    if (
        !exactKeys(value, ['registrationId', 'generationSha256']) ||
        typeof value.registrationId !== 'string' ||
        !SHA256.test(value.registrationId) ||
        typeof value.generationSha256 !== 'string' ||
        !SHA256.test(value.generationSha256)
    ) {
        throw new Error('reference predecessor');
    }
    return Object.freeze({ registrationId: value.registrationId, generationSha256: value.generationSha256 });
}

function decodeReferenceDigests(value: unknown): ReadonlyArray<string> {
    if (!Array.isArray(value) || value.length > STORE_MARKER_LIMITS.maxInstallLayers) {
        throw new Error('reference digests');
    }
    const digests = value.map((digest) => {
        if (typeof digest !== 'string' || !SHA256.test(digest)) {
            throw new Error('reference digest');
        }
        return digest;
    });
    for (let index = 1; index < digests.length; index += 1) {
        if (compareCodePoints(digests[index - 1] ?? '', digests[index] ?? '') >= 0) {
            throw new Error('reference digest order');
        }
    }
    return Object.freeze(digests);
}

function referenceMarker(value: Record<string, unknown>): StoreProjectReferenceMarker {
    const pathStyle = value.pathStyle;
    if (
        (pathStyle !== 'posix' && pathStyle !== 'win32') ||
        typeof value.projectRoot !== 'string' ||
        typeof value.manifestPath !== 'string' ||
        typeof value.registrationId !== 'string' ||
        !SHA256.test(value.registrationId) ||
        registrationIdFor(pathStyle, value.manifestPath) !== value.registrationId ||
        typeof value.manifestSha256 !== 'string' ||
        !SHA256.test(value.manifestSha256) ||
        typeof value.lockSha256 !== 'string' ||
        !SHA256.test(value.lockSha256) ||
        typeof value.manifestDependencySha256 !== 'string' ||
        !SHA256.test(value.manifestDependencySha256) ||
        !exactKeys(value.project, ['canonicalIri', 'alias']) ||
        typeof value.project.canonicalIri !== 'string' ||
        !isCanonicalOntologyIri(value.project.canonicalIri) ||
        typeof value.project.alias !== 'string' ||
        !isScopedAlias(value.project.alias)
    ) {
        throw new Error('reference identity');
    }
    const paths = pathModule(pathStyle);
    const root = paths.resolve(value.projectRoot).normalize('NFC');
    const manifest = paths.resolve(value.manifestPath).normalize('NFC');
    if (canonicalRegistrationPath(pathStyle, root) !== canonicalRegistrationPath(pathStyle, paths.dirname(manifest))) {
        throw new Error('reference root');
    }
    return deepFreeze({
        format: STORE_PROJECT_REFERENCE_FORMAT,
        registrationId: value.registrationId,
        pathStyle,
        previous: decodeReferenceLink(value.previous),
        projectRoot: root,
        manifestPath: manifest,
        project: { canonicalIri: value.project.canonicalIri, alias: value.project.alias },
        manifestSha256: value.manifestSha256,
        lockSha256: value.lockSha256,
        manifestDependencySha256: value.manifestDependencySha256,
        toolchain: decodeLockToolchain(value.toolchain),
        archiveSha256s: decodeReferenceDigests(value.archiveSha256s),
    });
}

export function buildStoreProjectReferenceMarker(
    input: Readonly<{
        readonly registrationId: string;
        readonly pathStyle: 'posix' | 'win32';
        readonly previous: StoreProjectReferenceMarker['previous'];
        readonly projectRoot: string;
        readonly manifestPath: string;
        readonly project: StoreProjectReferenceMarker['project'];
        readonly manifestSha256: string;
        readonly lock: LockfileV1;
    }>,
): StoreProjectReferenceMarker {
    const lock = decodeLockfileValue(input.lock);
    const marker = referenceMarker({
        format: STORE_PROJECT_REFERENCE_FORMAT,
        registrationId: input.registrationId,
        pathStyle: input.pathStyle,
        previous: input.previous,
        projectRoot: input.projectRoot,
        manifestPath: input.manifestPath,
        project: input.project,
        manifestSha256: input.manifestSha256,
        lockSha256: lockSha256(lock),
        manifestDependencySha256: lock.manifestDependencySha256,
        toolchain: lock.toolchain,
        archiveSha256s: [...new Set(lock.packages.map(({ archiveSha256 }) => archiveSha256))].sort(compareCodePoints),
    });
    encodeStoreProjectReferenceMarker(marker);
    return marker;
}

export function encodeStoreProjectReferenceMarker(marker: StoreProjectReferenceMarker): Uint8Array {
    try {
        const checked = referenceMarker(marker as unknown as Record<string, unknown>);
        const bytes = rawCanonicalBytes(checked);
        if (bytes.byteLength > STORE_MARKER_LIMITS.maxProjectReferenceBytes) {
            throw new Error('reference marker bound');
        }
        return bytes;
    } catch (error) {
        throw new LocalPackageStoreError(
            'STORE_INVALID_INPUT',
            'The store project reference could not be encoded safely',
            error,
        );
    }
}

export function decodeStoreProjectReferenceMarker(bytes: Uint8Array): StoreProjectReferenceMarker {
    try {
        const value = decodeUtf8Json(
            bytes,
            'The store project reference',
            STORE_MARKER_LIMITS.maxProjectReferenceBytes,
            'STORE_REPAIR_REQUIRED',
        );
        if (
            !exactKeys(value, [
                'format',
                'registrationId',
                'pathStyle',
                'previous',
                'projectRoot',
                'manifestPath',
                'project',
                'manifestSha256',
                'lockSha256',
                'manifestDependencySha256',
                'toolchain',
                'archiveSha256s',
            ]) ||
            value.format !== STORE_PROJECT_REFERENCE_FORMAT
        ) {
            throw new Error('reference shape');
        }
        const marker = referenceMarker(value);
        if (!Buffer.from(rawCanonicalBytes(marker)).equals(Buffer.from(bytes))) {
            throw new Error('reference rerender');
        }
        return marker;
    } catch (error) {
        if (isLocalPackageStoreError(error)) {
            throw error;
        }
        throw new LocalPackageStoreError(
            'STORE_REPAIR_REQUIRED',
            'The store project reference violates the closed v1 contract',
            error,
        );
    }
}

export function storeProjectReferenceGenerationSha256(marker: StoreProjectReferenceMarker): string {
    return createHash('sha256').update(encodeStoreProjectReferenceMarker(marker)).digest('hex');
}

export interface StorePruneDirectoryIdentity {
    readonly dev: string;
    readonly ino: string;
    readonly mode: string;
    readonly kind: 'directory';
}

export interface StorePruneFileIdentity {
    readonly dev: string;
    readonly ino: string;
    readonly mode: string;
    readonly size: string;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
    readonly kind: 'file';
}

export interface StorePruneClosureEntry {
    readonly path: string;
    readonly identity: StorePruneDirectoryIdentity | StorePruneFileIdentity;
    readonly sha256: string | null;
}

export interface StorePruneRegistrationPlanEntry {
    readonly registrationId: string;
    readonly generationSha256: string;
    readonly reason: 'superseded' | 'orphaned';
    readonly currentHead: Readonly<{
        readonly registrationId: string;
        readonly generationSha256: string;
        readonly sha256: string;
    }>;
    readonly sourceName: string;
    readonly quarantineName: string;
    readonly identity: StorePruneFileIdentity;
    readonly sha256: string;
    readonly record: StoreProjectReferenceMarker;
}

export interface StorePruneObjectPlanEntry {
    readonly archiveSha256: string;
    readonly sourceName: string;
    readonly quarantineName: string;
    readonly identity: StorePruneDirectoryIdentity;
    readonly marker: StoreObjectMarker;
    readonly closure: ReadonlyArray<StorePruneClosureEntry>;
    readonly logicalByteSize: string;
}

export type StoreAdminMarker =
    | Readonly<{
          readonly format: 'erden.store-admin-transaction/v1';
          readonly kind: 'registration';
          readonly token: string;
          readonly stageName: string;
          readonly finalName: string;
          readonly registrationId: string;
          readonly generationSha256: string;
          readonly stageIdentity: StorePruneFileIdentity;
      }>
    | Readonly<{
          readonly format: 'erden.store-admin-transaction/v1';
          readonly kind: 'prune';
          readonly token: string;
          readonly basis: Readonly<{
              readonly store: StorePruneDirectoryIdentity;
              readonly objects: StorePruneDirectoryIdentity;
              readonly registrations: StorePruneDirectoryIdentity;
              readonly storeEntriesSha256: string;
              readonly objectsEntriesSha256: string;
              readonly registrationsEntriesSha256: string;
          }>;
          readonly plan: Readonly<{
              readonly registrations: ReadonlyArray<StorePruneRegistrationPlanEntry>;
              readonly objects: ReadonlyArray<StorePruneObjectPlanEntry>;
          }>;
      }>;

const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SIGNED_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/u;
const ADMIN_TOKEN = /^[0-9A-Za-z_-]{16,128}$/u;

function pruneDirectoryIdentity(value: unknown): StorePruneDirectoryIdentity {
    if (
        !exactKeys(value, ['dev', 'ino', 'mode', 'kind']) ||
        value.kind !== 'directory' ||
        typeof value.dev !== 'string' ||
        !DECIMAL.test(value.dev) ||
        typeof value.ino !== 'string' ||
        !DECIMAL.test(value.ino) ||
        typeof value.mode !== 'string' ||
        !DECIMAL.test(value.mode)
    ) {
        throw new Error('prune directory identity');
    }
    return Object.freeze({ dev: value.dev, ino: value.ino, mode: value.mode, kind: 'directory' });
}

function pruneFileIdentity(value: unknown): StorePruneFileIdentity {
    if (
        !exactKeys(value, ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'kind']) ||
        value.kind !== 'file' ||
        typeof value.dev !== 'string' ||
        !DECIMAL.test(value.dev) ||
        typeof value.ino !== 'string' ||
        !DECIMAL.test(value.ino) ||
        typeof value.mode !== 'string' ||
        !DECIMAL.test(value.mode) ||
        typeof value.size !== 'string' ||
        !DECIMAL.test(value.size) ||
        typeof value.mtimeNs !== 'string' ||
        !SIGNED_DECIMAL.test(value.mtimeNs) ||
        typeof value.ctimeNs !== 'string' ||
        !SIGNED_DECIMAL.test(value.ctimeNs)
    ) {
        throw new Error('prune file identity');
    }
    return Object.freeze({
        dev: value.dev,
        ino: value.ino,
        mode: value.mode,
        size: value.size,
        mtimeNs: value.mtimeNs,
        ctimeNs: value.ctimeNs,
        kind: 'file',
    });
}

function pruneClosure(value: unknown, marker: StoreObjectMarker): ReadonlyArray<StorePruneClosureEntry> {
    if (!isClosedArray(value, STORE_MARKER_LIMITS.maxPruneClosureEntries)) {
        throw new Error('prune closure bound');
    }
    const entries = value.map((item) => {
        if (!exactKeys(item, ['path', 'identity', 'sha256']) || typeof item.path !== 'string') {
            throw new Error('prune closure entry');
        }
        const path = normalizePackagePath(item.path);
        if (path !== item.path) {
            throw new Error('prune closure path');
        }
        const directory =
            exactKeys(item.identity, ['dev', 'ino', 'mode', 'kind']) && item.identity.kind === 'directory';
        const identity = directory ? pruneDirectoryIdentity(item.identity) : pruneFileIdentity(item.identity);
        if (
            (identity.kind === 'directory' && item.sha256 !== null) ||
            (identity.kind === 'file' && (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)))
        ) {
            throw new Error('prune closure content');
        }
        return Object.freeze({ path, identity, sha256: item.sha256 as string | null });
    });
    for (let index = 1; index < entries.length; index += 1) {
        if (compareCodePoints(entries[index - 1]?.path ?? '', entries[index]?.path ?? '') >= 0) {
            throw new Error('prune closure order');
        }
    }
    assertNoPortablePathConflicts(entries.map(({ path, identity }) => ({ path, kind: identity.kind })));
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const markerEntry = byPath.get('object.json');
    const archiveEntry = byPath.get('archive.erdenpkg');
    if (
        markerEntry?.identity.kind !== 'file' ||
        markerEntry.sha256 !== createHash('sha256').update(encodeStoreObjectMarker(marker)).digest('hex') ||
        archiveEntry?.identity.kind !== 'file' ||
        archiveEntry.sha256 !== marker.archiveSha256
    ) {
        throw new Error('prune closure marker/archive binding');
    }
    const expected = new Map<
        string,
        {
            readonly kind: 'file' | 'directory';
            readonly sha256: string | null;
        }
    >([
        ['archive.erdenpkg', { kind: 'file', sha256: marker.archiveSha256 }],
        ['object.json', { kind: 'file', sha256: markerEntry.sha256 }],
        ['package', { kind: 'directory', sha256: null }],
        ['package/.erden', { kind: 'directory', sha256: null }],
        ['package/.erden/package-manifest.json', { kind: 'file', sha256: marker.manifestSha256 }],
    ]);
    for (const file of marker.files) {
        expected.set(`package/${file.path}`, { kind: 'file', sha256: file.sha256 });
        const parts = file.path.split('/');
        for (let index = 1; index < parts.length; index += 1) {
            expected.set(`package/${parts.slice(0, index).join('/')}`, { kind: 'directory', sha256: null });
        }
    }
    if (
        expected.size !== byPath.size ||
        [...expected].some(([path, truth]) => {
            const entry = byPath.get(path);
            return entry === undefined || entry.identity.kind !== truth.kind || entry.sha256 !== truth.sha256;
        })
    ) {
        throw new Error('prune closure semantic truth');
    }
    return Object.freeze(entries);
}

function decodePruneAdmin(value: Record<string, unknown>): Extract<
    StoreAdminMarker,
    {
        readonly kind: 'prune';
    }
> {
    const token = value.token;
    if (
        !exactKeys(value, ['format', 'kind', 'token', 'basis', 'plan']) ||
        value.format !== 'erden.store-admin-transaction/v1' ||
        value.kind !== 'prune' ||
        typeof token !== 'string' ||
        !ADMIN_TOKEN.test(token) ||
        !exactKeys(value.basis, [
            'store',
            'objects',
            'registrations',
            'storeEntriesSha256',
            'objectsEntriesSha256',
            'registrationsEntriesSha256',
        ]) ||
        typeof value.basis.storeEntriesSha256 !== 'string' ||
        !SHA256.test(value.basis.storeEntriesSha256) ||
        typeof value.basis.objectsEntriesSha256 !== 'string' ||
        !SHA256.test(value.basis.objectsEntriesSha256) ||
        typeof value.basis.registrationsEntriesSha256 !== 'string' ||
        !SHA256.test(value.basis.registrationsEntriesSha256) ||
        !exactKeys(value.plan, ['registrations', 'objects']) ||
        !isClosedArray(value.plan.registrations, 16384) ||
        !isClosedArray(value.plan.objects, 100000)
    ) {
        throw new Error('prune admin shape');
    }
    const registrations = value.plan.registrations.map((item) => {
        if (
            !exactKeys(item, [
                'registrationId',
                'generationSha256',
                'reason',
                'currentHead',
                'sourceName',
                'quarantineName',
                'identity',
                'sha256',
                'record',
            ]) ||
            typeof item.registrationId !== 'string' ||
            !SHA256.test(item.registrationId) ||
            typeof item.generationSha256 !== 'string' ||
            !SHA256.test(item.generationSha256) ||
            (item.reason !== 'superseded' && item.reason !== 'orphaned') ||
            !exactKeys(item.currentHead, ['registrationId', 'generationSha256', 'sha256']) ||
            typeof item.currentHead.registrationId !== 'string' ||
            !SHA256.test(item.currentHead.registrationId) ||
            typeof item.currentHead.generationSha256 !== 'string' ||
            !SHA256.test(item.currentHead.generationSha256) ||
            typeof item.currentHead.sha256 !== 'string' ||
            !SHA256.test(item.currentHead.sha256) ||
            item.sourceName !== `${item.registrationId}.${item.generationSha256}.json` ||
            item.quarantineName !== `.${item.registrationId}.${item.generationSha256}.prune-${token}.json` ||
            typeof item.sha256 !== 'string' ||
            !SHA256.test(item.sha256)
        ) {
            throw new Error('prune registration');
        }
        const record = decodeStoreProjectReferenceMarker(rawCanonicalBytes(item.record));
        if (
            record.registrationId !== item.registrationId ||
            storeProjectReferenceGenerationSha256(record) !== item.generationSha256 ||
            createHash('sha256').update(encodeStoreProjectReferenceMarker(record)).digest('hex') !== item.sha256
        ) {
            throw new Error('prune registration binding');
        }
        return Object.freeze({
            registrationId: item.registrationId,
            generationSha256: item.generationSha256,
            reason: item.reason,
            currentHead: Object.freeze({
                registrationId: item.currentHead.registrationId,
                generationSha256: item.currentHead.generationSha256,
                sha256: item.currentHead.sha256,
            }),
            sourceName: item.sourceName,
            quarantineName: item.quarantineName,
            identity: pruneFileIdentity(item.identity),
            sha256: item.sha256,
            record,
        });
    });
    const objects = value.plan.objects.map((item) => {
        if (
            !exactKeys(item, [
                'archiveSha256',
                'sourceName',
                'quarantineName',
                'identity',
                'marker',
                'closure',
                'logicalByteSize',
            ]) ||
            typeof item.archiveSha256 !== 'string' ||
            !SHA256.test(item.archiveSha256) ||
            item.sourceName !== item.archiveSha256 ||
            item.quarantineName !== `.${item.archiveSha256}.prune-${token}` ||
            typeof item.logicalByteSize !== 'string' ||
            !DECIMAL.test(item.logicalByteSize)
        ) {
            throw new Error('prune object');
        }
        const marker = decodeStoreObjectMarker(rawCanonicalBytes(item.marker));
        if (marker.archiveSha256 !== item.archiveSha256) {
            throw new Error('prune object marker');
        }
        return Object.freeze({
            archiveSha256: item.archiveSha256,
            sourceName: item.sourceName,
            quarantineName: item.quarantineName,
            identity: pruneDirectoryIdentity(item.identity),
            marker,
            closure: pruneClosure(item.closure, marker),
            logicalByteSize: item.logicalByteSize,
        });
    });
    const registrationNames = registrations.map(({ sourceName }) => sourceName);
    const objectNames = objects.map(({ archiveSha256 }) => archiveSha256);
    for (let index = 1; index < registrationNames.length; index += 1) {
        if (compareCodePoints(registrationNames[index - 1] ?? '', registrationNames[index] ?? '') >= 0) {
            throw new Error('prune registration order');
        }
    }
    for (let index = 1; index < objectNames.length; index += 1) {
        if (compareCodePoints(objectNames[index - 1] ?? '', objectNames[index] ?? '') >= 0) {
            throw new Error('prune object order');
        }
    }
    const closureEntries = objects.reduce((total, object) => total + object.closure.length, 0);
    if (closureEntries > STORE_MARKER_LIMITS.maxPruneClosureEntries) {
        throw new Error('prune total closure bound');
    }
    return deepFreeze({
        format: 'erden.store-admin-transaction/v1',
        kind: 'prune',
        token,
        basis: {
            store: pruneDirectoryIdentity(value.basis.store),
            objects: pruneDirectoryIdentity(value.basis.objects),
            registrations: pruneDirectoryIdentity(value.basis.registrations),
            storeEntriesSha256: value.basis.storeEntriesSha256,
            objectsEntriesSha256: value.basis.objectsEntriesSha256,
            registrationsEntriesSha256: value.basis.registrationsEntriesSha256,
        },
        plan: { registrations, objects },
    });
}

export function decodeStoreAdminMarker(bytes: Uint8Array): StoreAdminMarker {
    try {
        const value = decodeUtf8Json(
            bytes,
            'The store administration marker',
            STORE_MARKER_LIMITS.maxAdminMarkerBytes,
            'STORE_REPAIR_REQUIRED',
        );
        if (
            !exactKeys(
                value,
                value !== null &&
                    typeof value === 'object' &&
                    (
                        value as {
                            kind?: unknown;
                        }
                    ).kind === 'registration'
                    ? [
                          'format',
                          'kind',
                          'token',
                          'stageName',
                          'finalName',
                          'registrationId',
                          'generationSha256',
                          'stageIdentity',
                      ]
                    : ['format', 'kind', 'token', 'basis', 'plan'],
            )
        ) {
            throw new Error('admin marker shape');
        }
        if (value.kind === 'prune') {
            return decodePruneAdmin(value);
        }
        if (
            value.format !== 'erden.store-admin-transaction/v1' ||
            value.kind !== 'registration' ||
            typeof value.token !== 'string' ||
            !ADMIN_TOKEN.test(value.token) ||
            typeof value.registrationId !== 'string' ||
            !SHA256.test(value.registrationId) ||
            typeof value.generationSha256 !== 'string' ||
            !SHA256.test(value.generationSha256) ||
            value.stageName !== `.${value.registrationId}.${value.generationSha256}.stage-${value.token}.json` ||
            value.finalName !== `${value.registrationId}.${value.generationSha256}.json`
        ) {
            throw new Error('registration admin truth');
        }
        return Object.freeze({
            format: 'erden.store-admin-transaction/v1',
            kind: 'registration',
            token: value.token,
            stageName: value.stageName,
            finalName: value.finalName,
            registrationId: value.registrationId,
            generationSha256: value.generationSha256,
            stageIdentity: pruneFileIdentity(value.stageIdentity),
        });
    } catch (error) {
        if (isLocalPackageStoreError(error)) {
            throw error;
        }
        throw new LocalPackageStoreError(
            'STORE_REPAIR_REQUIRED',
            'The store administration marker violates the closed v1 contract',
            error,
        );
    }
}

export function encodeStoreAdminMarker(marker: StoreAdminMarker): Uint8Array {
    try {
        const bytes = rawCanonicalBytes(marker);
        if (bytes.byteLength > STORE_MARKER_LIMITS.maxAdminMarkerBytes) {
            throw new Error('admin marker byte bound');
        }
        const checked = decodeStoreAdminMarker(bytes);
        if (!Buffer.from(rawCanonicalBytes(checked)).equals(Buffer.from(bytes))) {
            throw new Error('admin marker rerender');
        }
        return bytes;
    } catch (error) {
        throw new LocalPackageStoreError(
            'STORE_INVALID_INPUT',
            'The store administration marker could not be encoded safely',
            error,
        );
    }
}
