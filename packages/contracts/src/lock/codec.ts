import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from 'yaml';

import { LockfileError } from './errors.js';
import { decodeLockfileStructure, LOCKFILE_LIMITS, LOCKFILE_VERSION, type LockfileV1 } from './schema.js';
import { assertLockfileTruth } from './truth.js';

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UNSAFE_MAPPING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
// These intrinsic accessors are intentionally detached and invoked with `.call` to brand-check inputs.
// oxlint-disable-next-line typescript/unbound-method
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get as
    | ((this: Uint8Array) => ArrayBufferLike)
    | undefined;
// oxlint-disable-next-line typescript/unbound-method
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get as
    | ((this: Uint8Array) => number)
    | undefined;
// oxlint-disable-next-line typescript/unbound-method
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get as
    | ((this: Uint8Array) => number)
    | undefined;

function boundedUtf8ByteLength(value: string, maximum: number): number {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit <= 0x7f) {
            bytes += 1;
        } else if (unit <= 0x7ff) {
            bytes += 2;
        } else if (unit >= 0xd800 && unit <= 0xdbff) {
            const low = value.charCodeAt(index + 1);
            if (low < 0xdc00 || low > 0xdfff) {
                return -1;
            }
            bytes += 4;
            index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return -1;
        } else {
            bytes += 3;
        }
        if (bytes > maximum) {
            return maximum + 1;
        }
    }
    return bytes;
}

function yamlString(value: string): string {
    return JSON.stringify(value);
}

function snapshotBinaryInput(input: Uint8Array): Uint8Array {
    if (typedArrayBuffer === undefined || typedArrayByteOffset === undefined || typedArrayByteLength === undefined) {
        throw new TypeError('Typed-array intrinsics are unavailable');
    }
    const buffer = typedArrayBuffer.call(input);
    const byteOffset = typedArrayByteOffset.call(input);
    const byteLength = typedArrayByteLength.call(input);
    if (!Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new TypeError('Invalid typed-array bounds');
    }
    if (byteLength > LOCKFILE_LIMITS.maxBytes) {
        throw new LockfileError('lockfile-syntax', 'erden.lock exceeds the maximum byte size');
    }
    const snapshot = Uint8Array.from(new Uint8Array(buffer, byteOffset, byteLength));
    if (snapshot.byteLength !== byteLength || snapshot.byteLength > LOCKFILE_LIMITS.maxBytes) {
        throw new LockfileError('lockfile-syntax', 'erden.lock binary input changed or exceeds the maximum byte size');
    }
    return snapshot;
}

function inspectYamlNode(root: YamlNode | null | undefined): void {
    const pending: Array<{
        readonly node: YamlNode;
        readonly depth: number;
    }> = root === null || root === undefined ? [] : [{ node: root, depth: 1 }];
    let visited = 0;
    while (pending.length > 0) {
        visited += 1;
        if (visited > LOCKFILE_LIMITS.maxYamlNodes) {
            throw new LockfileError('lockfile-syntax', 'erden.lock exceeds the YAML node bound');
        }
        const item = pending.pop();
        if (item === undefined) {
            continue;
        }
        if (item.depth > LOCKFILE_LIMITS.maxGraphDepth) {
            throw new LockfileError('lockfile-syntax', 'erden.lock exceeds the YAML depth bound');
        }
        const { node } = item;
        const decorated = node;
        if (
            isAlias(node) ||
            decorated.anchor !== undefined ||
            decorated.tag !== undefined ||
            decorated.comment !== undefined ||
            decorated.commentBefore !== undefined
        ) {
            throw new LockfileError(
                'lockfile-syntax',
                'erden.lock does not allow YAML aliases, anchors, explicit tags, or comments',
            );
        }
        if (
            isScalar(node) &&
            typeof node.value === 'string' &&
            new TextEncoder().encode(node.value).byteLength > LOCKFILE_LIMITS.maxScalarBytes
        ) {
            throw new LockfileError('lockfile-syntax', 'erden.lock exceeds the YAML scalar byte bound');
        }
        if (isMap(node)) {
            for (const pair of node.items) {
                const decoratedPair = pair as unknown as {
                    readonly comment?: unknown;
                    readonly commentBefore?: unknown;
                };
                if (decoratedPair.comment !== undefined || decoratedPair.commentBefore !== undefined) {
                    throw new LockfileError('lockfile-syntax', 'erden.lock does not allow YAML comments');
                }
                if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
                    throw new LockfileError('lockfile-syntax', 'erden.lock mapping keys must be strings');
                }
                const key = pair.key as YamlNode & {
                    readonly anchor?: unknown;
                    readonly tag?: unknown;
                };
                if (key.anchor !== undefined || key.tag !== undefined) {
                    throw new LockfileError(
                        'lockfile-syntax',
                        'erden.lock does not allow tagged or anchored mapping keys',
                    );
                }
                if (pair.key.value === '<<' || UNSAFE_MAPPING_KEYS.has(pair.key.value)) {
                    throw new LockfileError('lockfile-syntax', 'erden.lock contains an unsafe or merge mapping key');
                }
                pending.push({ node: pair.key, depth: item.depth + 1 });
                if (pair.value !== null) {
                    pending.push({ node: pair.value as YamlNode, depth: item.depth + 1 });
                }
            }
        } else if (isSeq(node)) {
            for (const child of node.items) {
                if (child !== null) {
                    pending.push({ node: child as YamlNode, depth: item.depth + 1 });
                }
            }
        }
    }
}

