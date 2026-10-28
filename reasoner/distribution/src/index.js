import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUALIFIED_REASONER_ARTIFACTS } from './artifacts.js';

export { QUALIFIED_REASONER_ARTIFACTS };

export const PACKAGE_VERSION = '0.3.0+purrdf.0.12.0.dfb1df7';
export const TOOL_VERSION = PACKAGE_VERSION;

const ADAPTER_DIGEST = 'sha256:b923a50baa9b12d132a5d3088d7cc5ee54b6a3b8ade1a2126027720ace476001';
const CALCULUS_DIGEST = 'sha256:fc444990f8c8c180df359a6beca8811fa3f4f2382f590fcb2f2a56957c19529c';
const PROFILE_DIGEST = 'sha256:ff36438e2500497ed8dc8b955cf7033c9bed781495c214793c0ba6859bbede5f';
const PROOF_CHECKER_DIGEST = 'sha256:945ef6fb5e692112780308adccbb02695ef6a83183af6416284642ed475dee44';
const KNOWN_ANSWER_FIXTURE_DIGEST = 'sha256:087605ba4df0721d74ec5852ef8264c9dd4768055c65f7d061d4b811cc39b9c0';
/**
 * The tool every request to this version names (with the executable's own digest added), and every answer must carry:
 * qualification, the mint and the platform packages' metadata take it from here.
 */
export const REASONER_TOOL = Object.freeze({
    name: 'erden-reasoner',
    version: TOOL_VERSION,
    adapterDigest: ADAPTER_DIGEST,
    calculusDigest: CALCULUS_DIGEST,
});
const NODE_ENGINE_RANGE = '^24';
const KNOWN_ANSWER_FIXTURE_URL = new URL('../fixtures/known-answer.request.json', import.meta.url);
const require = createRequire(import.meta.url);

/**
 * Whether this version is released on every platform: each has the binary and known-answer pins the mint wrote
 * (`./artifacts.js`, from the tools release workflow, `release.yml`). No binary is committed. A
 * platform without pins runs a reasoner built from this repository's source (`pnpm run reasoner:build`), trusted by
 * the identity it answers with and the known-answer test, not by pins.
 */
export const REASONER_RELEASED = Object.values(QUALIFIED_REASONER_ARTIFACTS).every(released);

/** Whether a platform's binary is pinned, so its platform package is used instead of a source build. */
function released(expected) {
    return expected.sha256 !== null;
}

/** The platform package name a source build reports in place of an installed platform package. */
export const SOURCE_BUILD = 'source-build';

/** Where `cargo build --release --locked` in `reasoner/` writes the reasoner, from this file in a checkout. */
const SOURCE_BUILD_URLS = Object.freeze({
    posix: new URL('../../target/release/erden-reasoner', import.meta.url),
    win32: new URL('../../target/release/erden-reasoner.exe', import.meta.url),
});

export const ERROR_CODES = Object.freeze({
    ambiguousPackage: 'AMBIGUOUS_PACKAGE',
    binaryDigestMismatch: 'BINARY_DIGEST_MISMATCH',
    binaryMissing: 'BINARY_MISSING',
    binaryNotExecutable: 'BINARY_NOT_EXECUTABLE',
    binaryNotRegular: 'BINARY_NOT_REGULAR',
    binarySizeMismatch: 'BINARY_SIZE_MISMATCH',
    metadataInvalid: 'PACKAGE_METADATA_INVALID',
    packageMissing: 'PACKAGE_MISSING',
    pathEscape: 'PATH_ESCAPE',
    selfTestFailed: 'SELF_TEST_FAILED',
    sourceBuildMissing: 'SOURCE_BUILD_MISSING',
    symlinkDisallowed: 'SYMLINK_DISALLOWED',
    unsupportedLibc: 'UNSUPPORTED_LIBC',
    unsupportedPlatform: 'UNSUPPORTED_PLATFORM',
    versionMismatch: 'PACKAGE_VERSION_MISMATCH',
    wrongTarget: 'WRONG_TARGET',
});

const EXPECTED = QUALIFIED_REASONER_ARTIFACTS;

