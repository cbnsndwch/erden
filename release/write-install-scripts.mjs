// Writes release/install.sh and release/install.ps1 from a version's pins (release/pins/<version>.json): each carries
// the version and the archive names, sizes and SHA-256 digests, and refuses any other file. Run in the release pull
// request, after the mint; `--check` (a guard) refuses scripts that disagree with the pins.
//
// Usage: node release/write-install-scripts.mjs --version <version> [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_PLATFORMS } from './lib/platforms.mjs';
import { readPins } from './pins.mjs';

const release = import.meta.dirname;

function hex(pin) {
    return pin === undefined ? '' : pin.sha256.slice('sha256:'.length);
}

function shellVariables(pins) {
    return Object.keys(RELEASE_PLATFORMS)
        .filter((platform) => RELEASE_PLATFORMS[platform].os !== 'win32')
        .sort()
        .flatMap((platform) => {
            const pin = pins.archives[platform];
            const name = platform.replace('-', '_');
            return [
                `${name}_file='${pin?.file ?? ''}'`,
                `${name}_sha256='${hex(pin)}'`,
                `${name}_bytes='${pin === undefined ? '' : String(pin.bytes)}'`,
            ];
        })
        .join('\n');
}

function powershellVariables(pins) {
    const pin = pins.archives['win32-x64'];
    return [
        `$win32X64File = '${pin?.file ?? ''}'`,
        `$win32X64Sha256 = '${hex(pin)}'`,
        `$win32X64Bytes = ${pin === undefined ? '0' : String(pin.bytes)}`,
    ].join('\n');
}

/** The two install scripts for `pins`, from the templates in `directory`. */
export function installScripts(pins, directory = release) {
    function fill(template, archives) {
        return readFileSync(join(directory, template), 'utf8')
            .replaceAll('@@VERSION@@', pins.version)
            .replace('@@ARCHIVES@@', archives);
    }
    return {
        'install.sh': fill('install.template.sh', shellVariables(pins)),
        'install.ps1': fill('install.template.ps1', powershellVariables(pins)),
    };
}

/** Every committed install script that is not the one the pins give; empty when they agree. */
export function installScriptDifferences(pins, directory = release) {
    return Object.entries(installScripts(pins, directory)).flatMap(([name, text]) => {
        let committed;
        try {
            committed = readFileSync(join(directory, name), 'utf8');
        } catch {
            return [`release/${name} is missing`];
        }
        return committed === text ? [] : [`release/${name} is not the one release/pins/${pins.version}.json gives`];
    });
}

function main() {
    const { values } = parseArgs({
        options: { version: { type: 'string' }, check: { type: 'boolean', default: false } },
    });
    if (values.version === undefined) {
        throw new Error('--version is required');
    }
    const pins = readPins(values.version);
    if (values.check) {
        const differences = installScriptDifferences(pins);
        if (differences.length > 0) {
            throw new Error(differences.join('\n'));
        }
        process.stdout.write(`release/install.sh and release/install.ps1 carry release/pins/${pins.version}.json\n`);
        return;
    }
    for (const [name, text] of Object.entries(installScripts(pins))) {
        writeFileSync(join(release, name), text);
    }
    process.stdout.write(`Wrote release/install.sh and release/install.ps1 for ${pins.version}\n`);
}

if (import.meta.main) {
    main();
}