function renderDirectDependencies(lock: LockfileV1, lines: string[]): void {
    if (lock.directDependencies.length === 0) {
        lines.push('directDependencies: []');
        return;
    }
    lines.push('directDependencies:');
    for (const direct of lock.directDependencies) {
        lines.push(`  - identifier: ${yamlString(direct.identifier)}`);
        lines.push(`    requested: ${yamlString(direct.requested)}`);
        lines.push(`    canonicalIri: ${yamlString(direct.canonicalIri)}`);
        lines.push(`    version: ${yamlString(direct.version)}`);
        lines.push(`    archiveSha256: ${yamlString(direct.archiveSha256)}`);
    }
}

function renderAliasMappings(lock: LockfileV1, lines: string[]): void {
    if (lock.aliasMappings.length === 0) {
        lines.push('aliasMappings: []');
        return;
    }
    lines.push('aliasMappings:');
    for (const mapping of lock.aliasMappings) {
        lines.push(`  - alias: ${yamlString(mapping.alias)}`);
        lines.push(`    canonicalIri: ${yamlString(mapping.canonicalIri)}`);
    }
}

function renderPackages(lock: LockfileV1, lines: string[]): void {
    if (lock.packages.length === 0) {
        lines.push('packages: []');
        return;
    }
    lines.push('packages:');
    for (const node of lock.packages) {
        lines.push(`  - canonicalIri: ${yamlString(node.canonicalIri)}`);
        lines.push(`    version: ${yamlString(node.version)}`);
        lines.push(`    archiveSha256: ${yamlString(node.archiveSha256)}`);
        if (node.dependencies.length === 0) {
            lines.push('    dependencies: []');
        } else {
            lines.push('    dependencies:');
            for (const edge of node.dependencies) {
                lines.push(`      - requested: ${yamlString(edge.requested)}`);
                lines.push(`        canonicalIri: ${yamlString(edge.canonicalIri)}`);
                lines.push(`        version: ${yamlString(edge.version)}`);
                lines.push(`        archiveSha256: ${yamlString(edge.archiveSha256)}`);
            }
        }
    }
}

function renderLockfile(lock: LockfileV1): string {
    const lines = [
        `lockfileVersion: ${String(LOCKFILE_VERSION)}`,
        `registryOrigin: ${lock.registryOrigin === null ? 'null' : yamlString(lock.registryOrigin)}`,
        `manifestDependencySha256: ${yamlString(lock.manifestDependencySha256)}`,
        'root:',
        `  canonicalIri: ${yamlString(lock.root.canonicalIri)}`,
        `  alias: ${yamlString(lock.root.alias)}`,
    ];
    renderDirectDependencies(lock, lines);
    renderAliasMappings(lock, lines);
    renderPackages(lock, lines);
    lines.push('toolchain:');
    lines.push('  validator:');
    lines.push(`    version: ${yamlString(lock.toolchain.validator.version)}`);
    lines.push(`    sha256: ${yamlString(lock.toolchain.validator.sha256)}`);
    lines.push('  reasoner:');
    lines.push(`    version: ${yamlString(lock.toolchain.reasoner.version)}`);
    lines.push(`    sha256: ${yamlString(lock.toolchain.reasoner.sha256)}`);
    lines.push('counts:');
    lines.push(`  directDependencies: ${String(lock.counts.directDependencies)}`);
    lines.push(`  aliasMappings: ${String(lock.counts.aliasMappings)}`);
    lines.push(`  packages: ${String(lock.counts.packages)}`);
    lines.push(`  edges: ${String(lock.counts.edges)}`);
    return `${lines.join('\n')}\n`;
}

