import type { PackageFixtureErrorCode } from './contract.js';

export type PackageCodecErrorCode =
    | PackageFixtureErrorCode
    | 'invalid-limits'
    | 'compressed-limit'
    | 'source-read'
    | 'sink-write'
    | 'destination-conflict'
    | 'destination-unsafe'
    | 'extraction-io'
    | 'extraction-rollback-unsafe';

/** A deterministic, physical-path-free package codec failure. */
export class PackageCodecError extends Error {
    readonly code: PackageCodecErrorCode;
    override readonly cause!: unknown;

    constructor(code: PackageCodecErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'PackageCodecError';
        this.code = code;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
    }
}