export class BundledReasonerError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'BundledReasonerError';
        this.code = code;
        this.details = Object.freeze({ ...details });
    }
}

function fail(code, message, details) {
    throw new BundledReasonerError(code, message, details);
}

function sha256(value) {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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

function runtimeKey(runtime) {
    return runtime.libc === undefined
        ? `${runtime.platform}:${runtime.arch}`
        : `${runtime.platform}:${runtime.arch}:${runtime.libc}`;
}

export function detectRuntime() {
    if (process.platform !== 'linux') {
        return Object.freeze({ platform: process.platform, arch: process.arch });
    }
    const report = process.report?.getReport();
    const header = report && typeof report === 'object' ? report.header : undefined;
    const libc =
        header && typeof header === 'object' && typeof header.glibcVersionRuntime === 'string' ? 'glibc' : 'unknown';
    return Object.freeze({ platform: process.platform, arch: process.arch, libc });
}

function describePlatform({ os, cpu, libc }) {
    return libc === undefined ? `${os} ${cpu}` : `${os} ${cpu} (${libc})`;
}

/** Every runtime with a qualified bundled reasoner, as refusals name them (for example `linux x64 (glibc)`). */
export const SUPPORTED_PLATFORMS = Object.freeze(
    Object.values(EXPECTED).map(({ runtime }) => describePlatform(runtime)),
);

function refuse(code, refused, runtime) {
    return fail(
        code,
        `No qualified bundled reasoner exists for ${refused}; supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
        { runtime, supported: SUPPORTED_PLATFORMS },
    );
}

function selectExpected(runtime) {
    if (runtime.platform === 'linux' && runtime.libc !== 'glibc') {
        // detectRuntime reports any other C library, musl included, as 'unknown'.
        return refuse(ERROR_CODES.unsupportedLibc, `linux ${runtime.arch} without glibc`, runtime);
    }
    const expected = Object.hasOwn(EXPECTED, runtimeKey(runtime)) ? EXPECTED[runtimeKey(runtime)] : undefined;
    if (expected === undefined) {
        const refused = describePlatform({ os: runtime.platform, cpu: runtime.arch, libc: runtime.libc });
        return refuse(ERROR_CODES.unsupportedPlatform, refused, runtime);
    }
    return expected;
}

function defaultLocatePackage(packageName) {
    try {
        return dirname(realpathSync(require.resolve(`${packageName}/package.json`)));
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
            return undefined;
        }
        throw error;
    }
}

function normalizeCandidates(located) {
    return located === undefined ? [] : Array.isArray(located) ? located : [located];
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function strings(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function stringField(record, key) {
    return isRecord(record) && typeof record[key] === 'string' ? record[key] : undefined;
}

function collectActualContext(manifest, metadata, details) {
    if (isRecord(manifest)) {
        details.actualPackage = stringField(manifest, 'name');
        details.actualVersion = stringField(manifest, 'version');
    }
    if (isRecord(metadata)) {
        details.actualMetadataPackage = stringField(metadata, 'packageName');
        details.actualMetadataVersion = stringField(metadata, 'packageVersion');
        details.actualTarget = stringField(metadata, 'target');
        if (isRecord(metadata.tool)) {
            details.actualToolVersion = stringField(metadata.tool, 'version');
        }
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
        !strings(manifest.os, [expected.runtime.os]) ||
        !strings(manifest.cpu, [expected.runtime.cpu]) ||
        !strings(manifest.libc, expected.runtime.libc === undefined ? undefined : [expected.runtime.libc])
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
        !strings(manifest.files, [
            'bin',
            'metadata.json',
            'README.md',
            'LICENSE',
            'NOTICE',
            'THIRD-PARTY-NOTICES.md',
        ]) ||
        !strings(manifest.bin, { 'erden-reasoner': expected.binaryPath }) ||
        !strings(manifest.engines, { node: NODE_ENGINE_RANGE })
    ) {
        fail(ERROR_CODES.metadataInvalid, 'Platform package manifest contract is invalid', details);
    }
}

function validateMetadataShape(metadata, expected, details) {
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
        typeof metadata.schemaVersion !== 'number' ||
        typeof metadata.packageName !== 'string' ||
        typeof metadata.packageVersion !== 'string' ||
        typeof metadata.target !== 'string' ||
        !hasExactKeys(metadata.tool, ['name', 'version', 'adapterDigest', 'calculusDigest']) ||
        !['name', 'version', 'adapterDigest', 'calculusDigest'].every(
            (key) => typeof metadata.tool[key] === 'string',
        ) ||
        !hasExactKeys(metadata.runtime, runtimeKeys) ||
        !runtimeKeys.every((key) => typeof metadata.runtime[key] === 'string') ||
        !hasExactKeys(metadata.binary, ['path', 'bytes', 'sha256']) ||
        typeof metadata.binary.path !== 'string' ||
        !Number.isSafeInteger(metadata.binary.bytes) ||
        typeof metadata.binary.sha256 !== 'string' ||
        !hasExactKeys(metadata.knownAnswer, ['fixture', 'responseBytes', 'responseSha256']) ||
        typeof metadata.knownAnswer.fixture !== 'string' ||
        !Number.isSafeInteger(metadata.knownAnswer.responseBytes) ||
        typeof metadata.knownAnswer.responseSha256 !== 'string'
    ) {
        fail(ERROR_CODES.metadataInvalid, 'Qualification metadata shape is invalid', details);
    }
}

function validateMetadata(metadata, expected, details) {
    if (metadata.packageVersion !== PACKAGE_VERSION || metadata.tool.version !== TOOL_VERSION) {
        fail(ERROR_CODES.versionMismatch, 'Qualification metadata version does not match the resolver', details);
    }
    if (
        metadata.packageName !== expected.packageName ||
        metadata.target !== expected.target ||
        !strings(metadata.runtime, expected.runtime)
    ) {
        fail(ERROR_CODES.wrongTarget, 'Qualification metadata target does not match the selected runtime', details);
    }
    if (
        metadata.schemaVersion !== 1 ||
        metadata.tool.name !== 'erden-reasoner' ||
        metadata.tool.adapterDigest !== ADAPTER_DIGEST ||
        metadata.tool.calculusDigest !== CALCULUS_DIGEST ||
        metadata.binary.path !== expected.binaryPath ||
        metadata.binary.bytes !== expected.bytes ||
        metadata.binary.sha256 !== expected.sha256 ||
        metadata.knownAnswer.fixture !== 'subclass-type' ||
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

function inside(root, path) {
    const fragment = relative(root, path);
    return fragment !== '..' && !fragment.startsWith(`..${sep}`) && !isAbsolute(fragment);
}

/**
 * The reasoner built from source that stands in for an unreleased version: `ERDEN_REASONER_BIN` when set (absolute),
 * else the build `pnpm run reasoner:build` writes in a checkout. Never consulted for a released platform.
 */
function sourceBuildPath(runtime, options) {
    const configured = options.sourceBuild ?? process.env.ERDEN_REASONER_BIN;
    if (configured !== undefined && configured !== '') {
        return isAbsolute(configured) ? configured : undefined;
    }
    return fileURLToPath(runtime.platform === 'win32' ? SOURCE_BUILD_URLS.win32 : SOURCE_BUILD_URLS.posix);
}

function inspectSourceBuild(runtime, expected, options) {
    const details = { expectedPackage: SOURCE_BUILD, runtime };
    const path = sourceBuildPath(runtime, options);
    function missing() {
        return fail(
            ERROR_CODES.sourceBuildMissing,
            `Reasoner ${TOOL_VERSION} has no released binary yet (release.yml); build it from source with \`pnpm run reasoner:build\`, or set ERDEN_REASONER_BIN to the absolute path of a reasoner built from this source`,
            details,
        );
    }
    if (path === undefined) {
        return missing();
    }
    let stat;
    try {
        stat = lstatSync(path);
    } catch {
        return missing();
    }
    if (stat.isSymbolicLink()) {
        fail(ERROR_CODES.symlinkDisallowed, 'Reasoner source build must not be a symbolic link', details);
    }
    if (!stat.isFile()) {
        fail(ERROR_CODES.binaryNotRegular, 'Reasoner source build must be a regular file', details);
    }
    details.actualSize = stat.size;
    if (runtime.platform !== 'win32' && (stat.mode & 0o111) === 0) {
        fail(ERROR_CODES.binaryNotExecutable, 'Reasoner source build is not executable', details);
    }
    let binaryBytes;
    try {
        binaryBytes = readFileSync(path);
    } catch {
        return missing();
    }
    const digest = sha256(binaryBytes);
    details.actualDigest = digest;
    const tool = Object.freeze({
        name: 'erden-reasoner',
        version: TOOL_VERSION,
        adapterDigest: ADAPTER_DIGEST,
        calculusDigest: CALCULUS_DIGEST,
    });
    return Object.freeze({
        binaryPath: realpathSync(path),
        digest,
        expected,
        manifest: Object.freeze({ name: SOURCE_BUILD, version: PACKAGE_VERSION }),
        metadata: Object.freeze({ target: expected.target, tool }),
        packageRoot: undefined,
        runtime,
        size: stat.size,
    });
}

