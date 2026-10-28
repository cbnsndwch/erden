import type { Effect } from 'effect';

export interface ApplicationOperation<Name extends string, Success, Failure = never, Requirements = never> {
    readonly name: Name;
    readonly effect: Effect.Effect<Success, Failure, Requirements>;
}

export function defineApplicationOperation<const Name extends string, Success, Failure, Requirements>(
    name: Name,
    effect: Effect.Effect<Success, Failure, Requirements>,
): ApplicationOperation<Name, Success, Failure, Requirements> {
    return Object.freeze({ name, effect });
}
