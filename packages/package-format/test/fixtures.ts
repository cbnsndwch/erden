import { gzipSync } from 'node:zlib';

import { encodeUnsafeTarGzipFixture } from '../src/index.js';

const unsupportedManifest = `${JSON.stringify({
    formatVersion: 2,
    archiveRoot: 'package/',
    generatedManifestPath: '.erden/package-manifest.json',
    canonicalIri: 'https://example.test/unsupported',
    version: '1.0.0',
    dependencies: [],
    toolchain: {},
    files: [],
})}\n`;

export const MALICIOUS_ARCHIVES = {
    traversal: encodeUnsafeTarGzipFixture([{ path: 'package/../escape.ttl', bytes: 'escape' }]),
    absolute: encodeUnsafeTarGzipFixture([{ path: '/outside.ttl', bytes: 'escape' }]),
    drive: encodeUnsafeTarGzipFixture([{ path: 'package/C:/outside.ttl', bytes: 'escape' }]),
    symlink: encodeUnsafeTarGzipFixture([{ path: 'package/link', typeFlag: '2', linkTarget: '../../outside' }]),
    hardlink: encodeUnsafeTarGzipFixture([{ path: 'package/link', typeFlag: '1', linkTarget: 'package/target' }]),
    duplicate: encodeUnsafeTarGzipFixture([
        { path: 'package/a.ttl', bytes: 'first' },
        { path: 'package/a.ttl', bytes: 'second' },
    ]),
    caseConflict: encodeUnsafeTarGzipFixture([
        { path: 'package/A.ttl', bytes: 'first' },
        { path: 'package/a.ttl', bytes: 'second' },
    ]),
    fileDescendantConflict: encodeUnsafeTarGzipFixture([
        { path: 'package/node', bytes: 'file' },
        { path: 'package/node/child.ttl', bytes: 'child' },
    ]),
    device: encodeUnsafeTarGzipFixture([{ path: 'package/device', typeFlag: '3' }]),
    fifo: encodeUnsafeTarGzipFixture([{ path: 'package/fifo', typeFlag: '6' }]),
    pax: encodeUnsafeTarGzipFixture([{ path: 'package/pax', typeFlag: 'x', bytes: 'path=outside\n' }]),
    oversizedEntry: encodeUnsafeTarGzipFixture([{ path: 'package/large.bin', bytes: '12345' }]),
    tooManyEntries: encodeUnsafeTarGzipFixture([
        { path: 'package/a', bytes: 'a' },
        { path: 'package/b', bytes: 'b' },
    ]),
    tooDeep: encodeUnsafeTarGzipFixture([{ path: 'package/a/b/c.ttl', bytes: 'deep' }]),
    missingManifest: encodeUnsafeTarGzipFixture([{ path: 'package/data.ttl', bytes: 'data' }]),
    unsupportedVersion: encodeUnsafeTarGzipFixture([
        { path: 'package/.erden/package-manifest.json', bytes: unsupportedManifest },
    ]),
    decompressionBomb: gzipSync(new Uint8Array(64 * 1024)),
} as const;