function inspectAvailable(options = {}) {
    const runtime = options.runtime ?? detectRuntime();
    const expected = selectExpected(runtime);
    if (!released(expected)) {
        return inspectSourceBuild(runtime, expected, options);
    }
    const locatePackage = options.locatePackage ?? defaultLocatePackage;
    const candidates = normalizeCandidates(locatePackage(expected.packageName));
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
    if (typeof candidates[0] !== 'string') {
        fail(ERROR_CODES.packageMissing, 'The compatible platform package root is invalid', {
            expectedPackage: expected.packageName,
            runtime,
        });
    }
    let packageRoot;
    try {
        packageRoot = realpathSync(resolve(candidates[0]));
    } catch {
        fail(ERROR_CODES.packageMissing, 'The compatible platform package root is missing', {
            expectedPackage: expected.packageName,
            runtime,
        });
    }
    const details = { expectedPackage: expected.packageName, packageRoot, runtime };
    const manifestPath = resolve(packageRoot, 'package.json');
    const metadataPath = resolve(packageRoot, 'metadata.json');
    assertPlainFile(manifestPath, 'Platform package manifest', details, true);
    assertPlainFile(metadataPath, 'Qualification metadata', details, true);
    const manifest = readJson(manifestPath, 'Platform package manifest', details);
    const metadata = readJson(metadataPath, 'Qualification metadata', details);
    collectActualContext(manifest, metadata, details);
    validateManifest(manifest, expected, details);
    validateMetadataShape(metadata, expected, details);
    const declaredBinary = resolve(packageRoot, metadata.binary.path);
    if (!inside(packageRoot, declaredBinary)) {
        fail(ERROR_CODES.pathEscape, 'Declared binary path escapes the platform package', details);
    }
    validateMetadata(metadata, expected, details);
    const stat = assertPlainFile(declaredBinary, 'Reasoner binary', details);
    details.actualSize = stat.size;
    let binaryPath;
    try {
        binaryPath = realpathSync(declaredBinary);
    } catch {
        fail(ERROR_CODES.binaryMissing, 'Reasoner binary could not be resolved', details);
    }
    if (!inside(packageRoot, binaryPath)) {
        fail(ERROR_CODES.pathEscape, 'Reasoner binary resolves outside the platform package', details);
    }
    if (runtime.platform !== 'win32' && (stat.mode & 0o111) === 0) {
        fail(ERROR_CODES.binaryNotExecutable, 'Reasoner binary is not executable', details);
    }
    if (stat.size !== expected.bytes) {
        fail(ERROR_CODES.binarySizeMismatch, 'Reasoner binary byte size does not match qualification', details);
    }
    let binaryBytes;
    try {
        binaryBytes = readFileSync(binaryPath);
    } catch {
        fail(ERROR_CODES.binaryMissing, 'Reasoner binary could not be read', details);
    }
    const digest = sha256(binaryBytes);
    details.actualDigest = digest;
    if (digest !== expected.sha256) {
        fail(ERROR_CODES.binaryDigestMismatch, 'Reasoner binary SHA-256 does not match qualification', details);
    }
    return Object.freeze({ binaryPath, digest, expected, manifest, metadata, packageRoot, runtime, size: stat.size });
}

