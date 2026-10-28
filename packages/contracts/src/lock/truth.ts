import { satisfies } from 'semver';

import { compareCodePoints } from '../manifest/constants.js';
import { isScopedAlias } from '../manifest/schema.js';

import { LockfileError } from './errors.js';
import { manifestDependencyProjectionSha256 } from './projection.js';
import { LOCKFILE_LIMITS, type LockfileV1 } from './schema.js';

function assertStrictOrder<A>(values: ReadonlyArray<A>, key: (value: A) => string, label: string): void {
    let previous: string | undefined;
    for (const value of values) {
        const current = key(value);
        if (previous !== undefined && compareCodePoints(previous, current) >= 0) {
            throw new LockfileError('lockfile-truth', `${label} must be strictly UTF-16 ordered and unique`);
        }
        previous = current;
    }
}

function deepFreeze<A>(value: A): A {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function assertAcyclic(packages: ReadonlyMap<string, LockfileV1['packages'][number]>): void {
    const complete = new Set<string>();
    for (const root of packages.keys()) {
        if (complete.has(root)) {
            continue;
        }
        const active = new Set<string>();
        const stack: Array<{
            canonicalIri: string;
            nextEdge: number;
        }> = [{ canonicalIri: root, nextEdge: 0 }];
        active.add(root);
        while (stack.length > 0) {
            if (stack.length > LOCKFILE_LIMITS.maxGraphDepth) {
                throw new LockfileError(
                    'lockfile-truth',
                    'The locked package graph exceeds the maximum dependency depth',
                );
            }
            const frame = stack.at(-1);
            if (frame === undefined) {
                break;
            }
            const edges = packages.get(frame.canonicalIri)?.dependencies ?? [];
            const edge = edges[frame.nextEdge];
            if (edge === undefined) {
                stack.pop();
                active.delete(frame.canonicalIri);
                complete.add(frame.canonicalIri);
                continue;
            }
            frame.nextEdge += 1;
            if (active.has(edge.canonicalIri)) {
                throw new LockfileError(
                    'lockfile-truth',
                    `The locked package graph contains a dependency cycle at ${edge.canonicalIri}`,
                );
            }
            if (!complete.has(edge.canonicalIri)) {
                active.add(edge.canonicalIri);
                stack.push({ canonicalIri: edge.canonicalIri, nextEdge: 0 });
            }
        }
    }
}

export function assertLockfileTruth(lock: LockfileV1): LockfileV1 {
    if (
        lock.directDependencies.length > LOCKFILE_LIMITS.maxDirectDependencies ||
        lock.aliasMappings.length > LOCKFILE_LIMITS.maxAliasMappings ||
        lock.packages.length > LOCKFILE_LIMITS.maxPackages
    ) {
        throw new LockfileError('lockfile-truth', 'The lockfile exceeds a closed v1 collection bound');
    }
    let edgeCount = 0;
    for (const node of lock.packages) {
        edgeCount += node.dependencies.length;
        if (edgeCount > LOCKFILE_LIMITS.maxEdges) {
            throw new LockfileError('lockfile-truth', 'The lockfile exceeds the closed v1 dependency-edge bound');
        }
    }
    assertStrictOrder(lock.directDependencies, (value) => value.identifier, 'Direct dependencies');
    assertStrictOrder(lock.aliasMappings, (value) => value.alias, 'Alias mappings');
    assertStrictOrder(lock.packages, (value) => value.canonicalIri, 'Locked packages');
    for (const node of lock.packages) {
        assertStrictOrder(node.dependencies, (value) => value.canonicalIri, `Dependencies of ${node.canonicalIri}`);
    }
    if (
        lock.counts.directDependencies !== lock.directDependencies.length ||
        lock.counts.aliasMappings !== lock.aliasMappings.length ||
        lock.counts.packages !== lock.packages.length ||
        lock.counts.edges !== edgeCount
    ) {
        throw new LockfileError('lockfile-truth', 'Lockfile counts do not match their canonical collections');
    }
    const dependencies = Object.fromEntries(
        lock.directDependencies.map(({ identifier, requested }) => [identifier, requested]),
    );
    const projectionDigest = manifestDependencyProjectionSha256({
        canonicalIri: lock.root.canonicalIri,
        alias: lock.root.alias,
        registryOrigin: lock.registryOrigin,
        dependencies,
    });
    if (lock.manifestDependencySha256 !== projectionDigest) {
        throw new LockfileError(
            'lockfile-truth',
            'The manifest dependency projection digest does not match the lockfile root and direct dependencies',
        );
    }
    const hasDirectDependencies = lock.directDependencies.length > 0;
    if (
        hasDirectDependencies
            ? lock.registryOrigin === null || lock.packages.length === 0
            : lock.registryOrigin !== null || lock.aliasMappings.length !== 0 || lock.packages.length !== 0
    ) {
        throw new LockfileError(
            'lockfile-truth',
            'Registry and graph presence must exactly match the nonempty direct dependency closure',
        );
    }
    const expectedAliases = lock.directDependencies
        .filter(({ identifier }) => isScopedAlias(identifier))
        .map(({ identifier, canonicalIri }) => ({ alias: identifier, canonicalIri }));
    if (
        expectedAliases.length !== lock.aliasMappings.length ||
        expectedAliases.some((expected, index) => {
            const actual = lock.aliasMappings[index];
            return (
                actual === undefined || actual.alias !== expected.alias || actual.canonicalIri !== expected.canonicalIri
            );
        })
    ) {
        throw new LockfileError('lockfile-truth', 'Alias mappings must exactly match all authored alias dependencies');
    }
    const packages = new Map(lock.packages.map((node) => [node.canonicalIri, node]));
    if (packages.has(lock.root.canonicalIri)) {
        throw new LockfileError('lockfile-truth', 'The root project cannot appear in its own locked package graph');
    }
    for (const direct of lock.directDependencies) {
        if (!isScopedAlias(direct.identifier) && direct.identifier !== direct.canonicalIri) {
            throw new LockfileError(
                'lockfile-truth',
                'A canonical direct dependency identifier cannot retarget to another ontology IRI',
            );
        }
        const node = packages.get(direct.canonicalIri);
        if (
            node === undefined ||
            node.version !== direct.version ||
            node.archiveSha256 !== direct.archiveSha256 ||
            !satisfies(node.version, direct.requested, { loose: false })
        ) {
            throw new LockfileError(
                'lockfile-truth',
                `Direct dependency ${direct.identifier} does not match its canonical locked package`,
            );
        }
    }
    for (const node of lock.packages) {
        for (const edge of node.dependencies) {
            const target = packages.get(edge.canonicalIri);
            if (
                edge.canonicalIri === node.canonicalIri ||
                target === undefined ||
                target.version !== edge.version ||
                target.archiveSha256 !== edge.archiveSha256 ||
                !satisfies(target.version, edge.requested, { loose: false })
            ) {
                throw new LockfileError(
                    'lockfile-truth',
                    `Locked edge from ${node.canonicalIri} does not match its canonical target`,
                );
            }
        }
    }
    assertAcyclic(packages);
    const reachable = new Set<string>();
    const pending = lock.directDependencies.map(({ canonicalIri }) => canonicalIri);
    while (pending.length > 0) {
        const canonicalIri = pending.pop();
        if (canonicalIri === undefined || reachable.has(canonicalIri)) {
            continue;
        }
        reachable.add(canonicalIri);
        for (const edge of packages.get(canonicalIri)?.dependencies ?? []) {
            pending.push(edge.canonicalIri);
        }
    }
    if (reachable.size !== packages.size || [...packages.keys()].some((canonicalIri) => !reachable.has(canonicalIri))) {
        throw new LockfileError(
            'lockfile-truth',
            'The lockfile contains a package that is unreachable from the direct dependency set',
        );
    }
    return deepFreeze(lock);
}
