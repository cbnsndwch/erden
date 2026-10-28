import { describe, expect, it } from 'vitest';

import * as contracts from '../src/index.js';
import * as registryOrigin from '../src/manifest/registry-origin.js';

describe('@erden/contracts', () => {
    it('exports the manifest, lockfile and check report formats', () => {
        const manifest = contracts.normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/contracts',
            alias: '@example/contracts',
            registry: 'https://registry.example',
            ownedIriPrefixes: ['https://example.test/contracts#'],
            dependencies: {},
            citationRoots: {},
            sources: { ontology: ['ontology.ttl'] },
        });
        expect(contracts.normalizeManifestV1(JSON.parse(contracts.serializeManifestV1(manifest, 'json')))).toEqual(
            manifest,
        );
        expect(typeof contracts.decodeLockfileValue).toBe('function');
        expect(typeof contracts.encodeCheckProjectReport).toBe('function');
    });

    it('exports the registry wire formats the client reads', () => {
        expect(typeof contracts.decodeRegistryReleaseIndexPageWire).toBe('function');
        expect(typeof contracts.decodeReleaseQueryResultEnvelope).toBe('function');
        expect(typeof contracts.isDeviceLoginError).toBe('function');
    });

    it('exports the registry origin rule alone from its narrow entry, as the same functions as the root', () => {
        expect(Object.keys(registryOrigin).sort()).toEqual(['isRegistryOrigin', 'normalizeRegistryOrigin']);
        expect(registryOrigin.isRegistryOrigin).toBe(contracts.isRegistryOrigin);
        expect(registryOrigin.normalizeRegistryOrigin('https://Registry.Example/')).toBe('https://registry.example');
        expect(registryOrigin.isRegistryOrigin('https://registry.example/path')).toBe(false);
    });

    it('holds no local-project services', () => {
        expect('makeCheckProjectService' in contracts).toBe(false);
        expect('defineApplicationOperation' in contracts).toBe(false);
    });
});
