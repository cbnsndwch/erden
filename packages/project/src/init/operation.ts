import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

import { Context, Effect } from 'effect';

import {
    makeEmptyLockfile,
    nodeCurrentToolchainService,
    serializeLockfileBytes,
    type CurrentToolchainShape,
    normalizeManifestV1,
    type ManifestSerializationFormat,
} from '@erden/contracts';

import type { ApplicationOperation } from '../index.js';
import { makeManifestService, type ManifestServiceShape } from '../manifest/index.js';

import { InitProjectError } from './errors.js';
import { decodeInitProjectReport, INIT_REPORT_VERSION, type InitProjectReport } from './report.js';

export const DEFAULT_INIT_CANONICAL_IRI = 'https://example.invalid/erden/project' as const;
export const DEFAULT_INIT_ALIAS = '@example/project' as const;

const FORMAT_FILE: Readonly<Record<ManifestSerializationFormat, string>> = Object.freeze({
    json: 'erden.config.json',
    jsonc: 'erden.config.jsonc',
    yml: 'erden.config.yml',
    yaml: 'erden.config.yaml',
    toml: 'erden.config.toml',
});

export interface InitProjectOptions {
    readonly targetDirectory: string;
    readonly from?: string;
    readonly format?: ManifestSerializationFormat;
    readonly canonicalIri?: string;
    readonly alias?: string;
    readonly ownedIriPrefixes?: ReadonlyArray<string>;
}

export interface InitProjectFile {
    readonly path: string;
    readonly bytes: Uint8Array;
}

export interface InitProjectFileSystemPort {
    readonly commit: (
        targetDirectory: string,
        files: ReadonlyArray<InitProjectFile>,
    ) => Effect.Effect<void, InitProjectError>;
}

export interface InitNodeFileOperations {
    readonly lstat: typeof fs.lstat;
    readonly mkdir: typeof fs.mkdir;
    readonly writeFile: typeof fs.writeFile;
    readonly chmod: typeof fs.chmod;
    readonly readFile: typeof fs.readFile;
    readonly rename: typeof fs.rename;
    readonly readdir: typeof fs.readdir;
    readonly rm: typeof fs.rm;
    readonly rmdir: typeof fs.rmdir;
    readonly realpath: typeof fs.realpath;
    readonly tempToken: () => string;
    readonly ownershipToken: () => string;
}

const nodeFileOperations: InitNodeFileOperations = Object.freeze({
    lstat: fs.lstat,
    mkdir: fs.mkdir,
    writeFile: fs.writeFile,
    chmod: fs.chmod,
    readFile: fs.readFile,
    rename: fs.rename,
    readdir: fs.readdir,
    rm: fs.rm,
    rmdir: fs.rmdir,
    realpath: fs.realpath,
    tempToken: randomUUID,
    ownershipToken: randomUUID,
});

function isMissing(cause: unknown): boolean {
    return (
        cause !== null &&
        typeof cause === 'object' &&
        'code' in cause &&
        (
            cause as {
                readonly code?: unknown;
            }
        ).code === 'ENOENT'
    );
}

function portableFile(value: string): boolean {
    return (
        value.length > 0 &&
        !value.includes('\\') &&
        !value.startsWith('/') &&
        !/^[A-Za-z]:/u.test(value) &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
        value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    );
}

function portableIdentity(value: string): string {
    return value.normalize('NFC').toLocaleLowerCase('en-US');
}

