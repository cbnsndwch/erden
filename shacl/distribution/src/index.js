// Offline resolver and integrity doctor for the bundled SHACL engine, erden-shacl. The reasoner's resolver
// (reasoner/distribution/src/index.js) with this program's packages, identity and known answer: the same platform
// selection, the same package and metadata contract, the same refusals and error codes. Nothing is downloaded,
// installed or written; nothing runs before the binary's size and SHA-256 match the qualified mint.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { ENGINE_DIGEST, KNOWN_ANSWER_FIXTURE_DIGEST, PACKAGE_VERSION, QUALIFIED_ARTIFACTS } from './artifacts.js';

export { PACKAGE_VERSION };
export const TOOL_NAME = 'erden-shacl';
export const TOOL_VERSION = PACKAGE_VERSION;
export const SHACL_ENGINE_DIGEST = ENGINE_DIGEST;

const NODE_ENGINE_RANGE = '^24';
const KNOWN_ANSWER_FIXTURE_URL = new URL('../fixtures/known-answer.request.json', import.meta.url);
const PLACEHOLDER_DIGEST = `sha256:${'0'.repeat(64)}`;
const require = createRequire(import.meta.url);

export const ERROR_CODES = Object.freeze({
    ambiguousPackage: 'AMBIGUOUS_PACKAGE',
    binaryDigestMismatch: 'BINARY_DIGEST_MISMATCH',
    binaryMissing: 'BINARY_MISSING',
    binaryNotExecutable: 'BINARY_NOT_EXECUTABLE',
    binaryNotRegular: 'BINARY_NOT_REGULAR',
    binarySizeMismatch: 'BINARY_SIZE_MISMATCH',
    metadataInvalid: 'PACKAGE_METADATA_INVALID',
    notMinted: 'NOT_MINTED',
    packageMissing: 'PACKAGE_MISSING',
    pathEscape: 'PATH_ESCAPE',
    selfTestFailed: 'SELF_TEST_FAILED',
    symlinkDisallowed: 'SYMLINK_DISALLOWED',
    unsupportedLibc: 'UNSUPPORTED_LIBC',
    unsupportedPlatform: 'UNSUPPORTED_PLATFORM',
    versionMismatch: 'PACKAGE_VERSION_MISMATCH',
    wrongTarget: 'WRONG_TARGET',
});

/** Audited immutable platform anchors, written by shacl/qualification/finalize-artifacts.mjs from the mint. */
export const QUALIFIED_SHACL_ARTIFACTS = QUALIFIED_ARTIFACTS;

export class BundledShaclEngineError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'BundledShaclEngineError';
        this.code = code;
        this.details = Object.freeze({ ...details });
    }
}

function fail(code, message, details) {
    throw new BundledShaclEngineError(code, message, details);
}
function sha256(value) {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function readJson(path, label, details) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return fail(ERROR_CODES.metadataInvalid, `${label} is missing or invalid JSON`, details);
    }
}
function assertPlainFile(path, label, details, metadataFile = false) {
    let stat;
    try {
        stat = lstatSync(path);
    } catch {
        return fail(
            metadataFile ? ERROR_CODES.metadataInvalid : ERROR_CODES.binaryMissing,
            `${label} is missing`,
            details,
        );
    }
    if (stat.isSymbolicLink()) {
        fail(ERROR_CODES.symlinkDisallowed, `${label} must not be a symbolic link`, details);
    }
    if (!stat.isFile()) {
        fail(
            metadataFile ? ERROR_CODES.metadataInvalid : ERROR_CODES.binaryNotRegular,
            `${label} must be a regular file`,
            details,
        );
    }
    return stat;
}
function inside(root, path) {
    const fragment = relative(root, path);
    return fragment !== '..' && !fragment.startsWith(`..${sep}`) && !isAbsolute(fragment);
}

export function detectRuntime() {
    if (process.platform !== 'linux') {
        return Object.freeze({ platform: process.platform, arch: process.arch });
    }
    const header = process.report?.getReport()?.header;
    const libc = isRecord(header) && typeof header.glibcVersionRuntime === 'string' ? 'glibc' : 'unknown';
    return Object.freeze({ platform: process.platform, arch: process.arch, libc });
}
function runtimeKey(runtime) {
    return runtime.libc === undefined
        ? `${runtime.platform}:${runtime.arch}`
        : `${runtime.platform}:${runtime.arch}:${runtime.libc}`;
}
function describePlatform({ os, cpu, libc }) {
    return libc === undefined ? `${os} ${cpu}` : `${os} ${cpu} (${libc})`;
}