function requiredToolOf(available) {
    return Object.freeze({
        name: available.metadata.tool.name,
        version: available.metadata.tool.version,
        executableDigest: available.digest,
        adapterDigest: available.metadata.tool.adapterDigest,
        calculusDigest: available.metadata.tool.calculusDigest,
    });
}

function readKnownAnswerTemplate(details) {
    let stat;
    try {
        stat = lstatSync(KNOWN_ANSWER_FIXTURE_URL);
    } catch {
        fail(ERROR_CODES.selfTestFailed, 'Bundled reasoner known-answer fixture is missing', details);
    }
    if (stat.isSymbolicLink()) {
        fail(ERROR_CODES.selfTestFailed, 'Bundled reasoner known-answer fixture must not be a symbolic link', details);
    }
    if (!stat.isFile()) {
        fail(ERROR_CODES.selfTestFailed, 'Bundled reasoner known-answer fixture must be a regular file', details);
    }
    let raw;
    try {
        raw = readFileSync(KNOWN_ANSWER_FIXTURE_URL, 'utf8');
    } catch {
        fail(ERROR_CODES.selfTestFailed, 'Bundled reasoner known-answer fixture could not be read', details);
    }
    let template;
    try {
        template = JSON.parse(raw);
    } catch {
        fail(ERROR_CODES.selfTestFailed, 'Bundled reasoner known-answer fixture is invalid JSON', details);
    }
    if (
        !hasExactKeys(template, [
            'kind',
            'limits',
            'ontology',
            'operation',
            'profile',
            'protocolVersion',
            'requestId',
            'requiredTool',
        ]) ||
        template.kind !== 'ReasonerRequest' ||
        template.protocolVersion !== 1 ||
        template.requestId !== 'known-answer:subclass-type' ||
        template.operation !== 'classify-and-materialize' ||
        !hasExactKeys(template.limits, ['maxInferences', 'maxInputAxioms', 'maxWallTimeMs']) ||
        !['maxInferences', 'maxInputAxioms', 'maxWallTimeMs'].every(
            (key) => Number.isSafeInteger(template.limits[key]) && template.limits[key] > 0,
        ) ||
        !hasExactKeys(template.profile, ['digest', 'id']) ||
        !['digest', 'id'].every((key) => typeof template.profile[key] === 'string') ||
        !hasExactKeys(template.requiredTool, [
            'adapterDigest',
            'calculusDigest',
            'executableDigest',
            'name',
            'version',
        ]) ||
        !['adapterDigest', 'calculusDigest', 'executableDigest', 'name', 'version'].every(
            (key) => typeof template.requiredTool[key] === 'string',
        ) ||
        !hasExactKeys(template.ontology, ['axioms', 'digest', 'sources']) ||
        typeof template.ontology.digest !== 'string' ||
        !Array.isArray(template.ontology.axioms) ||
        !Array.isArray(template.ontology.sources)
    ) {
        fail(ERROR_CODES.selfTestFailed, 'Bundled reasoner known-answer fixture shape is invalid', details);
    }
    if (sha256(raw) !== KNOWN_ANSWER_FIXTURE_DIGEST) {
        fail(
            ERROR_CODES.selfTestFailed,
            'Bundled reasoner known-answer fixture does not match the qualified fixture',
            details,
        );
    }
    return template;
}

