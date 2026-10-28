/**
 * Self-contained worker body, emitted as source text into a confined child process. It must not reference any
 * binding outside this function: the parent passes `load` (dynamic import) and the engine directory as argv[1].
 *
 * Protocol: one JSON header line (`erden.release-query-worker-request/v1`) followed by exactly the declared and
 * inferred graph bodies, each a sequence of `<multiplicity> <byteLength>` lines and canonical component bytes. Output: one JSON line (`erden.release-query-worker-response/v1`), followed for `complete`
 * by exactly `resultBytes` raw UTF-8 result bytes, then exit 0. Any other exit code means the parent must treat the
 * run as unavailable.
 */
export async function releaseQueryWorker(load: (specifier: string) => Promise<unknown>): Promise<void> {
    const { createRequire } = (await load('node:module')) as typeof import('node:module');
    const { createHash } = (await load('node:crypto')) as typeof import('node:crypto');
    const directory = process.argv[1] ?? '';

    interface Header {
        readonly schema: string;
        readonly query: string;
        readonly form: 'select' | 'ask';
        readonly seed: string;
        readonly dataset: {
            readonly sha256: string;
            readonly declared: { readonly graph: string; readonly byteLength: number; readonly sha256: string };
            readonly inferred: { readonly graph: string; readonly byteLength: number; readonly sha256: string };
        };
        readonly limits: {
            readonly headerBytes: number;
            readonly inputBytes: number;
            readonly resultBytes: number;
            readonly resultRows: number;
            readonly termBytes: number;
            readonly chunkBytes: number;
        };
    }
    interface Term {
        readonly type: string;
        readonly value: string;
    }
    function exit(code: number): never {
        process.exit(code);
    }
    function respond(value: Readonly<Record<string, unknown>>, result?: Buffer): void {
        if (result === undefined) {
            process.stdout.write(`${JSON.stringify(value)}\n`, () => {
                process.exit(0);
            });
            return;
        }
        // The result follows its header as raw bytes, so escaping never inflates it beyond the stdout budget.
        process.stdout.write(`${JSON.stringify({ ...value, resultBytes: result.byteLength })}\n`);
        process.stdout.write(result, () => {
            process.exit(0);
        });
    }

    // Network globals are removed before any engine code runs; the engine has no HTTP client of its own.
    for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
        Reflect.deleteProperty(globalThis, name);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
        total += chunk.byteLength;
        if (total > 64 * 1_024 + 24 * 1_048_576) {
            exit(3);
        }
        chunks.push(chunk);
    }
    const input = Buffer.concat(chunks, total);
    const newline = input.indexOf(10);
    if (newline < 1 || newline > 64 * 1_024) {
        exit(3);
    }
    let raw: Readonly<Record<string, unknown>>;
    try {
        raw = JSON.parse(input.subarray(0, newline).toString('utf8')) as Readonly<Record<string, unknown>>;
    } catch {
        return exit(3);
    }
    const seedText = raw['seed'];
    if (
        raw['schema'] !== 'erden.release-query-worker-request/v1' ||
        typeof raw['query'] !== 'string' ||
        (raw['form'] !== 'select' && raw['form'] !== 'ask') ||
        typeof seedText !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(seedText)
    ) {
        exit(3);
    }
    const header = raw as unknown as Header;
    const body = input.subarray(newline + 1);
    const declaredLength = header.dataset.declared.byteLength;
    const inferredLength = header.dataset.inferred.byteLength;
    if (
        !Number.isSafeInteger(declaredLength) ||
        !Number.isSafeInteger(inferredLength) ||
        declaredLength < 0 ||
        inferredLength < 0 ||
        declaredLength + inferredLength !== body.byteLength ||
        body.byteLength > header.limits.inputBytes
    ) {
        exit(3);
    }
    const declared = body.subarray(0, declaredLength);
    const inferred = body.subarray(declaredLength);
    if (
        createHash('sha256').update(declared).digest('hex') !== header.dataset.declared.sha256 ||
        createHash('sha256').update(inferred).digest('hex') !== header.dataset.inferred.sha256
    ) {
        exit(3);
    }

    // Deterministic engine entropy: blank-node identifiers and hash seeds depend only on the dataset and query.
    const state = new Uint32Array(4);
    for (let index = 0; index < 4; index += 1) {
        state[index] = Number.parseInt(header.seed.slice(index * 8, index * 8 + 8), 16) >>> 0 || 0x9e3779b9;
    }
    function nextRandom(): number {
        let t = state[3] ?? 0;
        const s = state[0] ?? 0;
        state[3] = state[2] ?? 0;
        state[2] = state[1] ?? 0;
        state[1] = s;
        t ^= t << 11;
        t ^= t >>> 8;
        state[0] = (t ^ s ^ (s >>> 19)) >>> 0;
        return state[0];
    }
    Object.defineProperty(globalThis, 'crypto', {
        configurable: false,
        value: Object.freeze({
            getRandomValues(array: Uint8Array): Uint8Array {
                for (let index = 0; index < array.length; index += 1) {
                    array[index] = nextRandom() & 0xff;
                }
                return array;
            },
        }),
    });

    interface Store {
        readonly load: (input: Iterable<Uint8Array>, options: Readonly<Record<string, unknown>>) => void;
        readonly query: (query: string, options: Readonly<Record<string, unknown>>) => unknown;
    }
    let oxigraph: { readonly Store: new () => Store; readonly namedNode: (value: string) => unknown };
    let store: Store;
    try {
        const require = createRequire(`${directory}/node.js`);
        oxigraph = require(`${directory}/node.js`) as typeof oxigraph;
        store = new oxigraph.Store();
    } catch {
        return exit(3);
    }
    interface Component {
        readonly text: Buffer;
        readonly multiplicity: number;
    }
    /** Split one graph body into its `<multiplicity> <byteLength>` framed components. */
    function components(bytes: Buffer): ReadonlyArray<Component> | null {
        const output: Component[] = [];
        let offset = 0;
        while (offset < bytes.byteLength) {
            const newline = bytes.indexOf(10, offset);
            const match =
                newline < 0 || newline - offset > 40
                    ? null
                    : /^([1-9][0-9]*) (0|[1-9][0-9]*)$/u.exec(bytes.toString('latin1', offset, newline));
            const multiplicity = Number(match?.[1]);
            const length = Number(match?.[2]);
            if (!Number.isSafeInteger(multiplicity) || !Number.isSafeInteger(length)) {
                return null;
            }
            offset = newline + 1 + length;
            if (offset > bytes.byteLength) {
                return null;
            }
            output.push({ text: bytes.subarray(newline + 1, offset), multiplicity });
        }
        return output;
    }
    const declaredComponents = components(declared);
    const inferredComponents = components(inferred);
    if (declaredComponents === null || inferredComponents === null) {
        return exit(3);
    }

    // Instance expansion happens here, inside the worker's time and memory budgets: instance k of component c in
    // graph g prefixes every blank-node label with `q{g}{c}_{k}_`. Output is copied into fixed-size chunks.
    class Malformed extends Error {}
    const chunkBytes = header.limits.chunkBytes;
    let expanded = 0;
    let buffer = Buffer.allocUnsafe(chunkBytes);
    let used = 0;
    const ready: Buffer[] = [];
    function emit(piece: Uint8Array): void {
        expanded += piece.byteLength;
        if (expanded > header.limits.inputBytes) {
            throw new Malformed();
        }
        for (let offset = 0; offset < piece.byteLength;) {
            const count = Math.min(chunkBytes - used, piece.byteLength - offset);
            buffer.set(piece.subarray(offset, offset + count), used);
            used += count;
            offset += count;
            if (used === chunkBytes) {
                ready.push(buffer);
                buffer = Buffer.allocUnsafe(chunkBytes);
                used = 0;
            }
        }
    }
    function skipTerm(text: Buffer, position: number): number {
        if (text[position] === 60) {
            const end = text.indexOf(62, position);
            return end < 0 ? -1 : end + 1;
        }
        if (text[position] !== 34) {
            return -1;
        }
        let current = position + 1;
        while (current < text.byteLength && text[current] !== 34) {
            current += text[current] === 92 ? 2 : 1;
        }
        if (current >= text.byteLength) {
            return -1;
        }
        current += 1;
        if (text[current] === 64) {
            while (current < text.byteLength && text[current] !== 32) {
                current += 1;
            }
        } else if (text[current] === 94 && text[current + 1] === 94 && text[current + 2] === 60) {
            const end = text.indexOf(62, current);
            return end < 0 ? -1 : end + 1;
        }
        return current;
    }
    function isLabel(code: number | undefined): boolean {
        return (
            code !== undefined &&
            ((code >= 48 && code <= 57) ||
                (code >= 65 && code <= 90) ||
                (code >= 97 && code <= 122) ||
                code === 95 ||
                code === 45 ||
                code === 46)
        );
    }
    /** Emit one `<term> <term> <term> .` line with prefixed labels; returns the offset after it. */
    function statement(text: Buffer, start: number, prefix: Buffer): number {
        let position = start;
        let from = start;
        for (let terms = 0; terms < 3; terms += 1) {
            if (text[position] === 95 && text[position + 1] === 58) {
                position += 2;
                emit(text.subarray(from, position));
                emit(prefix);
                from = position;
                while (isLabel(text[position])) {
                    position += 1;
                }
                if (position === from || text[position - 1] === 46) {
                    throw new Malformed();
                }
            } else {
                position = skipTerm(text, position);
                if (position < 0) {
                    throw new Malformed();
                }
            }
            if (text[position] !== 32) {
                throw new Malformed();
            }
            position += 1;
        }
        if (text[position] !== 46 || text[position + 1] !== 10) {
            throw new Malformed();
        }
        emit(text.subarray(from, position + 2));
        return position + 2;
    }
    function* expand(graph: ReadonlyArray<Component>, letter: string): Generator<Uint8Array> {
        for (const [index, component] of graph.entries()) {
            for (let instance = 0; instance < component.multiplicity; instance += 1) {
                const prefix = Buffer.from(`q${letter}${String(index)}_${String(instance)}_`);
                for (let position = 0; position < component.text.byteLength;) {
                    position = statement(component.text, position, prefix);
                    yield* ready.splice(0);
                }
            }
        }
        if (used > 0) {
            yield buffer.subarray(0, used);
            buffer = Buffer.allocUnsafe(chunkBytes);
            used = 0;
        }
    }
    const declaredGraph = oxigraph.namedNode(header.dataset.declared.graph);
    const inferredGraph = oxigraph.namedNode(header.dataset.inferred.graph);
    try {
        // The bulk loader pre-allocates beyond the WASM cap; the transactional loader stays within it.
        store.load(expand(declaredComponents, 'd'), { format: 'application/n-quads', to_graph_name: declaredGraph });
        store.load(expand(inferredComponents, 'i'), { format: 'application/n-quads', to_graph_name: inferredGraph });
    } catch (cause) {
        if (cause instanceof Malformed) {
            return exit(3);
        }
        if (cause instanceof WebAssembly.RuntimeError || cause instanceof RangeError) {
            respond({ schema: 'erden.release-query-worker-response/v1', outcome: 'resource-limit' });
            return;
        }
        return exit(3);
    }
    let answer: unknown;
    try {
        answer = store.query(header.query, {
            results_format: 'application/sparql-results+json',
            default_graph: declaredGraph,
            named_graphs: [declaredGraph, inferredGraph],
        });
    } catch (cause) {
        respond({
            schema: 'erden.release-query-worker-response/v1',
            outcome:
                cause instanceof WebAssembly.RuntimeError || cause instanceof RangeError
                    ? 'resource-limit'
                    : 'query-rejected',
        });
        return;
    }
    if (typeof answer !== 'string') {
        return exit(3);
    }
    const answerBytes = Buffer.from(answer, 'utf8');
    if (answerBytes.byteLength > header.limits.resultBytes) {
        respond({ schema: 'erden.release-query-worker-response/v1', outcome: 'result-byte-limit' });
        return;
    }
    const parsed = JSON.parse(answer) as { results?: { bindings?: ReadonlyArray<Readonly<Record<string, Term>>> } };
    const rows = parsed.results?.bindings ?? [];
    if (header.form === 'select' && rows.length > header.limits.resultRows) {
        respond({ schema: 'erden.release-query-worker-response/v1', outcome: 'row-limit' });
        return;
    }
    for (const row of rows) {
        for (const term of Object.values(row)) {
            if (Buffer.byteLength(term.value) > header.limits.termBytes) {
                respond({ schema: 'erden.release-query-worker-response/v1', outcome: 'result-byte-limit' });
                return;
            }
        }
    }
    respond({ schema: 'erden.release-query-worker-response/v1', outcome: 'complete' }, answerBytes);
}
