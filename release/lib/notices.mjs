// The CLI archive's third-party notices, generated from the deployed tree: every installed package's name, version,
// declared license and license files, under the same policy code as the reasoner's (license-policy.mjs). An unknown,
// denied or unlicensed package fails the build, and so does one with no license file unless the policy names it
// (`withoutLicenseFile`) with the file that covers it. License files are copied byte for byte and named by their SHA-256
// digest, as in the engines' notices.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { selectLicenses } from '../../reasoner/qualification/license-policy.mjs';

const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[-._].*)?$/iu;
const LICENSES = join(import.meta.dirname, '..', 'licenses');

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/** The declared license expression of a manifest: `license`, or the legacy `{ type }` and `licenses` forms. */
export function declaredLicense(manifest) {
    if (typeof manifest.license === 'string') {
        return manifest.license;
    }
    if (typeof manifest.license?.type === 'string') {
        return manifest.license.type;
    }
    if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
        return manifest.licenses.map((entry) => (typeof entry === 'string' ? entry : entry.type)).join(' OR ');
    }
    return undefined;
}

/** Every package directory installed under `nodeModules`, nested ones included, sorted by path. */
export function installedPackages(nodeModules) {
    const found = [];
    function visit(directory) {
        if (!existsSync(directory)) {
            return;
        }
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) {
                continue;
            }
            const path = join(directory, entry.name);
            if (entry.name.startsWith('@')) {
                visit(path);
            } else if (existsSync(join(path, 'package.json'))) {
                found.push(path);
                visit(join(path, 'node_modules'));
            }
        }
    }
    visit(nodeModules);
    return found.sort();
}

function exceptionOf(name, policy) {
    const entries = Object.entries(policy.withoutLicenseFile ?? {});
    return entries.find(([pattern]) =>
        pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
    )?.[1];
}

/**
 * A package's license files, or, for a package the policy names as shipping none, the license file of the package it
 * is part of, or the committed standard text of its selected license (`release/licenses/<identifier>.txt`).
 */
function licenseFiles(directory, name, nodeModules, policy, component) {
    const own = readdirSync(directory)
        .filter((file) => LICENSE_FILE.test(file))
        .sort()
        .map((file) => ({ name: file, path: join(directory, file) }));
    if (own.length > 0) {
        return own;
    }
    const exception = exceptionOf(name, policy);
    if (exception?.licenseFileOf !== undefined) {
        const owner = join(nodeModules, ...exception.licenseFileOf.split('/'));
        const files = existsSync(owner)
            ? readdirSync(owner)
                  .filter((file) => LICENSE_FILE.test(file))
                  .sort()
            : [];
        if (files.length === 0) {
            throw new Error(`No license file in ${component} or in ${exception.licenseFileOf}`);
        }
        return files.map((file) => ({ name: `${exception.licenseFileOf}/${file}`, path: join(owner, file) }));
    }
    if (exception?.standardText !== undefined) {
        return [
            { name: `standard ${exception.standardText} text`, path: join(LICENSES, `${exception.standardText}.txt`) },
        ];
    }
    throw new Error(`No license file in ${component}`);
}

/**
 * Writes `<out>/npm/THIRD-PARTY-NOTICES.md` and its `licenses/` for every package in `nodeModules` except the
 * workspace's own (`ownScope`, covered by the archive's LICENSE and NOTICE). Returns the package count.
 */
export function writeNpmNotices(nodeModules, out, policy, ownScope = '@erden/') {
    const licenses = join(out, 'npm', 'licenses');
    mkdirSync(licenses, { recursive: true });
    const seen = new Map();
    for (const directory of installedPackages(nodeModules)) {
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        if (typeof manifest.name !== 'string' || manifest.name.startsWith(ownScope)) {
            continue;
        }
        const component = `${manifest.name} ${String(manifest.version)}`;
        if (seen.has(component)) {
            continue;
        }
        const declared = declaredLicense(manifest);
        const selected = selectLicenses(declared, policy, component);
        const files = licenseFiles(directory, manifest.name, nodeModules, policy, component);
        const references = files.map(({ name, path }) => {
            const bytes = readFileSync(path);
            const digest = sha256(bytes);
            writeFileSync(join(licenses, `${digest}.txt`), bytes);
            return `licenses/${digest}.txt (${name}, sha256:${digest})`;
        });
        seen.set(
            component,
            `- ${component}: declared \`${declared}\`; selected \`${selected.join(', ')}\`; ${references.join(', ')}`,
        );
    }
    const lines = [
        '# Third-party notices: npm packages',
        '',
        "Generated from the CLI's deployed dependency tree. The policy rejects unknown, denied or unlicensed packages and packages with no license file. Each license file is copied byte for byte and named by its SHA-256 digest.",
        '',
        ...[...seen.keys()].sort().map((key) => `${seen.get(key)}\n`),
    ];
    writeFileSync(join(out, 'npm', 'THIRD-PARTY-NOTICES.md'), `${lines.join('\n').trimEnd()}\n`);
    return seen.size;
}

/** Copies an engine's committed notices (its THIRD-PARTY-NOTICES.md and the licenses/ it names) to `<out>/<name>/`. */
export function copyEngineNotices(qualification, out, name) {
    const destination = join(out, name);
    mkdirSync(destination, { recursive: true });
    cpSync(join(qualification, 'THIRD-PARTY-NOTICES.md'), join(destination, 'THIRD-PARTY-NOTICES.md'));
    cpSync(join(qualification, 'licenses'), join(destination, 'licenses'), { recursive: true });
}
