import { describe, expect, it } from 'vitest';

import * as client from '../src/index.js';

describe('@erden/client exports', () => {
    it('exports only the narrow auth, publication, and compact registry client surfaces', () => {
        expect(client.beginCliDeviceLogin).toBeTypeOf('function');
        expect(client.exchangeCliDeviceLogin).toBeTypeOf('function');
        expect(client.writeStoredCliCredential).toBeTypeOf('function');
        expect(client.uploadPublication).toBeTypeOf('function');
        expect(client.getPublicationAttempt).toBeTypeOf('function');
        expect(client.getPublicationReport).toBeTypeOf('function');
        expect(client.resolveRegistryAlias).toBeTypeOf('function');
        expect(client.listRegistryReleases).toBeTypeOf('function');
        expect(client.getExactRegistryRelease).toBeTypeOf('function');
        expect(client.openRegistryArchive).toBeTypeOf('function');
        expect('requestRegistryJson' in client).toBe(false);
        expect('encodeCanonicalJson' in client).toBe(false);
        expect('listPublished' in client).toBe(false);
    });
});
