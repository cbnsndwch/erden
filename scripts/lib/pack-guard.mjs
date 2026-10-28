import { RUNTIME_DIST_FILES } from './runtime-package-files.mjs';

const SHACL_PLATFORM = /^shacl\/(?:linux-x64-gnu|linux-arm64-gnu|darwin-arm64|win32-x64-msvc)$/u;
const REASONER_PLATFORM = /^reasoner\/(?:linux-x64-gnu|linux-arm64-gnu|darwin-arm64|win32-x64-msvc)$/u;

/** The exact pack of a resolver or platform package, or undefined for a source or runtime package. */
function openExactAllowlist(packagePath, options) {
    if (packagePath === 'shacl/distribution') {
        return [
            'LICENSE',
            'NOTICE',
            'README.md',
            'fixtures/known-answer.request.json',
            'package.json',
            'src/artifacts.js',
            'src/index.d.ts',
            'src/index.js',
        ];
    }
    if (SHACL_PLATFORM.test(packagePath) || REASONER_PLATFORM.test(packagePath)) {
        const tool = packagePath.startsWith('shacl/') ? 'erden-shacl' : 'erden-reasoner';
        return [
            'LICENSE',
            'NOTICE',
            'README.md',
            'THIRD-PARTY-NOTICES.md',
            ...(options.binaryInstalled === false
                ? []
                : [`bin/${tool}${packagePath.endsWith('/win32-x64-msvc') ? '.exe' : ''}`]),
            'metadata.json',
            'package.json',
        ];
    }
    if (packagePath === 'reasoner/distribution') {
        return [
            'LICENSE',
            'NOTICE',
            'README.md',
            'fixtures/known-answer.request.json',
            'package.json',
            'src/artifacts.js',
            'src/index.d.ts',
            'src/index.js',
        ];
    }
    return undefined;
}

/**
 * The open tree's pack rules. A repository with more packages passes rules with its own `runtimeFiles`,
 * `exactAllowlist(packagePath, options)`, `allowedPath(packagePath, path, files)` and
 * `extraFailures(packagePath, packedPaths, files)`, each consulted after (or instead of) the open ones.
 */
export const OPEN_PACK_RULES = Object.freeze({
    runtimeFiles: RUNTIME_DIST_FILES,
    exactAllowlist: openExactAllowlist,
    allowedPath: () => false,
    extraFailures: () => [],
});

/**
 * `options.binaryInstalled` (default true) is false for an engine platform package whose binary is not installed:
 * the binaries are never committed, so such a pack carries only the pins (built from source by
 * shacl/qualification/build-from-source.mjs, or shipped by the tools release, TS-6).
 */
export function validatePackFiles(packagePath, files, options = {}, rules = OPEN_PACK_RULES) {
    const failures = [];
    const packedPaths = files.map(({ path }) => path.replaceAll('\\', '/'));
    const exactAllowlist = rules.exactAllowlist(packagePath, options);
    if (exactAllowlist !== undefined) {
        const actual = [...packedPaths].sort();
        if (JSON.stringify(actual) !== JSON.stringify(exactAllowlist)) {
            failures.push(
                `${packagePath} pack must contain exactly ${exactAllowlist.join(', ')} (found ${actual.join(', ')})`,
            );
        }
        return failures;
    }
    const runtimeFiles = rules.runtimeFiles.get(packagePath);
    const runtimePackage = runtimeFiles !== undefined;
    for (const path of packedPaths) {
        const lowerPath = path.toLowerCase();
        if (
            lowerPath === 'test' ||
            lowerPath.startsWith('test/') ||
            lowerPath === 'legacy' ||
            lowerPath.startsWith('legacy/')
        ) {
            failures.push(`${packagePath} pack contains forbidden path ${path}`);
            continue;
        }
        if (
            path !== 'package.json' &&
            !path.startsWith('src/') &&
            !(runtimePackage && runtimeFiles.includes(path)) &&
            !rules.allowedPath(packagePath, path, files) &&
            !/^(?:licen[cs]e|notice|readme)(?:\.[^/]*)?$/i.test(path)
        ) {
            failures.push(`${packagePath} pack contains path outside its src allowlist: ${path}`);
        }
    }
    if (!packedPaths.includes('package.json')) {
        failures.push(`${packagePath} pack is missing package.json`);
    }
    if (!packedPaths.includes('src/index.ts')) {
        failures.push(`${packagePath} pack is missing src/index.ts`);
    }
    if (runtimePackage) {
        const actualRuntime = packedPaths.filter((path) => path.startsWith('dist/')).sort();
        if (JSON.stringify(actualRuntime) !== JSON.stringify(runtimeFiles)) {
            failures.push(`${packagePath} pack must contain its exact generated runtime file set`);
        }
    }
    if (packagePath === 'apps/cli' && !packedPaths.includes('dist/bin.js')) {
        failures.push('apps/cli pack is missing generated dist/bin.js');
    }
    failures.push(...rules.extraFailures(packagePath, packedPaths, files));
    return failures;
}
