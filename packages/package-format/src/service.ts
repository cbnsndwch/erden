import { Context, Effect } from 'effect';

import {
    encodePackage,
    validatePackageArchive,
    type EncodedPackage,
    type PackageArchiveSource,
    type PackageCodecLimits,
    type PackageEncodeInput,
    type ValidatedPackageArchive,
} from './codec.js';
import { PackageCodecError } from './errors.js';
import {
    extractPackageArchive,
    makeNodePackageExtractionOperations,
    type ExtractPackageOptions,
    type PackageExtractionOperations,
} from './extraction.js';

export interface PackageCodecShape {
    readonly encode: (input: PackageEncodeInput) => Effect.Effect<EncodedPackage, PackageCodecError>;
    readonly validate: (
        source: PackageArchiveSource,
        limits?: Partial<PackageCodecLimits>,
    ) => Effect.Effect<ValidatedPackageArchive, PackageCodecError>;
    readonly extract: (
        source: PackageArchiveSource,
        options: ExtractPackageOptions,
    ) => Effect.Effect<ValidatedPackageArchive, PackageCodecError>;
}

export const PackageCodec = Context.Service<PackageCodecShape>('@erden/package-format/PackageCodec');

export function makePackageCodec(
    extractionOperations: PackageExtractionOperations = makeNodePackageExtractionOperations(),
): PackageCodecShape {
    return Object.freeze({
        encode: (input: PackageEncodeInput) =>
            Effect.try({
                try: () => encodePackage(input),
                catch: (error) =>
                    error instanceof PackageCodecError
                        ? error
                        : new PackageCodecError('manifest-integrity', 'Package input could not be encoded', error),
            }),
        validate: validatePackageArchive,
        extract: (source: PackageArchiveSource, options: ExtractPackageOptions) =>
            extractPackageArchive(source, options, extractionOperations),
    });
}

export const packageCodec = makePackageCodec();
