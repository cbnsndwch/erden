import { Context, Effect } from 'effect';

import type { ApplicationOperation } from '../index.js';
import { nodeStoreEnvironment, resolveDefaultStoreRoot, type StoreEnvironment } from '../store/index.js';

import { StorePathError } from './errors.js';
import { decodeStorePathReport, STORE_PATH_REPORT_VERSION, type StorePathReport } from './report.js';

export type StoreEnvironmentPort = () => unknown;

function snapshotEnvironment(input: unknown): StoreEnvironment {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw new TypeError('environment shape');
    }
    const allowed = new Set(['platform', 'localAppData', 'xdgDataHome', 'userHome']);
    const values = new Map<string, unknown>();
    for (const key of Object.getOwnPropertyNames(input)) {
        if (!allowed.has(key)) {
            throw new TypeError('environment field');
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new TypeError('environment descriptor');
        }
        values.set(key, descriptor.value);
    }
    const platform = values.get('platform');
    const userHome = values.get('userHome');
    const localAppData = values.get('localAppData');
    const xdgDataHome = values.get('xdgDataHome');
    if (
        typeof platform !== 'string' ||
        platform.length === 0 ||
        typeof userHome !== 'string' ||
        userHome.length === 0 ||
        (localAppData !== undefined && typeof localAppData !== 'string') ||
        (xdgDataHome !== undefined && typeof xdgDataHome !== 'string')
    ) {
        throw new TypeError('environment value');
    }
    return Object.freeze({
        platform,
        userHome,
        ...(localAppData === undefined ? {} : { localAppData }),
        ...(xdgDataHome === undefined ? {} : { xdgDataHome }),
    });
}

function runStorePath(environment: StoreEnvironmentPort): Effect.Effect<StorePathReport, StorePathError> {
    return Effect.try({
        try: () => {
            const storeRoot = resolveDefaultStoreRoot(snapshotEnvironment(environment()));
            return decodeStorePathReport({ schema: STORE_PATH_REPORT_VERSION, storeRoot, outcome: 'resolved' });
        },
        catch: (cause) =>
            cause instanceof StorePathError
                ? cause
                : new StorePathError(
                      'STORE_PATH_ENVIRONMENT_UNAVAILABLE',
                      'The default local package store path is unavailable',
                      cause,
                  ),
    });
}

export interface StorePathServiceShape {
    readonly path: () => Effect.Effect<StorePathReport, StorePathError>;
}

export const StorePathService = Context.Service<StorePathServiceShape>('@erden/project/StorePathService');

export function makeStorePathService(environment: StoreEnvironmentPort): StorePathServiceShape {
    return Object.freeze({
        path: () => runStorePath(environment),
    });
}

export const nodeStorePathService = makeStorePathService(nodeStoreEnvironment);

export function storePath(): Effect.Effect<
    StorePathReport,
    StorePathError,
    Context.Service.Identifier<typeof StorePathService>
> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(StorePathService)).path();
    });
}

export function defineStorePathOperation(): ApplicationOperation<
    'StorePath',
    StorePathReport,
    StorePathError,
    Context.Service.Identifier<typeof StorePathService>
> {
    return Object.freeze({ name: 'StorePath', effect: storePath() });
}
