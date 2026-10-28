import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { Effect } from 'effect';
import { Store, type Quad, type Term } from 'n3';

import {
    OntologyAssemblyLimitError,
    OntologySourceParseError,
    OntologySourceRefusedError,
    RequiredStageUnavailableError,
    TurtleSourceEncodingError,
    TurtleSourceParseError,
    UnsupportedSemanticFormatError,
} from './errors.js';
import type {
    AssembledOntology,
    LoadedTurtleSource,
    QuadContributor,
    QuadProvenance,
    TurtleSourceDescriptor,
} from './model.js';
import { compareCodePoints } from './order.js';
import type { TextResourcePort } from './ports.js';
import { parseOntologySourceText } from './source-formats/parse.js';

function termKey(term: Term): string {
    switch (term.termType) {
        case 'NamedNode':
            return `N${String(term.value.length)}:${term.value}`;
        case 'BlankNode':
            return `B${String(term.value.length)}:${term.value}`;
        case 'Variable':
            return `V${String(term.value.length)}:${term.value}`;
        case 'DefaultGraph':
            return 'D';
        case 'Literal':
            return `L${JSON.stringify([
                term.value,
                term.language,
                term.datatype.value,
                'direction' in term ? term.direction : '',
            ])}`;
    }
}

export function quadKey(quad: Quad): string {
    return [termKey(quad.subject), termKey(quad.predicate), termKey(quad.object), termKey(quad.graph)].join('|');
}

/**
 * Parses one Turtle source exactly as Erden always has. Multi-format callers use `parseOntologySourceText`,
 * which routes `.ttl` through this same n3 path.
 */
export function parseTurtleSource(
    descriptor: TurtleSourceDescriptor,
    text: string,
    maximumQuads?: number,
): ReadonlyArray<Quad> {
    if (maximumQuads !== undefined && (!Number.isSafeInteger(maximumQuads) || maximumQuads < 0)) {
        throw new OntologyAssemblyLimitError('statements');
    }
    if (!descriptor.locator.toLowerCase().endsWith('.ttl')) {
        throw new UnsupportedSemanticFormatError('source', descriptor.locator, '.ttl');
    }
    return parseOntologySourceText(descriptor, text, maximumQuads);
}

interface MutableQuadProvenance {
    readonly quad: Quad;
    readonly asserted: Array<
        QuadContributor & { readonly provenance: { readonly _tag: 'Asserted'; readonly revision?: string } }
    >;
    readonly inferred: Array<
        QuadContributor & {
            readonly provenance: {
                readonly _tag: 'Inferred';
                readonly reasoner: string;
                readonly operation: string;
                readonly premises: ReadonlyArray<string>;
            };
        }
    >;
}

export type AssembleOntologyError =
    | OntologyAssemblyLimitError
    | OntologySourceParseError
    | OntologySourceRefusedError
    | RequiredStageUnavailableError
    | TurtleSourceEncodingError
    | TurtleSourceParseError
    | UnsupportedSemanticFormatError;

export interface OntologyAssemblyLimits {
    readonly maximumSourceBytes: number;
    readonly maximumStatements: number;
}

export function assembleOntology(
    resources: TextResourcePort,
    descriptors: ReadonlyArray<TurtleSourceDescriptor>,
    limits?: OntologyAssemblyLimits,
): Effect.Effect<AssembledOntology, AssembleOntologyError> {
    const maximumSourceBytes = limits?.maximumSourceBytes;
    const maximumStatements = limits?.maximumStatements;
    return Effect.gen(function* () {
        if (
            limits !== undefined &&
            (!Number.isSafeInteger(maximumSourceBytes) ||
                (maximumSourceBytes ?? -1) < 0 ||
                !Number.isSafeInteger(maximumStatements) ||
                (maximumStatements ?? -1) < 0)
        ) {
            return yield* Effect.fail(new OntologyAssemblyLimitError('bytes'));
        }
        if (descriptors.length === 0) {
            return yield* Effect.fail(
                new RequiredStageUnavailableError(
                    'source',
                    null,
                    'at least one ordered Turtle source descriptor is required',
                ),
            );
        }
        const dataset = new Store();
        const loaded: LoadedTurtleSource[] = [];
        const byQuad = new Map<string, MutableQuadProvenance>();
        let sourceBytes = 0;
        let statements = 0;
        for (let sourceIndex = 0; sourceIndex < descriptors.length; sourceIndex += 1) {
            const descriptor = descriptors[sourceIndex];
            if (descriptor === undefined) {
                continue;
            }
            const bytes = yield* resources
                .readBytes(descriptor.locator)
                .pipe(
                    Effect.mapError((cause) => new RequiredStageUnavailableError('source', descriptor.locator, cause)),
                );
            const text = yield* Effect.try({
                try: () => {
                    sourceBytes += bytes.byteLength;
                    if (maximumSourceBytes !== undefined && sourceBytes > maximumSourceBytes) {
                        throw new OntologyAssemblyLimitError('bytes');
                    }
                    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
                },
                catch: (cause) =>
                    cause instanceof OntologyAssemblyLimitError
                        ? cause
                        : new TurtleSourceEncodingError(descriptor.id, descriptor.locator, cause),
            });
            const quads = yield* Effect.try({
                try: () =>
                    parseOntologySourceText(
                        descriptor,
                        text,
                        maximumStatements === undefined ? undefined : maximumStatements - statements,
                    ),
                catch: (
                    cause,
                ):
                    | TurtleSourceParseError
                    | OntologySourceParseError
                    | OntologySourceRefusedError
                    | UnsupportedSemanticFormatError
                    | OntologyAssemblyLimitError => {
                    if (
                        cause instanceof TurtleSourceParseError ||
                        cause instanceof OntologySourceParseError ||
                        cause instanceof OntologySourceRefusedError ||
                        cause instanceof UnsupportedSemanticFormatError ||
                        cause instanceof OntologyAssemblyLimitError
                    ) {
                        return cause;
                    }
                    return new TurtleSourceParseError(
                        descriptor.id,
                        { file: descriptor.locator, line: 1, column: 1 },
                        cause,
                    );
                },
            });
            statements += quads.length;
            loaded.push({
                descriptor,
                sourceIndex,
                tripleCount: quads.length,
                contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                bytes: Uint8Array.from(bytes),
                text,
            });
            const contributor: QuadContributor = {
                sourceId: descriptor.id,
                sourceIndex,
                owner: descriptor.owner,
                locator: descriptor.locator,
                provenance: descriptor.provenance,
            };
            for (const quad of quads) {
                dataset.addQuad(quad);
                const key = quadKey(quad);
                let provenance = byQuad.get(key);
                if (provenance === undefined) {
                    provenance = { quad, asserted: [], inferred: [] };
                    byQuad.set(key, provenance);
                }
                if (descriptor.provenance._tag === 'Asserted') {
                    if (!provenance.asserted.some((entry) => entry.sourceIndex === sourceIndex)) {
                        provenance.asserted.push({ ...contributor, provenance: descriptor.provenance });
                    }
                } else {
                    if (!provenance.inferred.some((entry) => entry.sourceIndex === sourceIndex)) {
                        provenance.inferred.push({ ...contributor, provenance: descriptor.provenance });
                    }
                }
            }
        }
        const provenance: QuadProvenance[] = [...byQuad]
            .sort(([left], [right]) => compareCodePoints(left, right))
            .map(([key, value]) => ({
                key,
                quad: value.quad,
                asserted: value.asserted,
                inferred: value.inferred,
            }));
        return { dataset, sources: loaded, provenance };
    });
}
