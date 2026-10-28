import { createHash, randomBytes } from 'node:crypto';
import {
    closeSync,
    fchmodSync,
    fstatSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { isProxy } from 'node:util/types';

import { normalizeRegistryOrigin, parseCliCredential } from '@erden/contracts';

import { RegistryClientError, decodeCanonicalJson, encodeCanonicalJson, exactRecord } from './wire.js';

export interface CredentialEnvironment {
    readonly HOME?: string;
    readonly XDG_CONFIG_HOME?: string;
    readonly LOCALAPPDATA?: string;
}

export interface CredentialPathInspector {
    readonly isReparsePoint: (path: string, stat: BigIntStats) => boolean;
}

export interface StoredCliCredential {
    readonly schema: 'erden.cli-credential/v1';
    readonly origin: string;
    readonly credential: string;
    readonly expiresAt: number;
}

export interface StoredCliCredentialRevision {
    readonly path: string;
    readonly device: bigint;
    readonly inode: bigint;
    readonly sha256: string;
    readonly value: StoredCliCredential;
}

function currentEnvironment(): CredentialEnvironment {
    return {
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
        ...(process.env.XDG_CONFIG_HOME === undefined ? {} : { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }),
        ...(process.env.LOCALAPPDATA === undefined ? {} : { LOCALAPPDATA: process.env.LOCALAPPDATA }),
    };
}

const defaultPathInspector: CredentialPathInspector = Object.freeze({
    isReparsePoint: (_path: string, stat: BigIntStats) => stat.isSymbolicLink(),
});

function canonicalOrigin(input: string): string {
    try {
        const origin = normalizeRegistryOrigin(input);
        if (origin !== input) {
            throw new Error();
        }
        return origin;
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
}

function owner(): number | undefined {
    return process.getuid?.();
}
function identity(path: string, kind: 'directory' | 'file', inspector: CredentialPathInspector) {
    const stat = lstatSync(path, { bigint: true });
    if (
        stat.isSymbolicLink() ||
        inspector.isReparsePoint(path, stat) ||
        (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) ||
        (owner() !== undefined && stat.uid !== BigInt(owner() as number))
    ) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    if (kind === 'file' && stat.nlink !== 1n) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    return stat;
}

function same(left: ReturnType<typeof identity>, right: ReturnType<typeof identity>): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}

function mode(stat: ReturnType<typeof identity>): number {
    return Number(stat.mode & 511n);
}

type Plain = Readonly<Record<string, unknown>>;

function field(input: object, name: string): unknown {
    return Object.getOwnPropertyDescriptor(input, name)?.value;
}

function credentialInput(input: unknown): Plain {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        isProxy(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0 ||
        Object.getOwnPropertyNames(input).sort().join('\0') !==
            ['credential', 'expiresAt', 'origin', 'schema'].sort().join('\0')
    ) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    for (const name of Object.getOwnPropertyNames(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
    }
    return input as Plain;
}

function assertPlainAncestorChain(path: string, inspector: CredentialPathInspector, allowMissingLeaf: boolean): void {
    const absolute = resolve(path);
    const root = parse(absolute).root;
    let current = root;
    const parts = relative(root, absolute)
        .split(/[\\/]/u)
        .filter((part) => part.length !== 0);
    for (let index = 0; index < parts.length; index += 1) {
        current = join(current, parts[index] as string);
        let stat: BigIntStats;
        try {
            stat = lstatSync(current, { bigint: true });
        } catch (error) {
            if (
                allowMissingLeaf &&
                index === parts.length - 1 &&
                error instanceof Error &&
                'code' in error &&
                error.code === 'ENOENT'
            ) {
                return;
            }
            throw error;
        }
        if (stat.isSymbolicLink() || inspector.isReparsePoint(current, stat) || !stat.isDirectory()) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
    }
}

export function resolveCredentialPath(
    registryOrigin: string,
    environment: CredentialEnvironment = currentEnvironment(),
    platform: NodeJS.Platform = process.platform,
): string {
    const origin = canonicalOrigin(registryOrigin);
    const digest = createHash('sha256').update(origin).digest('hex');
    const base =
        platform === 'win32'
            ? environment.LOCALAPPDATA
            : (environment.XDG_CONFIG_HOME ??
              (environment.HOME === undefined ? undefined : join(environment.HOME, '.config')));
    if (base === undefined || !isAbsolute(base)) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    return platform === 'win32'
        ? resolve(base, 'Erden', 'credentials', 'v1', `${digest}.json`)
        : resolve(base, 'erden', 'credentials', 'v1', `${digest}.json`);
}

function ensureDirectory(
    path: string,
    create: boolean,
    platform: NodeJS.Platform,
    inspector: CredentialPathInspector,
): ReturnType<typeof identity> {
    try {
        const stat = identity(path, 'directory', inspector);
        if (platform !== 'win32' && mode(stat) !== 0o700) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
        return stat;
    } catch (error) {
        if (!create || error instanceof RegistryClientError) {
            throw error;
        }
        mkdirSync(path, { mode: 0o700, recursive: false });
        const stat = identity(path, 'directory', inspector);
        if (platform !== 'win32' && mode(stat) !== 0o700) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
        return stat;
    }
}

function credentialDirectory(
    registryOrigin: string,
    environment: CredentialEnvironment,
    platform: NodeJS.Platform,
    create: boolean,
    inspector: CredentialPathInspector,
): Readonly<{
    directory: string;
    file: string;
    parent: ReturnType<typeof identity>;
}> {
    const file = resolveCredentialPath(registryOrigin, environment, platform);
    const parts = platform === 'win32' ? ['Erden', 'credentials', 'v1'] : ['erden', 'credentials', 'v1'];
    const base = dirname(dirname(dirname(dirname(file))));
    let current = resolve(base);
    assertPlainAncestorChain(current, inspector, create);
    let baseIdentity: ReturnType<typeof identity>;
    try {
        baseIdentity = identity(current, 'directory', inspector);
    } catch (error) {
        if (!create || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            throw error;
        }
        const baseParent = dirname(current);
        const parentBefore = identity(baseParent, 'directory', inspector);
        if (platform !== 'win32' && (mode(parentBefore) & 0o022) !== 0) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
        mkdirSync(current, { mode: 0o700, recursive: false });
        if (!same(parentBefore, identity(baseParent, 'directory', inspector))) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
        baseIdentity = identity(current, 'directory', inspector);
    }
    if (platform !== 'win32' && (mode(baseIdentity) & 0o022) !== 0) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    for (const part of parts) {
        const before = identity(current, 'directory', inspector);
        const next = join(current, part);
        ensureDirectory(next, create, platform, inspector);
        if (!same(before, identity(current, 'directory', inspector))) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
        current = next;
    }
    return Object.freeze({ directory: current, file, parent: identity(current, 'directory', inspector) });
}

function decodeCredential(bytes: Uint8Array, origin: string): StoredCliCredential {
    const record = exactRecord(decodeCanonicalJson(bytes), ['credential', 'expiresAt', 'origin', 'schema']);
    const credential = field(record, 'credential');
    const expiresAt = field(record, 'expiresAt');
    if (
        field(record, 'schema') !== 'erden.cli-credential/v1' ||
        field(record, 'origin') !== origin ||
        typeof credential !== 'string' ||
        parseCliCredential(credential) === null ||
        typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt < 0 ||
        Object.is(expiresAt, -0)
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return Object.freeze({ schema: 'erden.cli-credential/v1', origin, credential, expiresAt });
}

export function readStoredCliCredential(
    registryOrigin: string,
    environment: CredentialEnvironment = currentEnvironment(),
    platform: NodeJS.Platform = process.platform,
    inspector: CredentialPathInspector = defaultPathInspector,
): StoredCliCredentialRevision | null {
    const origin = canonicalOrigin(registryOrigin);
    let location: ReturnType<typeof credentialDirectory>;
    try {
        location = credentialDirectory(origin, environment, platform, false, inspector);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    let stat: ReturnType<typeof identity>;
    try {
        stat = identity(location.file, 'file', inspector);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    if (platform !== 'win32' && mode(stat) !== 0o600) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const bytes = readFileSync(location.file);
    if (
        !same(stat, identity(location.file, 'file', inspector)) ||
        !same(location.parent, identity(location.directory, 'directory', inspector))
    ) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    return Object.freeze({
        path: location.file,
        device: stat.dev,
        inode: stat.ino,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        value: decodeCredential(bytes, origin),
    });
}

function fsyncParent(directory: string): void {
    let descriptor: number | undefined;
    try {
        descriptor = openSync(directory, 'r');
        fsyncSync(descriptor);
    } catch (error) {
        if (process.platform !== 'win32') {
            throw error;
        }
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
}

export function writeStoredCliCredential(
    value: StoredCliCredential,
    environment: CredentialEnvironment = currentEnvironment(),
    platform: NodeJS.Platform = process.platform,
    inspector: CredentialPathInspector = defaultPathInspector,
): StoredCliCredentialRevision {
    const input = credentialInput(value);
    const rawOrigin = field(input, 'origin');
    const credential = field(input, 'credential');
    const expiresAt = field(input, 'expiresAt');
    if (
        typeof rawOrigin !== 'string' ||
        field(input, 'schema') !== 'erden.cli-credential/v1' ||
        typeof credential !== 'string' ||
        parseCliCredential(credential) === null ||
        typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt < 0 ||
        Object.is(expiresAt, -0)
    ) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const origin = canonicalOrigin(rawOrigin);
    const canonicalValue: StoredCliCredential = Object.freeze({
        schema: 'erden.cli-credential/v1',
        origin,
        credential,
        expiresAt,
    });
    const bytes = encodeCanonicalJson(canonicalValue);
    const location = credentialDirectory(origin, environment, platform, true, inspector);
    try {
        const existing = identity(location.file, 'file', inspector);
        if (platform !== 'win32' && mode(existing) !== 0o600) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            throw error;
        }
    }
    const stage = join(location.directory, `.credential-${randomBytes(18).toString('hex')}.tmp`);
    let descriptor: number | undefined;
    let stageIdentity: ReturnType<typeof identity> | undefined;
    try {
        descriptor = openSync(stage, 'wx', 0o600);
        fchmodSync(descriptor, 0o600);
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
        const descriptorIdentity = fstatSync(descriptor, { bigint: true });
        stageIdentity = identity(stage, 'file', inspector);
        if (
            descriptorIdentity.dev !== stageIdentity.dev ||
            descriptorIdentity.ino !== stageIdentity.ino ||
            stageIdentity.nlink !== 1n ||
            (platform !== 'win32' && mode(stageIdentity) !== 0o600)
        ) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
        closeSync(descriptor);
        descriptor = undefined;
        if (
            !same(location.parent, identity(location.directory, 'directory', inspector)) ||
            !same(stageIdentity, identity(stage, 'file', inspector))
        ) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
        renameSync(stage, location.file);
        const published = identity(location.file, 'file', inspector);
        if (
            !same(stageIdentity, published) ||
            published.nlink !== 1n ||
            !same(location.parent, identity(location.directory, 'directory', inspector))
        ) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
        fsyncParent(location.directory);
        return readStoredCliCredential(origin, environment, platform, inspector) as StoredCliCredentialRevision;
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
        try {
            const current = identity(stage, 'file', inspector);
            if (stageIdentity !== undefined && same(stageIdentity, current)) {
                unlinkSync(stage);
            }
        } catch {
            /* stage is absent or no longer ours */
        }
    }
}

export function deleteStoredCliCredentialRevision(
    revision: StoredCliCredentialRevision,
    environment: CredentialEnvironment = currentEnvironment(),
    platform: NodeJS.Platform = process.platform,
    inspector: CredentialPathInspector = defaultPathInspector,
): boolean {
    const location = credentialDirectory(revision.value.origin, environment, platform, false, inspector);
    if (location.file !== revision.path) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    let stat: ReturnType<typeof identity>;
    try {
        stat = identity(location.file, 'file', inspector);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    const bytes = readFileSync(location.file);
    if (
        stat.dev !== revision.device ||
        stat.ino !== revision.inode ||
        createHash('sha256').update(bytes).digest('hex') !== revision.sha256 ||
        !same(stat, identity(location.file, 'file', inspector)) ||
        !same(location.parent, identity(location.directory, 'directory', inspector))
    ) {
        return false;
    }
    unlinkSync(location.file);
    fsyncParent(location.directory);
    return true;
}
