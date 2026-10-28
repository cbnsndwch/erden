import { CurrentToolchainError } from '@erden/contracts';

/** The resolver's code when a source checkout runs an unreleased reasoner that has not been built yet. */
export const REASONER_SOURCE_BUILD_MISSING = 'SOURCE_BUILD_MISSING';

/**
 * What to do when this Erden is a source checkout without a reasoner build: the reasoner version it needs has no
 * released binary yet, so it runs one built from the same source (docs/testing.md).
 */
export const REASONER_SOURCE_BUILD_GUIDANCE =
    'This Erden source checkout has no reasoner build. Run `pnpm run reasoner:build` in the Erden repository (it needs the Rust toolchain that reasoner/rust-toolchain.toml pins), or set ERDEN_REASONER_BIN to the absolute path of a reasoner built from the same source, then run `erden doctor` again.';

/** The source-build guidance when `error`, or a cause below it, is a toolchain failure for a missing source build. */
export function toolchainGuidance(error: unknown): string | null {
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
        if (current instanceof CurrentToolchainError) {
            return current.reasonerFailureCode === REASONER_SOURCE_BUILD_MISSING
                ? REASONER_SOURCE_BUILD_GUIDANCE
                : null;
        }
        current = current.cause;
    }
    return null;
}
