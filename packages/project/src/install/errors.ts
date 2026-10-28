import type { LockAvailability } from '../store/index.js';

export type InstallProjectErrorCode =
    | 'INSTALL_PROJECT_INVALID_INPUT'
    | 'INSTALL_PROJECT_MANIFEST_UNAVAILABLE'
    | 'INSTALL_PROJECT_TOOLCHAIN_UNAVAILABLE'
    | 'INSTALL_PROJECT_LOCK_INVALID'
    | 'INSTALL_PROJECT_FROZEN_LOCK_REQUIRED'
    | 'INSTALL_PROJECT_OFFLINE_LOCK_REQUIRED'
    | 'INSTALL_PROJECT_RESOLUTION_FAILED'
    | 'INSTALL_PROJECT_REGISTRY_UNAVAILABLE'
    | 'INSTALL_PROJECT_PACKAGES_UNAVAILABLE'
    | 'INSTALL_PROJECT_STORE_FAILURE'
    | 'INSTALL_PROJECT_TRANSACTION_PENDING';

const installProjectErrors = new WeakSet<object>();

export class InstallProjectError extends Error {
    readonly code: InstallProjectErrorCode;
    override readonly cause!: unknown;

    constructor(code: InstallProjectErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'InstallProjectError';
        this.code = code;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        installProjectErrors.add(this);
        if (new.target === InstallProjectError) {
            Object.freeze(this);
        }
    }
}

/** Exact constructor-family brand check that is total for hostile values. */
export function isInstallProjectError(value: unknown): value is InstallProjectError {
    return value !== null && typeof value === 'object' && installProjectErrors.has(value);
}

export class InstallProjectUnavailableError extends InstallProjectError {
    readonly availability: LockAvailability;

    constructor(availability: LockAvailability) {
        super('INSTALL_PROJECT_PACKAGES_UNAVAILABLE', 'The exact locked package closure is not locally available');
        this.name = 'InstallProjectUnavailableError';
        function compare(left: string, right: string): number {
            return left < right ? -1 : left > right ? 1 : 0;
        }
        const missing = [...availability.missing].sort(compare);
        const corrupt = [...availability.corrupt].sort(compare);
        const busy = [...availability.busy].sort(compare);
        const combined = [...missing, ...corrupt, ...busy];
        if (
            availability.status !== 'unavailable' ||
            !Number.isSafeInteger(availability.packages) ||
            availability.packages < 0 ||
            Object.is(availability.packages, -0) ||
            combined.length === 0 ||
            combined.length > availability.packages ||
            new Set(combined).size !== combined.length ||
            combined.some((value) => !/^[0-9a-f]{64}$/u.test(value))
        ) {
            throw new TypeError('Install unavailability must be one closed deterministic issue set');
        }
        this.availability = Object.freeze({
            status: availability.status,
            packages: availability.packages,
            missing: Object.freeze(missing),
            corrupt: Object.freeze(corrupt),
            busy: Object.freeze(busy),
        });
        Object.freeze(this);
    }
}

const RESIDUE_NAME = /^\.erden\.dependencies\.[A-Za-z0-9._-]{1,200}$/u;

/** An interrupted install left residue that recovery could not authenticate; it names the files by basename. */
export class InstallProjectTransactionPendingError extends InstallProjectError {
    readonly residue: ReadonlyArray<string>;

    constructor(residue: ReadonlyArray<string>, cause?: unknown) {
        super(
            'INSTALL_PROJECT_TRANSACTION_PENDING',
            'An interrupted install left dependency transaction files that could not be recovered safely',
            cause,
        );
        this.name = 'InstallProjectTransactionPendingError';
        this.residue = Object.freeze(
            [...new Set(residue.filter((name) => RESIDUE_NAME.test(name)))].sort((left, right) =>
                left < right ? -1 : left > right ? 1 : 0,
            ),
        );
        Object.freeze(this);
    }
}
