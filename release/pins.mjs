// The release pins: what a mint run built, and the check a tag build must pass before anything is published.
//
//   node release/pins.mjs mint --artifacts <dir> --out <dir> [--allow-partial]
//       Reads each platform's build record (<platform>.json, from build-cli-archive.mjs) and its archive from
//       <dir>, and writes release/pins/<version>.json under --out, for a pull request. Refuses unless all four
//       platforms are present, the records agree on version, commit and epoch, and each archive is the one its record
//       names. --allow-partial accepts fewer platforms, for a local rehearsal; `verify --release` refuses such pins.
//   node release/pins.mjs verify --artifacts <dir> [--release] [--tag v<version>]
//       Refuses unless every archive in <dir> is byte for byte the one release/pins/<version>.json in this checkout
//       pins, every pinned platform is present, and each record's engines are the pinned ones. --release also
//       requires all four platforms and, with --tag, that the tag names the pinned version.
//   node release/pins.mjs epoch --version <version>
//       Prints the pinned source date epoch, which a tag build passes to build-cli-archive.mjs.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_PLATFORMS, assertPinned, sha256 } from './lib/platforms.mjs';

const release = import.meta.dirname;
const PLATFORMS = Object.keys(RELEASE_PLATFORMS).sort();

function readRecords(directory) {
    const records = {};
    for (const name of readdirSync(directory).sort()) {
        const platform = name.replace(/\.json$/u, '');
        if (name.endsWith('.json') && PLATFORMS.includes(platform)) {
            const record = JSON.parse(readFileSync(join(directory, name), 'utf8'));
            if (record.schema !== 'erden.cli-archive-build/v1' || record.platform !== platform) {
                throw new Error(`${name} is not a CLI archive build record for ${platform}`);
            }
            if (record.result !== 'byte-identical') {
                throw new Error(`${platform}: the two builds were not identical`);
            }
            assertPinned(join(directory, record.archive.file), record.archive, `${platform} archive`);
            records[platform] = record;
        }
    }
    if (Object.keys(records).length === 0) {
        throw new Error(`No CLI archive build records in ${directory}`);
    }
    return records;
}

function single(records, field) {
    const values = new Set(Object.values(records).map((record) => JSON.stringify(record[field])));
    if (values.size !== 1) {
        throw new Error(`The platform builds disagree on ${field}`);
    }
    return JSON.parse([...values][0]);
}

/** The pins file a mint writes from its build records. */
export function pinsOf(records, { allowPartial = false } = {}) {
    const missing = PLATFORMS.filter((platform) => records[platform] === undefined);
    if (missing.length > 0 && !allowPartial) {
        throw new Error(`No build for ${missing.join(', ')}`);
    }
    const platforms = Object.keys(records).sort();
    return {
        schema: 'erden.release-pins/v1',
        version: single(records, 'version'),
        sourceCommit: single(records, 'sourceCommit'),
        sourceDateEpoch: single(records, 'sourceDateEpoch'),
        node: single(records, 'node').version,
        complete: missing.length === 0,
        archives: Object.fromEntries(platforms.map((platform) => [platform, records[platform].archive])),
        engines: Object.fromEntries(
            ['reasoner', 'shacl'].map((engine) => [
                engine,
                Object.fromEntries(platforms.map((platform) => [platform, records[platform].engines[engine].sha256])),
            ]),
        ),
    };
}

/** Every way the built records differ from the pins; empty when they match. */
export function pinDifferences(pins, records, { release: releaseMode = false } = {}) {
    const differences = [];
    if (releaseMode && pins.complete !== true) {
        differences.push('the pins were minted for fewer than four platforms');
    }
    const expected = releaseMode ? PLATFORMS : Object.keys(pins.archives).sort();
    for (const platform of expected) {
        const record = records[platform];
        const pin = pins.archives[platform];
        if (pin === undefined) {
            differences.push(`${platform}: not pinned`);
            continue;
        }
        if (record === undefined) {
            differences.push(`${platform}: not built`);
            continue;
        }
        if (record.version !== pins.version) {
            differences.push(`${platform}: version ${record.version}, pinned ${pins.version}`);
        }
        if (record.sourceDateEpoch !== pins.sourceDateEpoch) {
            differences.push(`${platform}: built with another source date epoch`);
        }
        if (
            record.archive.file !== pin.file ||
            record.archive.bytes !== pin.bytes ||
            record.archive.sha256 !== pin.sha256
        ) {
            differences.push(
                `${platform}: ${record.archive.file} is ${record.archive.sha256} (${String(record.archive.bytes)} bytes), pinned ${pin.sha256} (${String(pin.bytes)} bytes)`,
            );
        }
        for (const engine of ['reasoner', 'shacl']) {
            if (record.engines[engine].sha256 !== pins.engines[engine][platform]) {
                differences.push(
                    `${platform}: the ${engine} is ${record.engines[engine].sha256}, pinned ${pins.engines[engine][platform]}`,
                );
            }
        }
    }
    for (const platform of Object.keys(records)) {
        if (!expected.includes(platform)) {
            differences.push(`${platform}: built but not pinned`);
        }
    }
    return differences;
}

export function readPins(version, root = resolve(release, '..')) {
    const path = join(root, 'release', 'pins', `${version}.json`);
    if (!existsSync(path)) {
        throw new Error(`No release pins for ${version} (${path}); mint them first`);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            artifacts: { type: 'string' },
            out: { type: 'string' },
            version: { type: 'string' },
            tag: { type: 'string' },
            release: { type: 'boolean', default: false },
            'allow-partial': { type: 'boolean', default: false },
        },
    });
    const [mode] = positionals;
    if (mode === 'epoch') {
        process.stdout.write(`${String(readPins(values.version).sourceDateEpoch)}\n`);
        return;
    }
    if (values.artifacts === undefined || (mode !== 'mint' && mode !== 'verify')) {
        throw new Error(
            'Usage: pins.mjs mint --artifacts <dir> --out <dir> | verify --artifacts <dir> [--release] [--tag <tag>] | epoch --version <v>',
        );
    }
    const records = readRecords(resolve(values.artifacts));
    if (mode === 'mint') {
        if (values.out === undefined) {
            throw new Error('--out is required');
        }
        const pins = pinsOf(records, { allowPartial: values['allow-partial'] });
        const directory = join(resolve(values.out), 'release', 'pins');
        mkdirSync(directory, { recursive: true });
        const text = `${JSON.stringify(pins, null, 4)}\n`;
        writeFileSync(join(directory, `${pins.version}.json`), text);
        process.stdout.write(`release/pins/${pins.version}.json: ${sha256(text)}\n`);
        return;
    }
    const version = single(records, 'version');
    if (values.tag !== undefined && values.tag !== `v${version}`) {
        throw new Error(`Tag ${values.tag} does not name version ${version}`);
    }
    const differences = pinDifferences(readPins(version), records, { release: values.release });
    if (differences.length > 0) {
        throw new Error(`The builds do not match release/pins/${version}.json:\n- ${differences.join('\n- ')}`);
    }
    process.stdout.write(`Every archive and engine matches release/pins/${version}.json\n`);
}

if (import.meta.main) {
    main();
}
