import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { decodeLockfileValue, manifestDependencyProjectionSha256, type LockToolchain } from '@erden/contracts';
import { encodePackage, validatePackageArchiveStream } from '@erden/package-format';

import { LocalPackageStoreError } from '../src/store/errors.js';
import { makeNodeStoreFileSystemPort, resolveDefaultStoreRoot } from '../src/store/filesystem.js';
import {
    buildInstallMarker,
    buildStoreObjectMarker,
    decodeInstallMarker,
    decodeStoreObjectMarker,
    encodeInstallMarker,
    encodeStoreObjectMarker,
    layerDirectoryFor,
    lockSha256,
} from '../src/store/marker.js';

function digest(character: string): string {
    return character.repeat(64);
}
const TOOLCHAIN: LockToolchain = {
    validator: { version: '1.0.0', sha256: digest('a') },
    reasoner: { version: '1.0.0', sha256: digest('b') },
};
const IRI = 'https://example.test/layer';

function lockValue() {
    return decodeLockfileValue({
        lockfileVersion: 1,
        registryOrigin: 'https://registry.example',
        manifestDependencySha256: manifestDependencyProjectionSha256({
            canonicalIri: 'https://example.test/root',
            alias: '@example/root',
            registryOrigin: 'https://registry.example',
            dependencies: { '@example/layer': '^1.0.0' },
        }),
        root: { canonicalIri: 'https://example.test/root', alias: '@example/root' },
        directDependencies: [
            {
                identifier: '@example/layer',
                requested: '^1.0.0',
                canonicalIri: IRI,
                version: '1.0.0',
                archiveSha256: digest('c'),
            },
        ],
        aliasMappings: [{ alias: '@example/layer', canonicalIri: IRI }],
        packages: [{ canonicalIri: IRI, version: '1.0.0', archiveSha256: digest('c'), dependencies: [] }],
        toolchain: TOOLCHAIN,
        counts: { directDependencies: 1, aliasMappings: 1, packages: 1, edges: 0 },
    });
}

function canonicalJson(value: unknown): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

async function markerFixture() {
    const encoded = encodePackage({
        canonicalIri: IRI,
        version: '1.0.0',
        dependencies: [],
        validator: TOOLCHAIN.validator,
        reasoner: TOOLCHAIN.reasoner,
        files: [{ path: 'ontology.ttl', bytes: '<urn:s> <urn:p> <urn:o> .\n', executable: false }],
    });
    const validated = await validatePackageArchiveStream(encoded.archiveBytes);
    const lock = lockValue();
    const firstPackage = lock.packages[0];
    const firstDirect = lock.directDependencies[0];
    if (firstPackage === undefined || firstDirect === undefined) {
        throw new Error('fixture lock');
    }
    const node = { ...firstPackage, archiveSha256: validated.archiveSha256 };
    const object = buildStoreObjectMarker(node, TOOLCHAIN, validated);
    return {
        lock: decodeLockfileValue({
            ...lock,
            directDependencies: [{ ...firstDirect, archiveSha256: validated.archiveSha256 }],
            packages: [node],
        }),
        object,
    };
}

