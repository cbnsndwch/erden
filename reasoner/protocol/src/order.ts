// The orders canonical JSON puts keys and normalized arrays in, shared by the writer that sorts (`canonical.ts`) and
// the reader that checks an answer is already sorted (`wire.ts`). Not exported from the package.
import type { AssertedStatement, Diagnostic, InferredStatement } from './schema.js';

/** Orders text by UTF-16 code units, as canonical JSON orders keys and normalized arrays. */
export function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/** The key a normalized answer's asserted and inferred statements are sorted by. */
export function statementSortKey(statement: AssertedStatement | InferredStatement): string {
    return [
        statement.subject,
        statement.predicate,
        typeof statement.object === 'string'
            ? `I:${statement.object}`
            : `L:${statement.object.lexicalForm}:${statement.object.datatype}:${statement.object.language ?? ''}`,
        statement.id,
    ].join('\u0000');
}

/** The key a normalized answer's diagnostics are sorted by, once each one's axiom IDs are sorted. */
export function diagnosticSortKey(diagnostic: Diagnostic): string {
    return [diagnostic.severity, diagnostic.code, diagnostic.message, ...diagnostic.axiomIds].join('\u0000');
}
