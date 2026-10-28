import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The binary is never committed: shacl/qualification/build-from-source.mjs installs a byte-identical build, and the
// tools release (release.yml) will ship the minted one.
const binaryUrl = new URL('../bin/erden-shacl', import.meta.url);
const metadata = JSON.parse(readFileSync(new URL('../metadata.json', import.meta.url), 'utf8')) as {
    binary: { path: string; bytes: number; sha256: string };
    target: string;
};
const record = JSON.parse(
    readFileSync(new URL('../../qualification/binary-reproducibility.json', import.meta.url), 'utf8'),
) as { targets: Record<string, { runs: Array<{ bytes: number; sha256: string }> }> };

describe('@erden/shacl-linux-x64-gnu artifact', () => {
    it('pins exactly the executable the reproducibility record names', () => {
        const runs = record.targets[metadata.target]?.runs ?? [];
        expect(metadata.binary.path).toBe('bin/erden-shacl');
        expect(runs.map((run) => ({ bytes: run.bytes, sha256: run.sha256 }))).toEqual([
            { bytes: metadata.binary.bytes, sha256: metadata.binary.sha256 },
            { bytes: metadata.binary.bytes, sha256: metadata.binary.sha256 },
        ]);
    });

    it.skipIf(!existsSync(binaryUrl))(
        'holds the pinned executable (skipped when none is installed: build-from-source.mjs, or the TS-6 release)',
        () => {
            const binary = readFileSync(binaryUrl);
            const digest = `sha256:${createHash('sha256').update(binary).digest('hex')}`;
            expect({ bytes: binary.byteLength, sha256: digest }).toEqual({
                bytes: metadata.binary.bytes,
                sha256: metadata.binary.sha256,
            });
        },
    );
});
