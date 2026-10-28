import type { Quad, Term } from 'n3';

import type {
    RDF_COMPARISON_LIMITS,
    RdfComparisonComplete,
    RdfComparisonComponent,
    RdfComparisonSummaryReason,
} from './model.js';

interface Canonicalizer {
    readonly NQuads: { readonly serializeQuad: (quad: Quad) => string };
    readonly canonize: (
        dataset: ReadonlyArray<Quad>,
        options: {
            readonly algorithm: 'RDFC-1.0';
            readonly maxDeepIterations: number;
            readonly createMessageDigest: () => { update: (value: string) => void; digest: () => string };
        },
    ) => Promise<string>;
}

interface WorkerInput {
    readonly input: string;
    readonly verification: boolean;
    readonly n3Path: string;
    readonly canonicalizerPath: string;
    readonly limits: typeof RDF_COMPARISON_LIMITS;
}

/** Self-contained: native import is supplied to the emitted worker function. */
export async function rdfComparisonWorker(load: (specifier: string) => Promise<unknown>): Promise<void> {
    const { parentPort, workerData } = (await load('node:worker_threads')) as {
        readonly parentPort: import('node:worker_threads').MessagePort | null;
        readonly workerData: unknown;
    };
    const { createHash } = (await load('node:crypto')) as typeof import('node:crypto');
    const { EventEmitter } = (await load('node:events')) as typeof import('node:events');
    const { pathToFileURL } = (await load('node:url')) as typeof import('node:url');
    const data = workerData as WorkerInput;
    const { Parser, DataFactory } = ((await load(pathToFileURL(data.n3Path).href)) as { default: typeof import('n3') })
        .default;
    const canonicalizer = ((await load(pathToFileURL(data.canonicalizerPath).href)) as { default: Canonicalizer })
        .default;
    const limits = data.limits;
    let hashOperations = 0;
    let hashBytes = 0;

    class Capacity extends Error {
        readonly reason: RdfComparisonSummaryReason;
        constructor(reason: RdfComparisonSummaryReason) {
            super(reason);
            this.reason = reason;
        }
    }
    class Invalid extends Error {}

    function bounded(value: string, maximum: number): void {
        if (!value.isWellFormed()) {
            throw new Invalid();
        }
        if (Buffer.byteLength(value) > maximum) {
            throw new Capacity('term-limit');
        }
    }
    function iri(value: string): void {
        bounded(value, limits.maxIriBytes);
        if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^<>"{}|^`\\\u0000-\u0020\u007f-\u009f]*$/u.test(value)) {
            throw new Invalid();
        }
    }
    function term(value: Term): void {
        switch (value.termType) {
            case 'NamedNode':
                iri(value.value);
                return;
            case 'BlankNode':
                bounded(value.value, limits.maxBlankNodeBytes);
                return;
            case 'DefaultGraph':
                return;
            case 'Literal':
                bounded(value.value, limits.maxLiteralBytes);
                bounded(value.language, limits.maxLanguageBytes);
                iri(value.datatype.value);
                if (
                    (value.language !== '' && !/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/u.test(value.language)) ||
                    ('direction' in value && value.direction !== '')
                ) {
                    throw new Invalid();
                }
                return;
            default:
                throw new Invalid();
        }
    }
    function digestFactory() {
        if (++hashOperations > limits.maxHashOperations) {
            throw new Capacity('canonicalization-limit');
        }
        const hash = createHash('sha256');
        return {
            update(value: string) {
                hashBytes += Buffer.byteLength(value);
                if (hashBytes > limits.maxHashBytes) {
                    throw new Capacity('canonicalization-limit');
                }
                hash.update(value);
            },
            digest: () => hash.digest('hex'),
        };
    }
    function blankNodes(quad: Quad): string[] {
        return [quad.subject, quad.object, quad.graph]
            .filter((value) => value.termType === 'BlankNode')
            .map((value) => value.value);
    }
    function parse(input = data.input): Quad[] {
        const unique = new Map<string, Quad>();
        let statements = 0;
        let complete = input.length === 0;
        const source = new EventEmitter();
        const parser = new Parser({ format: 'N-Quads', blankNodePrefix: '' });
        function consume(error: Error | null, raw: Quad | null): void {
            if (error) {
                throw new Invalid();
            }
            if (raw === null) {
                complete = true;
                return;
            }
            if (++statements > limits.maxStatements) {
                throw new Capacity('statement-limit');
            }
            if (
                !['NamedNode', 'BlankNode'].includes(raw.subject.termType) ||
                raw.predicate.termType !== 'NamedNode' ||
                !['NamedNode', 'BlankNode', 'Literal'].includes(raw.object.termType) ||
                !['NamedNode', 'BlankNode', 'DefaultGraph'].includes(raw.graph.termType)
            ) {
                throw new Invalid();
            }
            for (const value of [raw.subject, raw.predicate, raw.object, raw.graph]) {
                term(value);
            }
            const object =
                raw.object.termType === 'Literal' && raw.object.language !== ''
                    ? DataFactory.literal(raw.object.value, raw.object.language.toLowerCase())
                    : raw.object;
            const quad = DataFactory.quad(raw.subject, raw.predicate, object, raw.graph);
            unique.set(canonicalizer.NQuads.serializeQuad(quad), quad);
        }
        try {
            parser.parse(source, consume);
            for (let offset = 0; offset < input.length;) {
                let end = Math.min(offset + 65_536, input.length);
                const last = input.charCodeAt(end - 1);
                if (end < input.length && last >= 0xd800 && last <= 0xdbff) {
                    end -= 1;
                }
                source.emit('data', input.slice(offset, end));
                offset = end;
            }
            source.emit('end');
            if (!complete) {
                throw new Invalid();
            }
        } finally {
            source.removeAllListeners();
        }
        return [...unique.values()];
    }
    function groups(quads: ReadonlyArray<Quad>): ReadonlyArray<ReadonlyArray<Quad>> {
        const parents = new Map<string, string>();
        function find(value: string): string {
            let root = value;
            while (parents.get(root) !== root) {
                const next = parents.get(root);
                if (next === undefined) {
                    throw new Invalid();
                }
                root = next;
            }
            let current = value;
            while (current !== root) {
                const next = parents.get(current);
                if (next === undefined) {
                    throw new Invalid();
                }
                parents.set(current, root);
                current = next;
            }
            return root;
        }
        for (const quad of quads) {
            const blanks = blankNodes(quad);
            for (const value of blanks) {
                if (!parents.has(value)) {
                    parents.set(value, value);
                    if (parents.size > limits.maxBlankNodes) {
                        throw new Capacity('blank-node-limit');
                    }
                }
            }
            const first = blanks[0];
            if (first !== undefined) {
                for (const value of blanks.slice(1)) {
                    parents.set(find(value), find(first));
                }
            }
        }
        const result = new Map<string, Quad[]>();
        const sizes = new Map<string, number>();
        for (const [index, quad] of quads.entries()) {
            const first = blankNodes(quad)[0];
            const key = first === undefined ? `ground:${String(index)}` : `blank:${find(first)}`;
            let group = result.get(key);
            if (group === undefined) {
                group = [];
                result.set(key, group);
                if (result.size > limits.maxComponents) {
                    throw new Capacity('component-limit');
                }
            }
            group.push(quad);
            const size = (sizes.get(key) ?? 0) + Buffer.byteLength(canonicalizer.NQuads.serializeQuad(quad));
            sizes.set(key, size);
            if (group.length > limits.maxComponentStatements || size > limits.maxComponentBytes) {
                throw new Capacity('component-limit');
            }
        }
        return [...result.values()];
    }
    async function run(): Promise<void> {
        if (data.verification) {
            // The parent already validated closed records, hashes, counts, ordering, and output size.
            const value = JSON.parse(data.input) as RdfComparisonComplete;
            let blanks = 0;
            for (const component of value.components) {
                const quads = parse(component.nquads);
                const labels = new Set(quads.flatMap(blankNodes));
                blanks += labels.size * component.multiplicity;
                if (
                    blanks > limits.maxBlankNodes ||
                    (labels.size === 0 && component.multiplicity !== 1) ||
                    quads.length !== component.quadCount ||
                    groups(quads).length !== 1
                ) {
                    throw new Invalid();
                }
                const first = quads[0];
                if (first === undefined) {
                    throw new Invalid();
                }
                const canonical =
                    labels.size === 0
                        ? canonicalizer.NQuads.serializeQuad(first)
                        : await canonicalizer.canonize(quads, {
                              algorithm: 'RDFC-1.0',
                              maxDeepIterations: limits.maxDeepIterations,
                              createMessageDigest: digestFactory,
                          });
                if (canonical !== component.nquads) {
                    throw new Invalid();
                }
            }
            parentPort?.postMessage({ kind: 'result', value: data.input });
            return;
        }
        const quads = parse();
        const components = new Map<string, RdfComparisonComponent>();
        let outputBytes = 0;
        for (const group of groups(quads)) {
            const first = group[0];
            if (first === undefined) {
                throw new Invalid();
            }
            let nquads: string;
            try {
                nquads =
                    group.length === 1 && blankNodes(first).length === 0
                        ? canonicalizer.NQuads.serializeQuad(first)
                        : await canonicalizer.canonize(group, {
                              algorithm: 'RDFC-1.0',
                              maxDeepIterations: limits.maxDeepIterations,
                              createMessageDigest: digestFactory,
                          });
            } catch (error) {
                if (
                    error instanceof Error &&
                    error.message === `Maximum deep iterations exceeded (${String(limits.maxDeepIterations)}).`
                ) {
                    throw new Capacity('canonicalization-limit');
                }
                throw error;
            }
            if (Buffer.byteLength(nquads) > limits.maxComponentBytes) {
                throw new Capacity('component-limit');
            }
            const sha256 = createHash('sha256').update(nquads).digest('hex');
            const previous = components.get(sha256);
            if (previous !== undefined && previous.nquads !== nquads) {
                throw new Invalid();
            }
            const component = {
                nquads,
                sha256,
                multiplicity: (previous?.multiplicity ?? 0) + 1,
                quadCount: group.length,
            };
            outputBytes +=
                Buffer.byteLength(JSON.stringify(component)) -
                (previous === undefined ? 0 : Buffer.byteLength(JSON.stringify(previous)));
            if (outputBytes > limits.maxOutputBytes) {
                throw new Capacity('output-limit');
            }
            components.set(sha256, component);
        }
        const result = {
            schema: 'erden.rdf-components/v1',
            kind: 'complete',
            quadCount: quads.length,
            components: [...components.values()].sort((left, right) =>
                left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0,
            ),
        };
        const bytes = JSON.stringify(result);
        if (Buffer.byteLength(bytes) > limits.maxOutputBytes) {
            throw new Capacity('output-limit');
        }
        parentPort?.postMessage({ kind: 'result', value: bytes });
    }
    await run().catch((error: unknown) => {
        if (error instanceof Capacity) {
            parentPort?.postMessage({
                kind: 'result',
                value: JSON.stringify({ schema: 'erden.rdf-components/v1', kind: 'summary', reason: error.reason }),
            });
        } else {
            parentPort?.postMessage({ kind: error instanceof Invalid ? 'invalid' : 'unavailable' });
        }
    });
}