function knownAnswer(available) {
    const details = {
        expectedPackage: available.expected.packageName,
        actualPackage: available.manifest.name,
        actualVersion: available.manifest.version,
        actualToolVersion: available.metadata.tool.version,
        actualTarget: available.metadata.target,
        actualSize: available.size,
        actualDigest: available.digest,
    };
    const template = readKnownAnswerTemplate(details);
    const request = {
        ...template,
        requiredTool: {
            adapterDigest: ADAPTER_DIGEST,
            calculusDigest: CALCULUS_DIGEST,
            executableDigest: available.digest,
            name: 'erden-reasoner',
            version: TOOL_VERSION,
        },
    };
    const child = spawnSync(available.binaryPath, [], {
        encoding: 'utf8',
        input: `${JSON.stringify(request)}\n`,
        maxBuffer: 16777216,
        timeout: 10000,
        windowsHide: true,
    });
    const output = child.stdout ?? '';
    const outputDigest = sha256(output);
    // A released binary's answer is pinned byte for byte; a source build's names its own executable digest, so it is
    // held to its identity below instead.
    const pinned = available.expected.responseSha256 !== null;
    if (
        child.error !== undefined ||
        child.status !== 0 ||
        child.stderr !== '' ||
        (pinned &&
            (Buffer.byteLength(output) !== available.expected.responseBytes ||
                outputDigest !== available.expected.responseSha256))
    ) {
        fail(ERROR_CODES.selfTestFailed, 'Bundled reasoner known-answer response did not match the trusted result', {
            ...details,
            actualResponseBytes: Buffer.byteLength(output),
            actualResponseDigest: outputDigest,
        });
    }
    let response;
    try {
        response = JSON.parse(output);
    } catch {
        fail(ERROR_CODES.selfTestFailed, 'Bundled reasoner known-answer response was not JSON', details);
    }
    if (
        `${JSON.stringify(response)}\n` !== output ||
        response.protocolVersion !== 1 ||
        response.profile?.digest !== PROFILE_DIGEST ||
        response.result?.outcome !== 'decided' ||
        response.result?.completeness !== 'complete' ||
        response.result?.consistency !== 'consistent' ||
        response.result?.certificate?.checked !== true ||
        response.result.certificate.proofCheckerDigest !== PROOF_CHECKER_DIGEST ||
        response.tool?.name !== 'erden-reasoner' ||
        response.tool.version !== TOOL_VERSION ||
        response.tool.executableDigest !== available.digest ||
        response.tool.adapterDigest !== ADAPTER_DIGEST ||
        response.tool.calculusDigest !== CALCULUS_DIGEST
    ) {
        fail(
            ERROR_CODES.selfTestFailed,
            'Bundled reasoner known-answer response failed protocol trust checks',
            details,
        );
    }
    return Object.freeze({
        fixture: 'subclass-type',
        responseBytes: Buffer.byteLength(output),
        responseDigest: outputDigest,
        status: 'passed',
    });
}