/** Every runtime with a qualified bundled SHACL engine, as refusals name them. */
export const SUPPORTED_PLATFORMS = Object.freeze(
    Object.values(QUALIFIED_ARTIFACTS).map(({ runtime }) => describePlatform(runtime)),
);

function refuse(code, refused, runtime) {
    return fail(
        code,
        `No qualified bundled SHACL engine exists for ${refused}; supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
        {
            runtime,
            supported: SUPPORTED_PLATFORMS,
        },
    );
}
function selectExpected(runtime) {
    if (runtime.platform === 'linux' && runtime.libc !== 'glibc') {
        return refuse(ERROR_CODES.unsupportedLibc, `linux ${runtime.arch} without glibc`, runtime);
    }
    const expected = Object.hasOwn(QUALIFIED_ARTIFACTS, runtimeKey(runtime))
        ? QUALIFIED_ARTIFACTS[runtimeKey(runtime)]
        : undefined;
    if (expected === undefined) {
        return refuse(
            ERROR_CODES.unsupportedPlatform,
            describePlatform({ os: runtime.platform, cpu: runtime.arch, libc: runtime.libc }),
            runtime,
        );
    }
    return expected;
}
function defaultLocatePackage(packageName) {
    try {
        return dirname(realpathSync(require.resolve(`${packageName}/package.json`)));
    } catch (error) {
        if (isRecord(error) && error.code === 'MODULE_NOT_FOUND') {
            return undefined;
        }
        throw error;
    }
}

function validateManifest(manifest, expected, details) {
    const keys = [
        'name',
        'version',
        'description',
        'license',
        'type',
        'files',
        'bin',
        'os',
        'cpu',
        'engines',
        ...(expected.runtime.libc === undefined ? [] : ['libc']),
    ];
    if (!hasExactKeys(manifest, keys)) {
        fail(ERROR_CODES.metadataInvalid, 'Platform package manifest shape is invalid', details);
    }
    if (manifest.name !== expected.packageName) {
        fail(ERROR_CODES.wrongTarget, 'Platform package identity does not match the selected runtime', details);
    }
    if (manifest.version !== PACKAGE_VERSION) {
        fail(ERROR_CODES.versionMismatch, 'Platform package version does not match the resolver', details);
    }
    if (
        !same(manifest.os, [expected.runtime.os]) ||
        !same(manifest.cpu, [expected.runtime.cpu]) ||
        !same(manifest.libc, expected.runtime.libc === undefined ? undefined : [expected.runtime.libc])
    ) {
        fail(
            ERROR_CODES.wrongTarget,
            'Platform package os/cpu/libc metadata does not match the selected runtime',
            details,
        );
    }
    if (
        manifest.description !== expected.description ||
        manifest.license !== 'Apache-2.0' ||
        manifest.type !== 'module' ||
        !same(manifest.files, ['bin', 'metadata.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) ||
        !same(manifest.bin, { 'erden-shacl': expected.binaryPath }) ||
        !same(manifest.engines, { node: NODE_ENGINE_RANGE })
    ) {
        fail(ERROR_CODES.metadataInvalid, 'Platform package manifest contract is invalid', details);
    }
}

function validateMetadata(metadata, expected, details) {
    const runtimeKeys = expected.runtime.libc === undefined ? ['os', 'cpu'] : ['os', 'cpu', 'libc'];
    if (
        !hasExactKeys(metadata, [
            'schemaVersion',
            'packageName',
            'packageVersion',
            'tool',
            'runtime',
            'target',
            'binary',
            'knownAnswer',
        ]) ||
        !hasExactKeys(metadata.tool, ['name', 'version', 'engineDigest']) ||
        !hasExactKeys(metadata.runtime, runtimeKeys) ||
        !hasExactKeys(metadata.binary, ['path', 'bytes', 'sha256']) ||
        !hasExactKeys(metadata.knownAnswer, ['fixture', 'responseBytes', 'responseSha256'])
    ) {
        fail(ERROR_CODES.metadataInvalid, 'Qualification metadata shape is invalid', details);
    }
    if (metadata.packageVersion !== PACKAGE_VERSION || metadata.tool.version !== TOOL_VERSION) {
        fail(ERROR_CODES.versionMismatch, 'Qualification metadata version does not match the resolver', details);
    }
    if (
        metadata.packageName !== expected.packageName ||
        metadata.target !== expected.target ||
        !same(metadata.runtime, expected.runtime)
    ) {
        fail(ERROR_CODES.wrongTarget, 'Qualification metadata target does not match the selected runtime', details);
    }
    if (
        metadata.schemaVersion !== 1 ||
        metadata.tool.name !== TOOL_NAME ||
        metadata.tool.engineDigest !== ENGINE_DIGEST ||
        metadata.binary.path !== expected.binaryPath ||
        metadata.binary.bytes !== expected.bytes ||
        metadata.binary.sha256 !== expected.sha256 ||
        metadata.knownAnswer.fixture !== 'core-and-sparql' ||
        metadata.knownAnswer.responseBytes !== expected.responseBytes ||
        metadata.knownAnswer.responseSha256 !== expected.responseSha256
    ) {
        fail(
            ERROR_CODES.metadataInvalid,
            'Qualification metadata does not match the audited distribution contract',
            details,
        );
    }
}

function inspectAvailable(options = {}) {
    const runtime = options.runtime ?? detectRuntime();
    const expected = selectExpected(runtime);
    if (expected.sha256 === null) {
        fail(
            ERROR_CODES.notMinted,
            `No qualified erden-shacl binary has been minted for ${describePlatform(expected.runtime)} yet`,
            {
                expectedPackage: expected.packageName,
                runtime,
            },
        );
    }
    const located = (options.locatePackage ?? defaultLocatePackage)(expected.packageName);
    const candidates = located === undefined ? [] : Array.isArray(located) ? located : [located];
    if (candidates.length === 0) {
        fail(ERROR_CODES.packageMissing, 'The compatible optional platform package is not installed', {
            expectedPackage: expected.packageName,
            runtime,
        });
    }
    if (candidates.length !== 1) {
        fail(ERROR_CODES.ambiguousPackage, 'More than one compatible platform package candidate is active', {
            expectedPackage: expected.packageName,
            candidateCount: candidates.length,
            runtime,
        });
    }
    let packageRoot;
    try {
        packageRoot = realpathSync(resolve(String(candidates[0])));
    } catch {
        fail(ERROR_CODES.packageMissing, 'The compatible platform package root is missing', {
            expectedPackage: expected.packageName,
            runtime,
        });
    }
    const details = { expectedPackage: expected.packageName, packageRoot, runtime };
    assertPlainFile(resolve(packageRoot, 'package.json'), 'Platform package manifest', details, true);
    assertPlainFile(resolve(packageRoot, 'metadata.json'), 'Qualification metadata', details, true);
    const manifest = readJson(resolve(packageRoot, 'package.json'), 'Platform package manifest', details);
    const metadata = readJson(resolve(packageRoot, 'metadata.json'), 'Qualification metadata', details);
    if (isRecord(manifest)) {
        details.actualPackage = typeof manifest.name === 'string' ? manifest.name : undefined;
        details.actualVersion = typeof manifest.version === 'string' ? manifest.version : undefined;
    }
    validateManifest(manifest, expected, details);
    if (!isRecord(metadata) || !isRecord(metadata.binary) || typeof metadata.binary.path !== 'string') {
        fail(ERROR_CODES.metadataInvalid, 'Qualification metadata shape is invalid', details);
    }
    const declared = resolve(packageRoot, metadata.binary.path);
    if (!inside(packageRoot, declared)) {
        fail(ERROR_CODES.pathEscape, 'Declared binary path escapes the platform package', details);
    }
    validateMetadata(metadata, expected, details);
    const stat = assertPlainFile(declared, 'SHACL engine binary', details);
    details.actualSize = stat.size;
    const binaryPath = realpathSync(declared);
    if (!inside(packageRoot, binaryPath)) {
        fail(ERROR_CODES.pathEscape, 'SHACL engine binary resolves outside the platform package', details);
    }
    if (runtime.platform !== 'win32' && (stat.mode & 0o111) === 0) {
        fail(ERROR_CODES.binaryNotExecutable, 'SHACL engine binary is not executable', details);
    }
    if (stat.size !== expected.bytes) {
        fail(ERROR_CODES.binarySizeMismatch, 'SHACL engine binary byte size does not match qualification', details);
    }
    const digest = sha256(readFileSync(binaryPath));
    details.actualDigest = digest;
    if (digest !== expected.sha256) {
        fail(ERROR_CODES.binaryDigestMismatch, 'SHACL engine binary SHA-256 does not match qualification', details);
    }
    return Object.freeze({ binaryPath, digest, expected, manifest, metadata, runtime, size: stat.size });
}

function toolOf(available) {
    return Object.freeze({
        name: TOOL_NAME,
        version: TOOL_VERSION,
        engineDigest: ENGINE_DIGEST,
        executableDigest: available.digest,
    });
}

function knownAnswer(available) {
    const details = { expectedPackage: available.expected.packageName, actualDigest: available.digest };
    let raw;
    try {
        if (lstatSync(KNOWN_ANSWER_FIXTURE_URL).isSymbolicLink()) {
            throw new Error('symbolic link');
        }
        raw = readFileSync(KNOWN_ANSWER_FIXTURE_URL, 'utf8');
    } catch {
        fail(
            ERROR_CODES.selfTestFailed,
            'Bundled SHACL engine known-answer fixture is missing or not a regular file',
            details,
        );
    }
    if (sha256(raw) !== KNOWN_ANSWER_FIXTURE_DIGEST) {
        fail(
            ERROR_CODES.selfTestFailed,
            'Bundled SHACL engine known-answer fixture does not match the qualified fixture',
            details,
        );
    }
    const request = JSON.parse(raw);
    if (request.requiredTool?.executableDigest !== PLACEHOLDER_DIGEST) {
        fail(ERROR_CODES.selfTestFailed, 'Bundled SHACL engine known-answer fixture shape is invalid', details);
    }
    request.requiredTool = toolOf(available);
    const child = spawnSync(available.binaryPath, [], {
        encoding: 'utf8',
        input: `${JSON.stringify(request)}\n`,
        maxBuffer: 16_777_216,
        timeout: 30_000,
        windowsHide: true,
    });
    const output = child.stdout ?? '';
    const outputDigest = sha256(output);
    if (
        child.error !== undefined ||
        child.status !== 0 ||
        child.stderr !== '' ||
        Buffer.byteLength(output) !== available.expected.responseBytes ||
        outputDigest !== available.expected.responseSha256
    ) {
        fail(
            ERROR_CODES.selfTestFailed,
            'Bundled SHACL engine known-answer response did not match the trusted result',
            {
                ...details,
                actualResponseBytes: Buffer.byteLength(output),
                actualResponseDigest: outputDigest,
            },
        );
    }
    return Object.freeze({
        fixture: 'core-and-sparql',
        responseBytes: Buffer.byteLength(output),
        responseDigest: outputDigest,
        status: 'passed',
    });
}

export function resolveBundledShaclEngine(options = {}) {
    const available = inspectAvailable(options);
    return Object.freeze({ path: available.binaryPath, tool: toolOf(available) });
}

export function runBundledShaclEngineKnownAnswer(options = {}) {
    return knownAnswer(inspectAvailable(options));
}

export function inspectBundledShaclEngine(options = {}) {
    let expected;
    try {
        expected = selectExpected(options.runtime ?? detectRuntime());
        const available = inspectAvailable(options);
        const selfTest = options.runSelfTest === true ? knownAnswer(available) : Object.freeze({ status: 'not-run' });
        return Object.freeze({
            availability: 'available',
            expectedPlatformPackage: expected.packageName,
            actualPlatformPackage: available.manifest.name,
            packageVersion: available.manifest.version,
            toolVersion: TOOL_VERSION,
            path: available.binaryPath,
            size: available.size,
            digest: available.digest,
            target: available.metadata.target,
            tool: toolOf(available),
            selfTest,
        });
    } catch (error) {
        if (!(error instanceof BundledShaclEngineError)) {
            throw error;
        }
        return Object.freeze({
            availability: 'unavailable',
            expectedPlatformPackage: expected?.packageName ?? error.details.expectedPackage,
            actualPlatformPackage: error.details.actualPackage,
            packageVersion: error.details.actualVersion,
            toolVersion: undefined,
            path: undefined,
            size: error.details.actualSize,
            digest: error.details.actualDigest,
            target: undefined,
            tool: undefined,
            failureCode: error.code,
            supportedPlatforms: error.details.supported,
            selfTest: Object.freeze({ status: 'failed', failureCode: error.code }),
        });
    }
}
