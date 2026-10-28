import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

import { parseSync, Visitor } from 'oxc-parser';

import { discoverWorkspaceMembers } from './workspace-guard.mjs';

/**
 * Open packages never depend on proprietary code. A workspace package is open when its `license` field is an open
 * license and proprietary when it is `UNLICENSED`; the guard refuses any other value, so every package is one or the
 * other. Proprietary packages may depend on open ones; the reverse is refused in every manifest dependency field
 * (including `devDependencies`) and in every source and test file of an open package, whether the import names a
 * proprietary package or a relative path that leaves the open packages.
 */
export const OPEN_LICENSES = Object.freeze(['Apache-2.0']);
export const PROPRIETARY_LICENSE = 'UNLICENSED';

/** Repository files outside any package that open packages may import. Each is extracted with the open tree. */
export const SHARED_OPEN_HELPERS = Object.freeze([
    'scripts/lib/reasoner-release.mjs',
    'scripts/lib/test-temp-root.mjs',
]);

/**
 * Violations allowed while the split was under way, each written `<file> -> <target>`. The list must match exactly: a
 * new violation fails, and so does an entry that no longer occurs. It is empty; it stays as the place a reviewed
 * exception would have to be named.
 */
export const KNOWN_OPEN_BOUNDARY_VIOLATIONS = Object.freeze([]);

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const sourceExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const skippedDirectories = new Set(['dist', 'node_modules', 'target']);
const moduleCalls = new Set(['vi.mock', 'vi.doMock', 'vi.importActual', 'vi.importMock', 'require']);

function portable(path) {
    return path.replaceAll('\\', '/');
}

function literalText(node) {
    if (node?.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis[0]?.value.cooked ?? undefined;
    }
    return undefined;
}

function calleeName(callee) {
    if (callee.type === 'Identifier') {
        return callee.name;
    }
    if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && !callee.computed) {
        return `${callee.object.name}.${callee.property.name}`;
    }
    return undefined;
}

function languageFor(path) {
    const extension = extname(path);
    if (extension === '.tsx') {
        return 'tsx';
    }
    return ['.ts', '.mts', '.cts'].includes(extension) ? 'ts' : 'jsx';
}

/** Every module specifier a file names: imports, re-exports, `import()`, type imports, `require` and Vitest mocks. */
export function moduleSpecifiers(path, source) {
    const { errors, program } = parseSync(path, source, { lang: languageFor(path), sourceType: 'module' });
    const parseError = errors.find((error) => error.severity === 'Error');
    if (parseError !== undefined) {
        throw new Error(`${path} cannot be parsed for the open-boundary check: ${parseError.message}`);
    }
    const specifiers = new Set();
    function record(node) {
        const text = literalText(node);
        if (text !== undefined) {
            specifiers.add(text);
        }
    }
    function recordSource(node) {
        record(node.source);
    }
    new Visitor({
        ImportDeclaration: recordSource,
        ExportAllDeclaration: recordSource,
        ExportNamedDeclaration: recordSource,
        ImportExpression: recordSource,
        TSImportType: recordSource,
        TSImportEqualsDeclaration(node) {
            if (node.moduleReference.type === 'TSExternalModuleReference') {
                record(node.moduleReference.expression);
            }
        },
        CallExpression(node) {
            if (moduleCalls.has(calleeName(node.callee)) && node.arguments.length > 0) {
                record(node.arguments[0]);
            }
        },
    }).visit(program);
    return [...specifiers];
}

function packageName(specifier) {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function sourceFiles(directory) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (skippedDirectories.has(entry.name)) {
            continue;
        }
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...sourceFiles(path));
        } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
            files.push(path);
        }
    }
    return files;
}

/** Classifies each member; returns the tiers and a failure for every package with neither kind of license. */
export function classifyMembers(members) {
    const failures = [];
    const tiers = new Map();
    for (const member of members) {
        const license = member.manifest.license;
        if (OPEN_LICENSES.includes(license)) {
            tiers.set(member.manifest.name, 'open');
        } else if (license === PROPRIETARY_LICENSE) {
            tiers.set(member.manifest.name, 'proprietary');
        } else {
            failures.push(
                `${member.path}/package.json must declare an open license (${OPEN_LICENSES.join(', ')}) or ${PROPRIETARY_LICENSE}, not ${JSON.stringify(license)}`,
            );
        }
    }
    return { failures, tiers };
}

function insideAny(path, roots) {
    return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** Every `<file> -> <target>` edge from an open package to proprietary code. */
export function openBoundaryViolations(root, members, tiers) {
    const violations = [];
    const openMembers = members.filter((member) => tiers.get(member.manifest.name) === 'open');
    const openRoots = openMembers.map((member) => member.path);
    function isProprietary(name) {
        return tiers.get(name) === 'proprietary';
    }
    for (const member of openMembers) {
        for (const field of dependencyFields) {
            for (const dependency of Object.keys(member.manifest[field] ?? {})) {
                if (isProprietary(dependency)) {
                    violations.push(`${member.path}/package.json -> ${dependency}`);
                }
            }
        }
        for (const file of sourceFiles(member.directory)) {
            const path = portable(relative(root, file));
            const targets = new Set();
            for (const specifier of moduleSpecifiers(path, readFileSync(file, 'utf8'))) {
                if (specifier.startsWith('.')) {
                    const target = portable(relative(root, resolve(dirname(file), specifier)));
                    if (!insideAny(target, openRoots) && !SHARED_OPEN_HELPERS.includes(target)) {
                        targets.add(target);
                    }
                } else if (isProprietary(packageName(specifier))) {
                    targets.add(packageName(specifier));
                }
            }
            for (const target of targets) {
                violations.push(`${path} -> ${target}`);
            }
        }
    }
    return violations.sort();
}

export function openBoundaryFailures(root, known = KNOWN_OPEN_BOUNDARY_VIOLATIONS) {
    let members;
    try {
        members = discoverWorkspaceMembers(root);
    } catch (error) {
        return [`pnpm-workspace.yaml is invalid: ${error.message}`];
    }
    const { failures, tiers } = classifyMembers(members);
    let violations;
    try {
        violations = openBoundaryViolations(root, members, tiers);
    } catch (error) {
        return [...failures, error.message];
    }
    const found = new Set(violations);
    for (const violation of violations) {
        if (!known.includes(violation)) {
            failures.push(`Open code must not depend on proprietary code: ${violation}`);
        }
    }
    for (const entry of known) {
        if (!found.has(entry)) {
            failures.push(`Stale known open-boundary violation (remove it from open-boundary.mjs): ${entry}`);
        }
    }
    return failures;
}