export function resolveBundledReasoner(options = {}) {
    return inspectAvailable(options).binaryPath;
}

export function resolveBundledReasonerArtifact(options = {}) {
    const available = inspectAvailable(options);
    return Object.freeze({ path: available.binaryPath, requiredTool: requiredToolOf(available) });
}

export function runBundledReasonerKnownAnswer(options = {}) {
    return knownAnswer(inspectAvailable(options));
}

export function inspectBundledReasoner(options = {}) {
    let expected;
    try {
        expected = selectExpected(options.runtime ?? detectRuntime());
        const available = inspectAvailable(options);
        const selfTest = options.runSelfTest === true ? knownAnswer(available) : Object.freeze({ status: 'not-run' });
        return Object.freeze({
            availability: 'available',
            expectedPlatformPackage: released(expected) ? expected.packageName : SOURCE_BUILD,
            actualPlatformPackage: available.manifest.name,
            packageVersion: available.manifest.version,
            toolVersion: available.metadata.tool.version,
            path: available.binaryPath,
            size: available.size,
            digest: available.digest,
            target: available.metadata.target,
            requiredTool: requiredToolOf(available),
            selfTest,
        });
    } catch (error) {
        if (!(error instanceof BundledReasonerError)) {
            throw error;
        }
        return Object.freeze({
            availability: 'unavailable',
            expectedPlatformPackage:
                expected === undefined
                    ? error.details.expectedPackage
                    : released(expected)
                      ? expected.packageName
                      : SOURCE_BUILD,
            actualPlatformPackage: error.details.actualPackage ?? error.details.actualMetadataPackage,
            packageVersion: error.details.actualVersion ?? error.details.actualMetadataVersion,
            toolVersion: error.details.actualToolVersion,
            path: undefined,
            size: error.details.actualSize,
            digest: error.details.actualDigest,
            target: error.details.actualTarget,
            requiredTool: undefined,
            failureCode: error.code,
            supportedPlatforms: error.details.supported,
            selfTest: Object.freeze({ status: 'failed', failureCode: error.code }),
        });
    }
}
