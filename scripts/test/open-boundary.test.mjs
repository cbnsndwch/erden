import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    KNOWN_OPEN_BOUNDARY_VIOLATIONS,
    moduleSpecifiers,
    OPEN_LICENSES,
    openBoundaryFailures,
} from '../lib/open-boundary.mjs';
import { cleanupTestTempRoot, makeTestTempRoot } from '../lib/test-temp-root.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OPEN = OPEN_LICENSES[0];
const roots = [];

after(() => {
    for (const root of roots) {
        cleanupTestTempRoot(root);
    }
});

function write(root, path, text) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
}

/** A two-package workspace: open `@fixture/tool` and proprietary `@fixture/server`, plus any extra files. */
function workspace(files = {}, toolManifest = {}) {
    const root = makeTestTempRoot('erden-open-boundary-');
    roots.push(root);
    write(root, 'package.json', JSON.stringify({ name: 'fixture', private: true }));
    write(root, 'pnpm-workspace.yaml', "packages:\n    - 'packages/*'\n");
    write(root, 'packages/server/package.json', JSON.stringify({ name: '@fixture/server', license: 'UNLICENSED' }));
    write(root, 'packages/server/src/index.ts', 'export const secret = 1;\n');
    write(
        root,
        'packages/tool/package.json',
        JSON.stringify({ name: '@fixture/tool', license: OPEN, ...toolManifest }),
    );
    write(root, 'packages/tool/src/index.ts', 'export const open = 1;\n');
    for (const [path, text] of Object.entries(files)) {
        write(root, path, text);
    }
    return root;
}

describe('open-boundary guard', () => {
    it('passes the repository with exactly the known violations', () => {
        assert.deepEqual(openBoundaryFailures(repositoryRoot), []);
    });

    it('passes a clean workspace, including a proprietary package that depends on an open one', () => {
        const root = workspace({
            'packages/server/src/uses-tool.ts': "import { open } from '@fixture/tool';\n",
        });
        assert.deepEqual(openBoundaryFailures(root, []), []);
    });

    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        it(`refuses a proprietary package in ${field}`, () => {
            const root = workspace({}, { [field]: { '@fixture/server': 'workspace:*' } });
            assert.deepEqual(openBoundaryFailures(root, []), [
                'Open code must not depend on proprietary code: packages/tool/package.json -> @fixture/server',
            ]);
        });
    }

    for (const [label, source] of [
        ['a static import', "import { secret } from '@fixture/server';\n"],
        ['a deep import', "import { secret } from '@fixture/server/src/index.ts';\n"],
        ['a type-only import', "import type { Secret } from '@fixture/server';\n"],
        ['a re-export', "export * from '@fixture/server';\n"],
        ['a dynamic import', "const server = await import('@fixture/server');\n"],
        ['a type query', "type Server = typeof import('@fixture/server');\n"],
        ['a Vitest mock', "vi.mock('@fixture/server');\n"],
    ]) {
        it(`refuses ${label} of a proprietary package`, () => {
            const root = workspace({ 'packages/tool/test/leak.test.ts': source });
            assert.deepEqual(openBoundaryFailures(root, []), [
                'Open code must not depend on proprietary code: packages/tool/test/leak.test.ts -> @fixture/server',
            ]);
        });
    }

    it('refuses a relative import that leaves the open packages', () => {
        const root = workspace({
            'packages/tool/src/leak.ts': "import { secret } from '../../server/src/index.ts';\n",
        });
        assert.deepEqual(openBoundaryFailures(root, []), [
            'Open code must not depend on proprietary code: packages/tool/src/leak.ts -> packages/server/src/index.ts',
        ]);
    });

    it('allows relative imports into another open package and the shared test helper', () => {
        const root = workspace({
            'packages/tool/src/sibling.ts': "import { open } from './index.ts';\n",
            'packages/tool/test/helper.test.ts':
                "import { makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';\n",
        });
        assert.deepEqual(openBoundaryFailures(root, []), []);
    });

    it('accepts a listed violation and refuses a stale one', () => {
        const root = workspace({ 'packages/tool/src/leak.ts': "import { secret } from '@fixture/server';\n" });
        assert.deepEqual(openBoundaryFailures(root, ['packages/tool/src/leak.ts -> @fixture/server']), []);
        assert.deepEqual(openBoundaryFailures(root, ['packages/tool/src/leak.ts -> @fixture/server', 'gone -> x']), [
            'Stale known open-boundary violation (remove it from open-boundary.mjs): gone -> x',
        ]);
    });

    it('refuses a package whose license is neither open nor UNLICENSED', () => {
        const root = workspace({}, { license: 'GPL-3.0-only' });
        assert.deepEqual(openBoundaryFailures(root, []), [
            `packages/tool/package.json must declare an open license (${OPEN_LICENSES.join(', ')}) or UNLICENSED, not "GPL-3.0-only"`,
        ]);
    });

    it('reports a file it cannot parse', () => {
        const root = workspace({ 'packages/tool/src/broken.ts': 'import {\n' });
        const failures = openBoundaryFailures(root, []);
        assert.equal(failures.length, 1);
        assert.match(failures[0], /^packages\/tool\/src\/broken\.ts cannot be parsed for the open-boundary check/u);
    });

    it('reads every kind of module specifier once', () => {
        assert.deepEqual(
            moduleSpecifiers(
                'probe.ts',
                [
                    "import a from 'a';",
                    "export { b } from 'b';",
                    "export * from 'c';",
                    "await import('d');",
                    "type E = typeof import('e');",
                    "vi.mock('f');",
                    "require('g');",
                    "import again from 'a';",
                ].join('\n'),
            ).sort(),
            ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        );
    });

    it('allows no known violation: no open package depends on a proprietary one', () => {
        assert.deepEqual(KNOWN_OPEN_BOUNDARY_VIOLATIONS, []);
    });
});
