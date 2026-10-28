import type { AssembledOntology } from '../model.js';
import { compareCodePoints } from '../order.js';
import { locateSourceStatements, type SourcePosition } from '../source-formats/positions.js';

import type { ProfilePartitionFinding } from './partition.js';

/** Where one statement is written: the source's locator, and the 1-based line and column in it. */
export interface StatementLocation {
    readonly locator: string;
    readonly line: number;
    readonly column: number;
}

export interface StatementLocationRequest {
    /** The statement's quad key. */
    readonly key: string;
    /** The source to look in first, when it asserts the statement (a finding's first file). */
    readonly preferredLocator?: string;
}

/**
 * Locates statements in the sources that assert them, reading each needed source once. A statement asserted by
 * several sources is located in the preferred one, else in the one whose locator sorts first. Null when the
 * statement is not asserted, or its source's positions cannot be established.
 */
export function locateStatements(
    graph: AssembledOntology,
    requests: ReadonlyArray<StatementLocationRequest>,
): ReadonlyArray<StatementLocation | null> {
    if (requests.length === 0) {
        return [];
    }
    const wanted = new Set(requests.map((request) => request.key));
    const contributors = new Map<string, ReadonlyArray<{ readonly sourceId: string; readonly locator: string }>>();
    for (const entry of graph.provenance) {
        if (wanted.has(entry.key)) {
            contributors.set(
                entry.key,
                [...entry.asserted].sort((left, right) => compareCodePoints(left.locator, right.locator)),
            );
        }
    }
    const chosen = requests.map((request) => {
        const candidates = contributors.get(request.key) ?? [];
        return candidates.find((item) => item.locator === request.preferredLocator) ?? candidates[0];
    });
    const needed = new Set(chosen.flatMap((item) => (item === undefined ? [] : [item.sourceId])));
    const keysBySource = new Map([...needed].map((id) => [id, new Set<string>()]));
    for (const entry of graph.provenance) {
        for (const contributor of entry.asserted) {
            keysBySource.get(contributor.sourceId)?.add(entry.key);
        }
    }
    const positions = new Map<string, ReadonlyMap<string, SourcePosition>>();
    for (const source of graph.sources) {
        const keys = keysBySource.get(source.descriptor.id);
        if (keys !== undefined) {
            positions.set(source.descriptor.id, locateSourceStatements(source, keys));
        }
    }
    return requests.map((request, index) => {
        const contributor = chosen[index];
        const position = contributor === undefined ? undefined : positions.get(contributor.sourceId)?.get(request.key);
        return contributor === undefined || position === undefined
            ? null
            : Object.freeze({ locator: contributor.locator, line: position.line, column: position.column });
    });
}

/** The location of each finding's root statement, in the finding's first file when that file asserts it. */
export function locateProfileFindings(
    graph: AssembledOntology,
    findings: ReadonlyArray<Pick<ProfilePartitionFinding, 'rootKey' | 'locators'>>,
): ReadonlyArray<StatementLocation | null> {
    return locateStatements(
        graph,
        findings.map((finding) => ({
            key: finding.rootKey,
            ...(finding.locators[0] === undefined ? {} : { preferredLocator: finding.locators[0] }),
        })),
    );
}