describe('LocalPackageStore marker contracts', () => {
    it('roundtrips closed canonical markers without freezing caller-owned lock data', async () => {
        const { lock, object } = await markerFixture();
        const mutable = structuredClone(lock);
        const install = buildInstallMarker(mutable, new Map([[object.archiveSha256, object]]));
        expect(decodeStoreObjectMarker(encodeStoreObjectMarker(object))).toEqual(object);
        expect(decodeInstallMarker(encodeInstallMarker(install))).toEqual(install);
        expect(install.lockSha256).toBe(lockSha256(lock));
        expect(Object.isFrozen(mutable)).toBe(false);
        expect(Object.isFrozen(mutable.toolchain)).toBe(false);
        expect(install.layers[0]?.manifestSha256).toBe(object.manifestSha256);
    });

    it('rejects unsafe, noncanonical, duplicate, case, NFC, and descendant-conflicting marker paths', async () => {
        const { object } = await markerFixture();
        const base = JSON.parse(new TextDecoder().decode(encodeStoreObjectMarker(object))) as Record<string, unknown>;
        function file(path: string) {
            return { path, byteSize: 0, sha256: digest('d'), logicalMode: 420 };
        }
        const hostile = [
            [file('../escape')],
            [file('/absolute')],
            [file('a'), file('a')],
            [file('a'), file('A')],
            [file('café'), file('cafe\u0301')],
            [file('a'), file('a/b')],
        ];
        for (const files of hostile) {
            expect(() => decodeStoreObjectMarker(canonicalJson({ ...base, files }))).toThrow(LocalPackageStoreError);
        }
    });

    it('rejects malformed layer identities and globally ambiguous identifiers', async () => {
        const { lock, object } = await markerFixture();
        const marker = buildInstallMarker(lock, new Map([[object.archiveSha256, object]]));
        const value = JSON.parse(new TextDecoder().decode(encodeInstallMarker(marker))) as Record<string, unknown>;
        const layer = (value.layers as Array<Record<string, unknown>>)[0];
        if (layer === undefined) {
            throw new Error('fixture layer');
        }
        for (const mutation of [
            { ...layer, canonicalIri: '' },
            { ...layer, version: 'not semver' },
            { ...layer, identifiers: [''] },
        ]) {
            expect(() => decodeInstallMarker(canonicalJson({ ...value, layers: [mutation] }))).toThrow(
                LocalPackageStoreError,
            );
        }
        const second = {
            ...layer,
            canonicalIri: 'https://example.test/second',
            directory: layerDirectoryFor('https://example.test/second'),
            identifiers: ['@example/layer', 'https://example.test/second'],
        };
        expect(() => decodeInstallMarker(canonicalJson({ ...value, layers: [layer, second] }))).toThrow(
            LocalPackageStoreError,
        );
    });

    it('uses only absolute environment homes and ignores relative optional data roots', () => {
        expect(resolveDefaultStoreRoot({ platform: 'linux', xdgDataHome: 'relative', userHome: '/home/alice' })).toBe(
            '/home/alice/.local/share/erden/store/v1',
        );
        expect(resolveDefaultStoreRoot({ platform: 'win32', localAppData: '', userHome: 'C:\\Users\\Alice' })).toBe(
            'C:\\Users\\Alice\\AppData\\Local\\Erden\\store\\v1',
        );
        expect(() => resolveDefaultStoreRoot({ platform: 'linux', userHome: 'relative' })).toThrow(
            LocalPackageStoreError,
        );
    });
});

describe('LocalPackageStore import fallback contract', () => {
    const roots: string[] = [];
    afterEach(async () => {
        await Promise.all(
            roots.splice(0).map(async (root) => {
                await fs.rm(root, { recursive: true, force: true });
            }),
        );
    });

    it('does not treat an existing destination as a capability fallback', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-store-import-'));
        roots.push(root);
        const source = join(root, 'source');
        const destination = join(root, 'destination');
        await fs.writeFile(source, 'source');
        await fs.writeFile(destination, 'foreign');
        const port = makeNodeStoreFileSystemPort({
            copyFile: () => Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' })),
        });
        await expect(port.importFile(source, destination)).rejects.toMatchObject({ code: 'EEXIST' });
        await expect(fs.readFile(destination, 'utf8')).resolves.toBe('foreign');
    });

    it('fails rollback-unsafe if a capability failure leaves a destination', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-store-import-'));
        roots.push(root);
        const source = join(root, 'source');
        const destination = join(root, 'destination');
        await fs.writeFile(source, 'source');
        const port = makeNodeStoreFileSystemPort({
            copyFile: async (_source, target, flags) => {
                if (((flags ?? 0) & constants.COPYFILE_FICLONE_FORCE) !== 0) {
                    await fs.writeFile(target, 'partial', { flag: 'wx' });
                    throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
                }
                await fs.copyFile(_source, target, flags);
            },
        });
        await expect(port.importFile(source, destination)).rejects.toMatchObject({ code: 'INSTALL_ROLLBACK_UNSAFE' });
        await expect(fs.readFile(destination, 'utf8')).resolves.toBe('partial');
    });
});
