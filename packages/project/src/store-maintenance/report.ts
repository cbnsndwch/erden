import { isCanonicalOntologyIri, isScopedAlias } from '@erden/contracts';

export const STORE_STATUS_REPORT_VERSION = 'erden.store-status-report/v1' as const;

export interface StoreStatusProject {
    readonly canonicalIri: string;
    readonly alias: string;
}
export interface StoreStatusCurrentRegistration {
    readonly registrationId: string;
    readonly generationSha256: string;
    readonly project: StoreStatusProject;
    readonly lockSha256: string;
    readonly packages: number;
}
export interface StoreStatusCleanupRegistration {
    readonly registrationId: string;
    readonly generationSha256: string;
    readonly project: StoreStatusProject;
}
export interface StoreStatusStaleRegistration extends StoreStatusCleanupRegistration {
    readonly issue: 'unavailable' | 'state-mismatch' | 'transaction-present';
}
export interface StoreStatusReport {
    readonly schema: typeof STORE_STATUS_REPORT_VERSION;
    readonly store: 'missing' | 'available';
    readonly transaction: 'idle' | 'busy';
    readonly registrations: Readonly<{
        readonly total: number;
        readonly current: ReadonlyArray<StoreStatusCurrentRegistration>;
        readonly superseded: ReadonlyArray<StoreStatusCleanupRegistration>;
        readonly orphaned: ReadonlyArray<StoreStatusCleanupRegistration>;
        readonly stale: ReadonlyArray<StoreStatusStaleRegistration>;
        readonly corrupt: ReadonlyArray<string>;
        readonly busy: ReadonlyArray<string>;
    }>;
    readonly objects: Readonly<{
        readonly total: number;
        readonly referenced: ReadonlyArray<string>;
        readonly unreferenced: ReadonlyArray<string>;
        readonly missingReferenced: ReadonlyArray<string>;
        readonly busy: ReadonlyArray<string>;
        readonly corrupt: ReadonlyArray<string>;
        readonly logicalBytes: string;
        readonly unreferencedLogicalBytes: string;
    }>;
    readonly outcome: 'healthy' | 'issues';
}

const SHA256 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
function record(input: unknown, keys: ReadonlyArray<string>): Record<string, unknown> {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw new TypeError('report record');
    }
    const names = Object.getOwnPropertyNames(input).sort(compare);
    const expected = [...keys].sort(compare);
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
        throw new TypeError('report keys');
    }
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new TypeError('report descriptor');
        }
    }
    return input as Record<string, unknown>;
}
function array(input: unknown, maximum: number): ReadonlyArray<unknown> {
    if (
        !Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Array.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0 ||
        input.length > maximum
    ) {
        throw new TypeError('report array');
    }
    const names = Object.getOwnPropertyNames(input);
    if (names.length !== input.length + 1 || !names.includes('length')) {
        throw new TypeError('report array closure');
    }
    const values: unknown[] = [];
    for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new TypeError('report array descriptor');
        }
        values.push(descriptor.value);
    }
    return values;
}
function digestArray(input: unknown): ReadonlyArray<string> {
    const values = array(input, 100000).map((value) => {
        if (typeof value !== 'string' || !SHA256.test(value)) {
            throw new TypeError('report digest');
        }
        return value;
    });
    if (values.some((value, index) => index > 0 && compare(values[index - 1] ?? '', value) >= 0)) {
        throw new TypeError('report digest order');
    }
    return Object.freeze(values);
}
function project(input: unknown): StoreStatusProject {
    const value = record(input, ['canonicalIri', 'alias']);
    if (
        typeof value['canonicalIri'] !== 'string' ||
        !isCanonicalOntologyIri(value['canonicalIri']) ||
        typeof value['alias'] !== 'string' ||
        !isScopedAlias(value['alias'])
    ) {
        throw new TypeError('report project');
    }
    return Object.freeze({ canonicalIri: value['canonicalIri'], alias: value['alias'] });
}
function safeCount(input: unknown): number {
    if (!Number.isSafeInteger(input) || Object.is(input, -0) || Number(input) < 0) {
        throw new TypeError('report count');
    }
    return Number(input);
}
function cleanupRegistration(input: unknown): StoreStatusCleanupRegistration {
    const value = record(input, ['registrationId', 'generationSha256', 'project']);
    if (
        typeof value['registrationId'] !== 'string' ||
        !SHA256.test(value['registrationId']) ||
        typeof value['generationSha256'] !== 'string' ||
        !SHA256.test(value['generationSha256'])
    ) {
        throw new TypeError('report registration');
    }
    return Object.freeze({
        registrationId: value['registrationId'],
        generationSha256: value['generationSha256'],
        project: project(value['project']),
    });
}
function registrationArray<Value>(
    input: unknown,
    decode: (item: unknown) => Value,
    key: (item: Value) => string,
): ReadonlyArray<Value> {
    const values = array(input, 16384).map(decode);
    if (values.some((value, index) => index > 0 && compare(key(values[index - 1] as Value), key(value)) >= 0)) {
        throw new TypeError('report registration order');
    }
    return Object.freeze(values);
}