const SAFE_TRANSACTION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9-]{15,127}$/u;
const TURTLE_IRIREF_FORBIDDEN = /[\u0000-\u0020<>"{}|^`\\]/u;

function isTurtleIriRefSafe(value: string): boolean {
    return !TURTLE_IRIREF_FORBIDDEN.test(value);
}

function childOf(parent: string, child: string): boolean {
    const fragment = relative(parent, child);
    return fragment.length > 0 && !isAbsolute(fragment) && fragment !== '..' && !fragment.startsWith(`..${sep}`);
}

export function makeNodeInitProjectFileSystemPort(
    operations: InitNodeFileOperations = nodeFileOperations,
): InitProjectFileSystemPort {
    return Object.freeze({
        commit: (targetDirectory: string, files: ReadonlyArray<InitProjectFile>) =>
            Effect.tryPromise({
                try: async () => {
                    const manifestNames = new Set(Object.values(FORMAT_FILE));
                    const manifest = files.find((file) => manifestNames.has(file.path));
                    const lock = files.find((file) => file.path === 'erden.lock');
                    const ontology = files.find((file) => file.path === 'ontology.ttl');
                    if (
                        files.length !== 3 ||
                        manifest === undefined ||
                        lock === undefined ||
                        ontology === undefined ||
                        files.some((file) => !portableFile(file.path) || file.path.includes('/')) ||
                        new Set(files.map((file) => portableIdentity(file.path))).size !== files.length
                    ) {
                        throw new InitProjectError(
                            'INIT_INVALID_OPTIONS',
                            'The scaffold contains an unsafe output path',
                        );
                    }
                    const target = resolve(targetDirectory);
                    const parent = dirname(target);
                    const pathRoot = parse(resolve(parent)).root;
                    if (pathRoot.length === 0) {
                        throw new InitProjectError(
                            'INIT_PARENT_UNAVAILABLE',
                            'The target parent directory has no filesystem root',
                        );
                    }
                    const ancestorFragment = relative(pathRoot, resolve(parent));
                    let ancestor = pathRoot;
                    for (const segment of ancestorFragment.split(sep).filter((part) => part.length > 0)) {
                        ancestor = resolve(ancestor, segment);
                        try {
                            const stat = await operations.lstat(ancestor);
                            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                                throw new InitProjectError(
                                    'INIT_PARENT_UNAVAILABLE',
                                    'The target parent may not traverse a symbolic or reparse path',
                                );
                            }
                        } catch (cause) {
                            if (cause instanceof InitProjectError) {
                                throw cause;
                            }
                            throw new InitProjectError(
                                'INIT_PARENT_UNAVAILABLE',
                                'The target parent directory is unavailable',
                                cause,
                            );
                        }
                    }
                    const realParent = await operations.realpath(parent);
                    // No ancestor is a link here, so a different real path comes from an alias the walk cannot see,
                    // such as a Windows 8.3 short name (C:\Users\RUNNER~1\...) or a substituted drive.
                    if (portableIdentity(resolve(realParent)) !== portableIdentity(resolve(parent))) {
                        throw new InitProjectError(
                            'INIT_PARENT_UNAVAILABLE',
                            'The target parent is not its own real path (for example a Windows 8.3 short name or a substituted drive); use the path it resolves to',
                        );
                    }
                    const expectedTarget = resolve(realParent, basename(target));
                    if (!childOf(realParent, expectedTarget) || dirname(expectedTarget) !== realParent) {
                        throw new InitProjectError(
                            'INIT_INVALID_OPTIONS',
                            'The target directory is not safely contained by its parent',
                        );
                    }
                    try {
                        await operations.lstat(target);
                        throw new InitProjectError(
                            'INIT_TARGET_EXISTS',
                            'The target already exists; Erden will not overwrite it',
                        );
                    } catch (cause) {
                        if (cause instanceof InitProjectError) {
                            throw cause;
                        }
                        if (!isMissing(cause)) {
                            throw new InitProjectError(
                                'INIT_TRANSACTION_FAILED',
                                'Could not inspect the init target',
                                cause,
                            );
                        }
                    }
                    const targetNameIdentity = portableIdentity(basename(expectedTarget));
                    const collidingEntry = (await operations.readdir(realParent)).some(
                        (entry) => portableIdentity(entry) === targetNameIdentity,
                    );
                    if (collidingEntry) {
                        throw new InitProjectError(
                            'INIT_TARGET_EXISTS',
                            'A portable-equivalent target already exists; Erden will not overwrite it',
                        );
                    }
                    const tempToken = operations.tempToken();
                    const token = operations.ownershipToken();
                    if (!SAFE_TRANSACTION_TOKEN.test(tempToken) || !SAFE_TRANSACTION_TOKEN.test(token)) {
                        throw new InitProjectError(
                            'INIT_TRANSACTION_FAILED',
                            'The filesystem did not provide a safe init transaction token',
                        );
                    }
                    const staging = resolve(realParent, `.${basename(target)}.erden-init-${tempToken}`);
                    if (
                        !childOf(realParent, staging) ||
                        dirname(staging) !== realParent ||
                        staging === expectedTarget
                    ) {
                        throw new InitProjectError(
                            'INIT_INVALID_OPTIONS',
                            'Could not allocate a contained init staging directory',
                        );
                    }
                    let stagingCreated = false;
                    let targetCreated = false;
                    let sentinelCreated = false;
                    let sentinelRewritten = false;
                    let stagingDirectoryIdentity: FileIdentity | undefined;
                    let targetDirectoryIdentity: FileIdentity | undefined;
                    let sentinelIdentity: FileIdentity | undefined;
                    const identities = new Map<string, FileIdentity>();
                    const supports = [ontology, lock];
                    const tokenBytes = new TextEncoder().encode(token);
                    const sentinelName = `.erden-init-owner-${token}`;
                    const sentinelPath = resolve(expectedTarget, sentinelName);
                    let rollbackUnsafe = false;
                    async function captureIdentity(path: string, kind: 'file' | 'directory'): Promise<FileIdentity> {
                        const stat = await operations.lstat(path, { bigint: true });
                        const validKind = kind === 'file' ? stat.isFile() : stat.isDirectory();
                        if (!validKind || stat.isSymbolicLink() || stat.dev <= 0n || stat.ino <= 0n) {
                            throw new InitProjectError(
                                'INIT_TRANSACTION_FAILED',
                                'The filesystem cannot provide safe init ownership identity',
                            );
                        }
                        return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode });
                    }
                    async function sameIdentity(
                        path: string,
                        identity: FileIdentity,
                        kind: 'file' | 'directory',
                    ): Promise<boolean> {
                        try {
                            const actual = await captureIdentity(path, kind);
                            return (
                                actual.dev === identity.dev &&
                                actual.ino === identity.ino &&
                                actual.mode === identity.mode
                            );
                        } catch {
                            return false;
                        }
                    }
                    async function matchesFile(
                        path: string,
                        identity: FileIdentity,
                        expected: Uint8Array,
                    ): Promise<boolean> {
                        if (!(await sameIdentity(path, identity, 'file'))) {
                            return false;
                        }
                        try {
                            const actual = await operations.readFile(path);
                            return (
                                Buffer.from(actual).equals(Buffer.from(expected)) &&
                                (await sameIdentity(path, identity, 'file'))
                            );
                        } catch {
                            return false;
                        }
                    }
                    async function removeOwned(
                        root: string,
                        file: InitProjectFile,
                        identity: FileIdentity,
                    ): Promise<boolean> {
                        const path = resolve(root, file.path);
                        if (!childOf(root, path) || !(await matchesFile(path, identity, file.bytes))) {
                            rollbackUnsafe = true;
                            return false;
                        }
                        // Node has no portable unlink-by-handle operation. Recheck the captured inode at the
                        // closest possible boundary before the non-recursive unlink and fail closed on change.
                        if (!(await sameIdentity(path, identity, 'file'))) {
                            rollbackUnsafe = true;
                            return false;
                        }
                        let removed = true;
                        await operations.rm(path, { recursive: false, force: false }).catch(() => {
                            rollbackUnsafe = true;
                            removed = false;
                        });
                        return removed;
                    }
                    try {
                        await operations.mkdir(staging, { recursive: false, mode: 0o700 });
                        stagingCreated = true;
                        stagingDirectoryIdentity = await captureIdentity(staging, 'directory');
                        for (const file of files) {
                            const output = resolve(staging, file.path);
                            if (!childOf(staging, output)) {
                                throw new InitProjectError(
                                    'INIT_INVALID_OPTIONS',
                                    'The scaffold contains an unsafe output path',
                                );
                            }
                            await operations.writeFile(output, file.bytes, { flag: 'wx', mode: 0o600 });
                            if (file.path === lock.path) {
                                await operations.chmod(output, 0o644);
                            }
                            identities.set(file.path, await captureIdentity(output, 'file'));
                        }
                        try {
                            await operations.mkdir(expectedTarget, { recursive: false, mode: 0o755 });
                        } catch (cause) {
                            if (
                                cause !== null &&
                                typeof cause === 'object' &&
                                'code' in cause &&
                                (
                                    cause as {
                                        readonly code?: unknown;
                                    }
                                ).code === 'EEXIST'
                            ) {
                                throw new InitProjectError(
                                    'INIT_TARGET_EXISTS',
                                    'The target appeared during initialization; Erden did not overwrite it',
                                );
                            }
                            throw cause;
                        }
                        targetCreated = true;
                        targetDirectoryIdentity = await captureIdentity(expectedTarget, 'directory');
                        await operations.writeFile(sentinelPath, tokenBytes, { flag: 'wx', mode: 0o600 });
                        sentinelCreated = true;
                        sentinelIdentity = await captureIdentity(sentinelPath, 'file');
                        for (const file of supports) {
                            await operations.rename(resolve(staging, file.path), resolve(expectedTarget, file.path));
                        }
                        const ontologyIdentity = identities.get(ontology.path);
                        const lockIdentity = identities.get(lock.path);
                        const manifestIdentity = identities.get(manifest.path);
                        if (
                            ontologyIdentity === undefined ||
                            lockIdentity === undefined ||
                            manifestIdentity === undefined ||
                            !(await matchesFile(
                                resolve(expectedTarget, ontology.path),
                                ontologyIdentity,
                                ontology.bytes,
                            )) ||
                            !(await matchesFile(resolve(expectedTarget, lock.path), lockIdentity, lock.bytes)) ||
                            !(await matchesFile(sentinelPath, sentinelIdentity, tokenBytes))
                        ) {
                            throw new InitProjectError(
                                'INIT_ROLLBACK_UNSAFE',
                                'Init stopped because an installed file changed before publication',
                            );
                        }
                        const finalParentCollisions = (await operations.readdir(realParent)).filter(
                            (entry) => portableIdentity(entry) === targetNameIdentity,
                        );
                        const finalEntries = await operations.readdir(expectedTarget);
                        const expectedEntries = new Set([...supports.map((file) => file.path), sentinelName]);
                        if (
                            finalParentCollisions.length !== 1 ||
                            finalParentCollisions[0] !== basename(expectedTarget) ||
                            finalEntries.length !== expectedEntries.size ||
                            finalEntries.some((entry) => !expectedEntries.has(entry)) ||
                            !(await matchesFile(sentinelPath, sentinelIdentity, tokenBytes))
                        ) {
                            throw new InitProjectError(
                                'INIT_ROLLBACK_UNSAFE',
                                'Init stopped because the reserved target changed before publication',
                            );
                        }
                        await operations.writeFile(sentinelPath, manifest.bytes, { flag: 'r+', mode: 0o600 });
                        sentinelRewritten = true;
                        if (!(await matchesFile(sentinelPath, sentinelIdentity, manifest.bytes))) {
                            throw new InitProjectError(
                                'INIT_ROLLBACK_UNSAFE',
                                'Init stopped because the publication sentinel changed',
                            );
                        }
                        if (!(await removeOwned(staging, manifest, manifestIdentity))) {
                            throw new InitProjectError(
                                'INIT_ROLLBACK_UNSAFE',
                                'Init could not retire its staging manifest safely',
                            );
                        }
                        if (!(await sameIdentity(staging, stagingDirectoryIdentity, 'directory'))) {
                            throw new InitProjectError(
                                'INIT_ROLLBACK_UNSAFE',
                                'Init stopped because its staging directory ownership changed',
                            );
                        }
                        await operations.rmdir(staging);
                        stagingCreated = false;
                        const publicationParentCollisions = (await operations.readdir(realParent)).filter(
                            (entry) => portableIdentity(entry) === targetNameIdentity,
                        );
                        const publicationEntries = await operations.readdir(expectedTarget);
                        const publicationEntrySet = new Set([...supports.map((support) => support.path), sentinelName]);
                        if (
                            publicationParentCollisions.length !== 1 ||
                            publicationParentCollisions[0] !== basename(expectedTarget) ||
                            publicationEntries.length !== publicationEntrySet.size ||
                            publicationEntries.some((entry) => !publicationEntrySet.has(entry)) ||
                            !(await sameIdentity(expectedTarget, targetDirectoryIdentity, 'directory')) ||
                            !(await matchesFile(sentinelPath, sentinelIdentity, manifest.bytes))
                        ) {
                            throw new InitProjectError(
                                'INIT_ROLLBACK_UNSAFE',
                                'Init stopped because the reserved target changed before publication',
                            );
                        }
                        // These support-file verifications are deliberately the final awaited observations before publication.
                        for (const support of supports) {
                            const supportIdentity = identities.get(support.path);
                            if (
                                supportIdentity === undefined ||
                                !(await matchesFile(
                                    resolve(expectedTarget, support.path),
                                    supportIdentity,
                                    support.bytes,
                                ))
                            ) {
                                throw new InitProjectError(
                                    'INIT_ROLLBACK_UNSAFE',
                                    'Init stopped because an installed file changed before publication',
                                );
                            }
                        }
                        await operations.chmod(sentinelPath, 0o644);
                        const canonicalManifestIdentity = await captureIdentity(sentinelPath, 'file');
                        if (
                            sentinelIdentity.dev !== canonicalManifestIdentity.dev ||
                            sentinelIdentity.ino !== canonicalManifestIdentity.ino ||
                            (process.platform !== 'win32' &&
                                Number(canonicalManifestIdentity.mode & 4095n) !== 0o644) ||
                            !(await matchesFile(sentinelPath, canonicalManifestIdentity, manifest.bytes))
                        ) {
                            throw new InitProjectError(
                                'INIT_ROLLBACK_UNSAFE',
                                'Init stopped because the manifest could not be authenticated at canonical mode 0644',
                            );
                        }
                        sentinelIdentity = canonicalManifestIdentity;
                        await operations.rename(sentinelPath, resolve(expectedTarget, manifest.path));
                        if (
                            !(await matchesFile(
                                resolve(expectedTarget, manifest.path),
                                sentinelIdentity,
                                manifest.bytes,
                            ))
                        ) {
                            throw new InitProjectError(
                                'INIT_ROLLBACK_UNSAFE',
                                'Init stopped because the published manifest changed',
                            );
                        }
                    } catch (cause) {
                        const publishedIdentity = sentinelIdentity;
                        if (
                            publishedIdentity !== undefined &&
                            targetDirectoryIdentity !== undefined &&
                            supports.every((support) => identities.get(support.path) !== undefined) &&
                            !(await pathExists(sentinelPath, operations)) &&
                            (await sameIdentity(expectedTarget, targetDirectoryIdentity, 'directory')) &&
                            (await matchesFile(
                                resolve(expectedTarget, manifest.path),
                                publishedIdentity,
                                manifest.bytes,
                            ))
                        ) {
                            let supportsPublished = true;
                            for (const support of supports) {
                                const supportIdentity = identities.get(support.path);
                                if (
                                    supportIdentity === undefined ||
                                    !(await matchesFile(
                                        resolve(expectedTarget, support.path),
                                        supportIdentity,
                                        support.bytes,
                                    ))
                                ) {
                                    supportsPublished = false;
                                    break;
                                }
                            }
                            const publishedEntries = await operations
                                .readdir(expectedTarget)
                                .catch(() => [] as string[]);
                            const expectedPublished = new Set([
                                ...supports.map((support) => support.path),
                                manifest.path,
                            ]);
                            if (
                                supportsPublished &&
                                publishedEntries.length === expectedPublished.size &&
                                publishedEntries.every((entry) => expectedPublished.has(entry))
                            ) {
                                return;
                            }
                        }
                        if (targetCreated) {
                            const entries = await operations.readdir(expectedTarget).catch(() => [] as string[]);
                            const ownedNames = new Set([
                                ...supports.map((support) => support.path),
                                ...(sentinelCreated ? [sentinelName] : []),
                            ]);
                            if (entries.some((entry) => !ownedNames.has(entry))) {
                                rollbackUnsafe = true;
                            }
                            for (const support of supports) {
                                const supportIdentity = identities.get(support.path);
                                if (entries.includes(support.path) && supportIdentity !== undefined) {
                                    await removeOwned(expectedTarget, support, supportIdentity);
                                }
                            }
                            const expectedSentinelBytes = sentinelRewritten ? manifest.bytes : tokenBytes;
                            if (
                                entries.includes(sentinelName) &&
                                sentinelIdentity !== undefined &&
                                (await matchesFile(sentinelPath, sentinelIdentity, expectedSentinelBytes))
                            ) {
                                await operations.rm(sentinelPath, { recursive: false, force: false }).catch(() => {
                                    rollbackUnsafe = true;
                                });
                            } else if (entries.includes(sentinelName) || sentinelCreated) {
                                rollbackUnsafe = true;
                            }
                            const remaining = await operations.readdir(expectedTarget).catch(() => ['<unreadable>']);
                            if (
                                remaining.length === 0 &&
                                targetDirectoryIdentity !== undefined &&
                                (await sameIdentity(expectedTarget, targetDirectoryIdentity, 'directory'))
                            ) {
                                await operations.rmdir(expectedTarget).catch(() => {
                                    rollbackUnsafe = true;
                                });
                            } else {
                                rollbackUnsafe = true;
                            }
                        }
                        if (stagingCreated) {
                            const stagedEntries = await operations.readdir(staging).catch(() => ['<unreadable>']);
                            for (const file of files.filter((file) => stagedEntries.includes(file.path))) {
                                const identity = identities.get(file.path);
                                if (identity === undefined) {
                                    rollbackUnsafe = true;
                                } else {
                                    await removeOwned(staging, file, identity);
                                }
                            }
                            const remaining = await operations.readdir(staging).catch(() => ['<unreadable>']);
                            if (
                                remaining.length === 0 &&
                                stagingDirectoryIdentity !== undefined &&
                                (await sameIdentity(staging, stagingDirectoryIdentity, 'directory'))
                            ) {
                                await operations.rmdir(staging).catch(() => {
                                    rollbackUnsafe = true;
                                });
                            } else {
                                rollbackUnsafe = true;
                            }
                        }
                        if (rollbackUnsafe) {
                            throw new InitProjectError(
                                'INIT_ROLLBACK_UNSAFE',
                                'Init left an inert target without a published manifest because ownership changed during rollback',
                                cause,
                            );
                        }
                        if (cause instanceof InitProjectError) {
                            throw cause;
                        }
                        throw new InitProjectError(
                            'INIT_TRANSACTION_FAILED',
                            'The project could not be initialized; no scaffold was retained',
                            cause,
                        );
                    }
                },
                catch: (cause) =>
                    cause instanceof InitProjectError
                        ? cause
                        : new InitProjectError(
                              'INIT_TRANSACTION_FAILED',
                              'The project could not be initialized; no scaffold was retained',
                              cause,
                          ),
            }),
    });
}

