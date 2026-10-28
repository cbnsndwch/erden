import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
    StorePathError,
    decodeStorePathReport,
    encodeStorePathReport,
    makeStorePathService,
    renderStorePathError,
    renderStorePathReport,
} from '../src/index.js';

describe('StorePath', () => {
    it('resolves injected Windows and POSIX environments without filesystem capability', async () => {
        let calls = 0;
        const windows = makeStorePathService(() => {
            calls += 1;
            return { platform: 'win32', localAppData: 'C:\\Data', userHome: 'C:\\Users\\Alice' };
        });
        const report = await Effect.runPromise(windows.path());
        expect(calls).toBe(1);
        expect(report).toEqual({
            schema: 'erden.store-path-report/v1',
            storeRoot: 'C:\\Data\\Erden\\store\\v1',
            outcome: 'resolved',
        });
        expect(Object.isFrozen(report)).toBe(true);
        expect(renderStorePathReport(report)).toBe('C:\\Data\\Erden\\store\\v1\n');
        expect(encodeStorePathReport(report)).toBe(
            '{"outcome":"resolved","schema":"erden.store-path-report/v1","storeRoot":"C:\\\\Data\\\\Erden\\\\store\\\\v1"}\n',
        );
        expect(decodeStorePathReport(JSON.parse(encodeStorePathReport(report)))).toEqual(report);
        expect(() => decodeStorePathReport({ ...report, storeRoot: 'relative/store' })).toThrow('nonabsolute path');
        expect(() =>
            decodeStorePathReport(
                new Proxy(
                    {},
                    {
                        getPrototypeOf: () => {
                            throw new Error('/private/store-report');
                        },
                    },
                ),
            ),
        ).toThrow('Invalid erden.store-path-report/v1 document');

        const posix = makeStorePathService(() => ({
            platform: 'linux',
            xdgDataHome: '/data/alice',
            userHome: '/home/alice',
        }));
        expect((await Effect.runPromise(posix.path())).storeRoot).toBe('/data/alice/erden/store/v1');
    });

    it('normalizes hostile environment ports to frozen path-free errors', async () => {
        const service = makeStorePathService(
            () =>
                new Proxy(
                    {},
                    {
                        getPrototypeOf: () => {
                            throw new Error('/private/environment');
                        },
                    },
                ),
        );
        const failure = await Effect.runPromise(service.path().pipe(Effect.flip));
        expect(failure).toBeInstanceOf(StorePathError);
        expect(failure).toMatchObject({ code: 'STORE_PATH_ENVIRONMENT_UNAVAILABLE' });
        expect(Object.isFrozen(failure)).toBe(true);
        expect(renderStorePathError(failure)).not.toContain('/private/environment');
    });
});