export function decodeStoreStatusReport(input: unknown): StoreStatusReport {
    try {
        const top = record(input, ['schema', 'store', 'transaction', 'registrations', 'objects', 'outcome']);
        if (
            top['schema'] !== STORE_STATUS_REPORT_VERSION ||
            (top['store'] !== 'missing' && top['store'] !== 'available') ||
            (top['transaction'] !== 'idle' && top['transaction'] !== 'busy') ||
            (top['outcome'] !== 'healthy' && top['outcome'] !== 'issues')
        ) {
            throw new TypeError('report header');
        }
        const registrationsRecord = record(top['registrations'], [
            'total',
            'current',
            'superseded',
            'orphaned',
            'stale',
            'corrupt',
            'busy',
        ]);
        function key(item: StoreStatusCleanupRegistration) {
            return `${item.registrationId}.${item.generationSha256}`;
        }
        const current = registrationArray(
            registrationsRecord['current'],
            (item): StoreStatusCurrentRegistration => {
                const value = record(item, ['registrationId', 'generationSha256', 'project', 'lockSha256', 'packages']);
                const base = cleanupRegistration({
                    registrationId: value['registrationId'],
                    generationSha256: value['generationSha256'],
                    project: value['project'],
                });
                if (typeof value['lockSha256'] !== 'string' || !SHA256.test(value['lockSha256'])) {
                    throw new TypeError('report lock digest');
                }
                return Object.freeze({
                    ...base,
                    lockSha256: value['lockSha256'],
                    packages: safeCount(value['packages']),
                });
            },
            key,
        );
        const superseded = registrationArray(registrationsRecord['superseded'], cleanupRegistration, key);
        const orphaned = registrationArray(registrationsRecord['orphaned'], cleanupRegistration, key);
        const stale = registrationArray(
            registrationsRecord['stale'],
            (item): StoreStatusStaleRegistration => {
                const value = record(item, ['registrationId', 'generationSha256', 'project', 'issue']);
                const base = cleanupRegistration({
                    registrationId: value['registrationId'],
                    generationSha256: value['generationSha256'],
                    project: value['project'],
                });
                if (
                    value['issue'] !== 'unavailable' &&
                    value['issue'] !== 'state-mismatch' &&
                    value['issue'] !== 'transaction-present'
                ) {
                    throw new TypeError('report stale issue');
                }
                return Object.freeze({ ...base, issue: value['issue'] });
            },
            key,
        );
        const corruptRegistrations = digestArray(registrationsRecord['corrupt']);
        const busyRegistrations = digestArray(registrationsRecord['busy']);
        const generationKeys = [...current, ...superseded, ...orphaned, ...stale].map(key);
        const classifiedRegistrationIds = new Set(
            [...current, ...superseded, ...orphaned, ...stale].map(({ registrationId }) => registrationId),
        );
        if (
            new Set(generationKeys).size !== generationKeys.length ||
            safeCount(registrationsRecord['total']) !== generationKeys.length ||
            corruptRegistrations.some(
                (registrationId) =>
                    classifiedRegistrationIds.has(registrationId) || busyRegistrations.includes(registrationId),
            ) ||
            busyRegistrations.some((registrationId) => classifiedRegistrationIds.has(registrationId))
        ) {
            throw new TypeError('report registration truth');
        }
        const objectsRecord = record(top['objects'], [
            'total',
            'referenced',
            'unreferenced',
            'missingReferenced',
            'busy',
            'corrupt',
            'logicalBytes',
            'unreferencedLogicalBytes',
        ]);
        const referenced = digestArray(objectsRecord['referenced']);
        const unreferenced = digestArray(objectsRecord['unreferenced']);
        const missingReferenced = digestArray(objectsRecord['missingReferenced']);
        const busy = digestArray(objectsRecord['busy']);
        const corrupt = digestArray(objectsRecord['corrupt']);
        const existing = [...referenced, ...unreferenced, ...busy, ...corrupt];
        const allObjectClassifications = [...existing, ...missingReferenced];
        if (
            new Set(allObjectClassifications).size !== allObjectClassifications.length ||
            safeCount(objectsRecord['total']) !== existing.length ||
            typeof objectsRecord['logicalBytes'] !== 'string' ||
            !DECIMAL.test(objectsRecord['logicalBytes']) ||
            typeof objectsRecord['unreferencedLogicalBytes'] !== 'string' ||
            !DECIMAL.test(objectsRecord['unreferencedLogicalBytes']) ||
            BigInt(objectsRecord['unreferencedLogicalBytes']) > BigInt(objectsRecord['logicalBytes']) ||
            (existing.length === 0 && objectsRecord['logicalBytes'] !== '0') ||
            (referenced.length + unreferenced.length > 0 && objectsRecord['logicalBytes'] === '0') ||
            (unreferenced.length === 0 && objectsRecord['unreferencedLogicalBytes'] !== '0') ||
            (unreferenced.length > 0 && objectsRecord['unreferencedLogicalBytes'] === '0')
        ) {
            throw new TypeError('report object truth');
        }
        const hasIssues =
            top['transaction'] === 'busy' ||
            stale.length > 0 ||
            corruptRegistrations.length > 0 ||
            busyRegistrations.length > 0 ||
            missingReferenced.length > 0 ||
            busy.length > 0 ||
            corrupt.length > 0;
        if ((top['outcome'] === 'issues') !== hasIssues) {
            throw new TypeError('report outcome');
        }
        if (
            top['store'] === 'missing' &&
            (top['transaction'] !== 'idle' ||
                top['outcome'] !== 'healthy' ||
                generationKeys.length !== 0 ||
                corruptRegistrations.length !== 0 ||
                busyRegistrations.length !== 0 ||
                allObjectClassifications.length !== 0 ||
                objectsRecord['logicalBytes'] !== '0' ||
                objectsRecord['unreferencedLogicalBytes'] !== '0')
        ) {
            throw new TypeError('missing store truth');
        }
        return Object.freeze({
            schema: STORE_STATUS_REPORT_VERSION,
            store: top['store'],
            transaction: top['transaction'],
            registrations: Object.freeze({
                total: generationKeys.length,
                current,
                superseded,
                orphaned,
                stale,
                corrupt: corruptRegistrations,
                busy: busyRegistrations,
            }),
            objects: Object.freeze({
                total: existing.length,
                referenced,
                unreferenced,
                missingReferenced,
                busy,
                corrupt,
                logicalBytes: objectsRecord['logicalBytes'],
                unreferencedLogicalBytes: objectsRecord['unreferencedLogicalBytes'],
            }),
            outcome: top['outcome'],
        });
    } catch (cause) {
        throw new TypeError(`Invalid ${STORE_STATUS_REPORT_VERSION} document`, { cause });
    }
}

