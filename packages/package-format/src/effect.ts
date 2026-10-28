import { Effect } from 'effect';

interface AbortablePromise<A> {
    readonly controller: AbortController;
    readonly promise: Promise<A>;
}

/** Await an abort-aware Promise and make Effect interruption wait for its cleanup path. */
export function fromAbortablePackagePromise<A, E>(
    operation: (signal: AbortSignal) => Promise<A>,
    mapError: (error: unknown) => E,
): Effect.Effect<A, E> {
    return Effect.acquireUseRelease(
        Effect.sync((): AbortablePromise<A> => {
            const controller = new AbortController();
            return Object.freeze({ controller, promise: operation(controller.signal) });
        }),
        ({ promise }) => Effect.tryPromise({ try: () => promise, catch: mapError }),
        ({ controller, promise }) =>
            Effect.promise(async () => {
                controller.abort();
                await promise.catch(() => undefined);
            }),
    );
}
