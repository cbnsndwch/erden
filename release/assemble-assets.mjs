// Assembles a release's assets after `pins.mjs verify --release` accepted the builds: the four archives, each checked
// against its pin again, the committed install scripts (refused unless they carry the pins), SHA256SUMS over all of
// them, and the release notes.
//
// Usage: node release/assemble-assets.mjs --artifacts <dir> --version <version> --out <dir>
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_PLATFORMS, assertPinned, sha256 } from './lib/platforms.mjs';
import { readPins } from './pins.mjs';
import { installScriptDifferences } from './write-install-scripts.mjs';

const release = import.meta.dirname;

function main() {
    const { values } = parseArgs({
        options: { artifacts: { type: 'string' }, version: { type: 'string' }, out: { type: 'string' } },
    });
    for (const name of ['artifacts', 'version', 'out']) {
        if (values[name] === undefined) {
            throw new Error(`--${name} is required`);
        }
    }
    const pins = readPins(values.version);
    const differences = installScriptDifferences(pins, release);
    if (differences.length > 0) {
        throw new Error(`The install scripts disagree with the pins:\n- ${differences.join('\n- ')}`);
    }
    const out = resolve(values.out);
    mkdirSync(out, { recursive: true });
    const sums = [];
    for (const platform of Object.keys(RELEASE_PLATFORMS).sort()) {
        const pin = pins.archives[platform];
        const source = join(resolve(values.artifacts), pin.file);
        assertPinned(source, pin, `${platform} archive`);
        copyFileSync(source, join(out, pin.file));
        sums.push(`${pin.sha256.slice('sha256:'.length)}  ${pin.file}`);
    }
    for (const name of ['install.sh', 'install.ps1']) {
        const bytes = readFileSync(join(release, name));
        writeFileSync(join(out, name), bytes);
        sums.push(`${sha256(bytes).slice('sha256:'.length)}  ${name}`);
    }
    writeFileSync(join(out, 'SHA256SUMS'), `${sums.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1)).join('\n')}\n`);
    writeFileSync(
        join(out, 'RELEASE-NOTES.md'),
        [
            `Erden ${pins.version}: the \`erden\` CLI with its Node.js ${pins.node} runtime, the reasoner and \`erden-shacl\`.`,
            '',
            'Install with `install.sh` (Linux, macOS) or `install.ps1` (Windows); each carries the four archive digests and',
            'refuses any other file. To install without network access, download the archive for your platform and the',
            'script, carry both over, and run the script with `--archive <file>`.',
            '',
            `Built from ${pins.sourceCommit}; every archive was built twice and matched its committed pin.`,
            '',
        ].join('\n'),
    );
    process.stdout.write(`Assembled ${String(sums.length)} assets in ${out}\n`);
}

if (import.meta.main) {
    main();
}