interface FileIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
}

async function pathExists(path: string, operations: InitNodeFileOperations): Promise<boolean> {
    try {
        await operations.lstat(path);
        return true;
    } catch (cause) {
        if (isMissing(cause)) {
            return false;
        }
        return true;
    }
}

function sha256(bytes: Uint8Array): string {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function ontologyText(canonicalIri: string, ownedPrefix: string): string {
    return `@prefix ex: <${ownedPrefix}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .

<${canonicalIri}> a owl:Ontology .

ex:Concept a owl:Class .
ex:example a ex:Concept .
`;
}

function runInitProject(
    options: InitProjectOptions,
    manifestService: ManifestServiceShape,
    files: InitProjectFileSystemPort,
    toolchains: CurrentToolchainShape,
): Effect.Effect<InitProjectReport, InitProjectError> {
    return Effect.gen(function* () {
        const format = options.format ?? 'json';
        const manifestFile = FORMAT_FILE[format];
        const canonicalIri = options.canonicalIri ?? DEFAULT_INIT_CANONICAL_IRI;
        const alias = options.alias ?? DEFAULT_INIT_ALIAS;
        const inferredPrefix =
            canonicalIri.endsWith('#') || canonicalIri.endsWith('/') ? canonicalIri : `${canonicalIri}#`;
        const ownedIriPrefixes = options.ownedIriPrefixes ?? [inferredPrefix];
        const normalized = yield* Effect.try({
            try: () =>
                normalizeManifestV1({
                    schemaVersion: 1,
                    canonicalIri,
                    alias,
                    ownedIriPrefixes,
                    title: 'Erden project',
                    description: 'Replace the example.invalid identity before publishing.',
                    sources: { ontology: ['ontology.ttl'] },
                }),
            catch: (cause) =>
                new InitProjectError(
                    'INIT_INVALID_OPTIONS',
                    'The requested project identity or manifest format is invalid',
                    cause,
                ),
        });
        const selectedOwnedPrefix = normalized.ownedIriPrefixes[0];
        if (
            !isTurtleIriRefSafe(normalized.canonicalIri) ||
            selectedOwnedPrefix === undefined ||
            !isTurtleIriRefSafe(selectedOwnedPrefix)
        ) {
            return yield* Effect.fail(
                new InitProjectError(
                    'INIT_INVALID_OPTIONS',
                    'The project ontology IRI and owned prefixes cannot be represented safely in the generated Turtle source',
                ),
            );
        }
        let manifestText: string;
        try {
            manifestText = yield* manifestService
                .serialize(normalized, format)
                .pipe(
                    Effect.mapError(
                        (cause) =>
                            new InitProjectError(
                                'INIT_INVALID_OPTIONS',
                                'The requested project identity or manifest format is invalid',
                                cause,
                            ),
                    ),
                );
        } catch (cause) {
            return yield* Effect.fail(
                cause instanceof InitProjectError
                    ? cause
                    : new InitProjectError('INIT_INVALID_OPTIONS', 'The requested init options are invalid', cause),
            );
        }
        const toolchain = yield* toolchains
            .inspect()
            .pipe(
                Effect.mapError(
                    (cause) =>
                        new InitProjectError(
                            'INIT_TRANSACTION_FAILED',
                            'The current validator and bundled reasoner identity is unavailable',
                            cause,
                        ),
                ),
            );
        const lockBytes = yield* Effect.try({
            try: () => serializeLockfileBytes(makeEmptyLockfile(normalized, toolchain)),
            catch: (cause) =>
                new InitProjectError(
                    'INIT_TRANSACTION_FAILED',
                    'The canonical empty project lock could not be constructed',
                    cause,
                ),
        });
        const encoder = new TextEncoder();
        const outputs = [
            { path: manifestFile, bytes: encoder.encode(manifestText) },
            { path: 'erden.lock', bytes: lockBytes },
            { path: 'ontology.ttl', bytes: encoder.encode(ontologyText(normalized.canonicalIri, selectedOwnedPrefix)) },
        ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
        const target = resolve(options.from ?? process.cwd(), options.targetDirectory);
        yield* files.commit(target, outputs);
        return decodeInitProjectReport({
            schema: INIT_REPORT_VERSION,
            manifest: {
                format,
                file: manifestFile,
                canonicalIri: normalized.canonicalIri,
                alias: normalized.alias,
                ownedIriPrefixes: normalized.ownedIriPrefixes,
            },
            files: outputs.map((file) => ({
                path: file.path,
                bytes: file.bytes.byteLength,
                contentDigest: sha256(file.bytes),
            })),
            outcome: 'initialized',
        });
    });
}

export function initProject(
    options: InitProjectOptions,
): Effect.Effect<InitProjectReport, InitProjectError, Context.Service.Identifier<typeof InitProjectService>> {
    return Effect.gen(function* () {
        const service = yield* Effect.service(InitProjectService);
        return yield* service.init(options);
    });
}

export function defineInitProjectOperation(
    options: InitProjectOptions,
): ApplicationOperation<
    'InitProject',
    InitProjectReport,
    InitProjectError,
    Context.Service.Identifier<typeof InitProjectService>
> {
    return Object.freeze({ name: 'InitProject', effect: initProject(options) });
}

export interface InitProjectServiceShape {
    readonly init: (options: InitProjectOptions) => Effect.Effect<InitProjectReport, InitProjectError>;
}

export const InitProjectService = Context.Service<InitProjectServiceShape>('@erden/project/InitProjectService');

export function makeInitProjectService(
    manifestService: ManifestServiceShape,
    fileSystem: InitProjectFileSystemPort,
    toolchains: CurrentToolchainShape = nodeCurrentToolchainService,
): InitProjectServiceShape {
    return Object.freeze({
        init: (options: InitProjectOptions) => runInitProject(options, manifestService, fileSystem, toolchains),
    });
}

export const nodeInitProjectService = makeInitProjectService(
    makeManifestService(),
    makeNodeInitProjectFileSystemPort(),
    nodeCurrentToolchainService,
);
