import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** Checks minted source packages without requiring foreign-platform executables in a source checkout. */
export function testPlatformPackage(directory: URL): void {
    const manifest = JSON.parse(readFileSync(new URL('package.json', directory), 'utf8')) as { name: string };
    const metadata = JSON.parse(readFileSync(new URL('metadata.json', directory), 'utf8')) as {
        target: string;
        binary: { path: string; bytes: number; sha256: string };
    };
    const record = JSON.parse(readFileSync(new URL('../../qualification/mint.json', import.meta.url), 'utf8')) as {
        targets: Record<string, { runs: Array<{ bytes: number; sha256: string }> }>;
    };
    const path = metadata.target === 'x86_64-pc-windows-msvc' ? 'bin/erden-reasoner.exe' : 'bin/erden-reasoner';
    const binary = new URL(path, directory);
    describe(`${manifest.name} artifact`, () => {
        it('pins both identical builds from the mint record', () => {
            expect(metadata.binary.path).toBe(path);
            expect(record.targets[metadata.target]?.runs.map(({ bytes, sha256 }) => ({ bytes, sha256 }))).toEqual([
                { bytes: metadata.binary.bytes, sha256: metadata.binary.sha256 },
                { bytes: metadata.binary.bytes, sha256: metadata.binary.sha256 },
            ]);
        });
        it.skipIf(!existsSync(binary))('holds the pinned executable when installed', () => {
            const bytes = readFileSync(binary);
            expect(bytes.byteLength).toBe(metadata.binary.bytes);
            expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(metadata.binary.sha256);
        });
    });
}
