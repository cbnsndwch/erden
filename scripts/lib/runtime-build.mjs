import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Builds the runtime package in the current directory with `tsc -p tsconfig.runtime.json` and refuses any emitted file
 * set other than the one `runtimeFiles` (package path to sorted `dist/` paths) names for it.
 */
export function buildRuntimePackage(runtimeFiles) {
    const packageRoot = resolve(process.cwd());
    const packagePath = relative(workspaceRoot, packageRoot).replaceAll('\\', '/');
    const expected = runtimeFiles.get(packagePath);
    if (expected === undefined) {
        throw new Error(`Refusing to build an unrecognized runtime package: ${packagePath}`);
    }

    const dist = resolve(packageRoot, 'dist');
    if (dirname(dist) !== packageRoot || relative(workspaceRoot, dist).startsWith('..')) {
        throw new Error('Refusing to clean a runtime output outside its exact package root');
    }
    rmSync(dist, { recursive: true, force: true });

    const tsc = resolve(workspaceRoot, 'node_modules/typescript/bin/tsc');
    const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.runtime.json'], {
        cwd: packageRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
        process.stderr.write(result.stderr || result.stdout || 'TypeScript runtime build failed\n');
        process.exit(result.status ?? 1);
    }

    function walk(directory) {
        return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
            const path = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                return walk(path);
            }
            return [relative(packageRoot, path).replaceAll('\\', '/')];
        });
    }
    const actual = existsSync(dist) ? walk(dist).sort() : [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${packagePath} emitted an unexpected runtime file set: ${actual.join(', ')}`);
    }
}