export function decodeLockfileValue(input: unknown): LockfileV1 {
    return assertLockfileTruth(decodeLockfileStructure(input));
}

export function serializeLockfile(input: LockfileV1): string {
    const rendered = renderLockfile(decodeLockfileValue(input));
    if (boundedUtf8ByteLength(rendered, LOCKFILE_LIMITS.maxBytes) > LOCKFILE_LIMITS.maxBytes) {
        throw new LockfileError('lockfile-truth', 'The canonical erden.lock output exceeds the v1 byte bound');
    }
    parseLockfile(rendered);
    return rendered;
}

export function serializeLockfileBytes(input: LockfileV1): Uint8Array {
    return new TextEncoder().encode(serializeLockfile(input));
}

function parseLockfileInternal(input: string | Uint8Array): LockfileV1 {
    const bytes = typeof input === 'string' ? undefined : snapshotBinaryInput(input);
    const stringByteLength =
        typeof input === 'string' ? boundedUtf8ByteLength(input, LOCKFILE_LIMITS.maxBytes) : undefined;
    if (
        (stringByteLength !== undefined && stringByteLength > LOCKFILE_LIMITS.maxBytes) ||
        (bytes !== undefined && bytes.byteLength > LOCKFILE_LIMITS.maxBytes)
    ) {
        throw new LockfileError('lockfile-syntax', 'erden.lock exceeds the maximum byte size');
    }
    if (stringByteLength === -1) {
        throw new LockfileError(
            'lockfile-syntax',
            'erden.lock must be well-formed UTF-8 without lone UTF-16 surrogates',
        );
    }
    let text: string;
    try {
        text = typeof input === 'string' ? input : fatalUtf8Decoder.decode(bytes);
    } catch (error) {
        if (error instanceof LockfileError) {
            throw error;
        }
        throw new LockfileError('lockfile-syntax', 'erden.lock is not valid UTF-8', error);
    }
    if (!text.isWellFormed() || text.startsWith('\uFEFF') || text.includes('\r')) {
        throw new LockfileError(
            'lockfile-syntax',
            'erden.lock must be well-formed UTF-8 with LF line endings and no BOM',
        );
    }
    if (/^(?:%YAML|%TAG|---|\.\.\.)(?:[ \t]|$)/mu.test(text)) {
        throw new LockfileError(
            'lockfile-syntax',
            'erden.lock exceeds its byte bound or uses YAML document directives',
        );
    }
    let document: ReturnType<typeof parseDocument>;
    try {
        document = parseDocument(text, {
            prettyErrors: false,
            strict: true,
            uniqueKeys: true,
            version: '1.2',
        });
    } catch (error) {
        throw new LockfileError('lockfile-syntax', 'erden.lock is not one strict YAML 1.2 document', error);
    }
    if (document.errors.length > 0 || document.warnings.length > 0 || document.contents === null) {
        throw new LockfileError('lockfile-syntax', 'erden.lock is not one strict YAML 1.2 document');
    }
    inspectYamlNode(document.contents);
    let value: unknown;
    try {
        value = document.toJS({ maxAliasCount: 0 }) as unknown;
    } catch (error) {
        throw new LockfileError('lockfile-syntax', 'erden.lock YAML values could not be decoded safely', error);
    }
    if (
        value !== null &&
        typeof value === 'object' &&
        'lockfileVersion' in value &&
        (
            value as {
                readonly lockfileVersion?: unknown;
            }
        ).lockfileVersion !== LOCKFILE_VERSION
    ) {
        throw new LockfileError('lockfile-version', 'erden.lock uses an unsupported lockfile version');
    }
    const lock = decodeLockfileValue(value);
    if (renderLockfile(lock) !== text) {
        throw new LockfileError(
            'lockfile-noncanonical',
            'erden.lock bytes do not use the canonical v1 YAML representation',
        );
    }
    return lock;
}

export function parseLockfile(input: string | Uint8Array): LockfileV1 {
    try {
        return parseLockfileInternal(input);
    } catch (error) {
        if (error instanceof LockfileError) {
            throw error;
        }
        throw new LockfileError('lockfile-syntax', 'erden.lock input could not be inspected safely', error);
    }
}
