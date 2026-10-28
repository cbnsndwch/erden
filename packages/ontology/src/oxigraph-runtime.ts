import { createRequire } from 'node:module';

/**
 * The one in-process Oxigraph WebAssembly instance that source parsing and competency questions share.
 *
 * A WebAssembly trap (a panic, a stack overflow, an out-of-bounds access) leaves the instance's memory and stack in
 * an undefined state, after which every later call fails too. One hostile upload must not break parsing and queries
 * for the rest of the process, so a caller that sees a trap discards the instance and the next caller loads a fresh
 * one from the same pinned package.
 */

const require = createRequire(import.meta.url);
let instance: unknown;

/** The current Oxigraph module, loading it on first use or after a trap discarded the last one. */
export function oxigraphModule(): unknown {
    instance ??= require('oxigraph') as unknown;
    return instance;
}

/** Whether a thrown value is a WebAssembly trap, after which the instance that raised it cannot be trusted. */
export function isWebAssemblyTrap(cause: unknown): boolean {
    return cause instanceof WebAssembly.RuntimeError;
}

/** Discards the instance after a trap so the next call instantiates a fresh one; other errors leave it in place. */
export function discardOxigraphAfterTrap(cause: unknown): void {
    if (!isWebAssemblyTrap(cause)) {
        return;
    }
    Reflect.deleteProperty(require.cache, require.resolve('oxigraph'));
    instance = undefined;
}

/**
 * Runs one self-contained Oxigraph operation. A trap may come from an instance an earlier, unrelated call left
 * broken, so after a trap the operation runs once more on a fresh instance; a second trap is the input's own and
 * is thrown, with that instance discarded too.
 */
export function withOxigraph<R>(operation: (oxigraph: unknown) => R): R {
    try {
        return operation(oxigraphModule());
    } catch (cause) {
        if (!isWebAssemblyTrap(cause)) {
            throw cause;
        }
        discardOxigraphAfterTrap(cause);
    }
    try {
        return operation(oxigraphModule());
    } catch (cause) {
        discardOxigraphAfterTrap(cause);
        throw cause;
    }
}