export function encodeStoreStatusReport(input: StoreStatusReport): string {
    return `${JSON.stringify(decodeStoreStatusReport(input))}\n`;
}

export const STORE_PRUNE_REPORT_VERSION = 'erden.store-prune-report/v1' as const;
export const STORE_PRUNE_REACQUISITION_WARNING =
    'Warning: pruning can make private or revoked packages unavailable offline when they cannot be reacquired.' as const;

export interface StorePruneReport {
    readonly schema: typeof STORE_PRUNE_REPORT_VERSION;
    readonly warning: typeof STORE_PRUNE_REACQUISITION_WARNING;
    readonly dryRun: boolean;
    readonly registrations: Readonly<{
        readonly total: number;
        readonly retired: ReadonlyArray<StoreStatusCleanupRegistration>;
    }>;
    readonly objects: Readonly<{
        readonly total: number;
        readonly removed: ReadonlyArray<string>;
        readonly logicalBytes: string;
    }>;
    readonly outcome: 'nothing-to-prune' | 'planned' | 'pruned';
}

export function decodeStorePruneReport(input: unknown): StorePruneReport {
    try {
        const top = record(input, ['schema', 'warning', 'dryRun', 'registrations', 'objects', 'outcome']);
        if (
            top['schema'] !== STORE_PRUNE_REPORT_VERSION ||
            top['warning'] !== STORE_PRUNE_REACQUISITION_WARNING ||
            typeof top['dryRun'] !== 'boolean' ||
            (top['outcome'] !== 'nothing-to-prune' && top['outcome'] !== 'planned' && top['outcome'] !== 'pruned')
        ) {
            throw new TypeError('prune report header');
        }
        const registrationsRecord = record(top['registrations'], ['total', 'retired']);
        const retired = registrationArray(
            registrationsRecord['retired'],
            cleanupRegistration,
            (item) => `${item.registrationId}.${item.generationSha256}`,
        );
        if (safeCount(registrationsRecord['total']) !== retired.length) {
            throw new TypeError('prune registration count');
        }
        const objectsRecord = record(top['objects'], ['total', 'removed', 'logicalBytes']);
        const removed = digestArray(objectsRecord['removed']);
        if (
            safeCount(objectsRecord['total']) !== removed.length ||
            typeof objectsRecord['logicalBytes'] !== 'string' ||
            !DECIMAL.test(objectsRecord['logicalBytes'])
        ) {
            throw new TypeError('prune object truth');
        }
        const empty = retired.length === 0 && removed.length === 0;
        if (
            (top['outcome'] === 'nothing-to-prune') !== empty ||
            (top['dryRun'] && top['outcome'] === 'pruned') ||
            (!top['dryRun'] && top['outcome'] === 'planned')
        ) {
            throw new TypeError('prune outcome truth');
        }
        return Object.freeze({
            schema: STORE_PRUNE_REPORT_VERSION,
            warning: STORE_PRUNE_REACQUISITION_WARNING,
            dryRun: top['dryRun'],
            registrations: Object.freeze({ total: retired.length, retired }),
            objects: Object.freeze({ total: removed.length, removed, logicalBytes: objectsRecord['logicalBytes'] }),
            outcome: top['outcome'],
        });
    } catch (cause) {
        throw new TypeError(`Invalid ${STORE_PRUNE_REPORT_VERSION} document`, { cause });
    }
}

export function encodeStorePruneReport(input: StorePruneReport): string {
    return `${JSON.stringify(decodeStorePruneReport(input))}\n`;
}
