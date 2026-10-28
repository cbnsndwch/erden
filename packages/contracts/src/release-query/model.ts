import { RELEASE_QUERY_ENGINE_LIMITS } from '@erden/ontology';

export const RELEASE_QUERY_LANGUAGE = 'erden.release-query-language/v1' as const;

export const RELEASE_QUERY_GRAPHS = Object.freeze({
    declared: 'urn:erden:release-query:v1:graph:declared',
    inferred: 'urn:erden:release-query:v1:graph:inferred',
});

/** Policy constants. Covered by the policy digest; never configurable by callers or operators. */
export const RELEASE_QUERY_LIMITS = Object.freeze({
    ...RELEASE_QUERY_ENGINE_LIMITS,
    maxQueryBytes: 8_192,
    maxFormBytes: 32_768,
    maxTokens: 2_048,
    maxAstNodes: 1_024,
    maxGroupDepth: 8,
    maxExpressionDepth: 16,
    maxTriplePatterns: 64,
    maxOptional: 16,
    maxUnionBranches: 16,
    maxMinus: 16,
    maxFilterBind: 32,
    maxValuesVariables: 8,
    maxValuesRows: 128,
    maxVariables: 64,
    maxProjection: 32,
    maxPrefixes: 32,
    maxGroupKeys: 8,
    maxOrderKeys: 8,
    maxFunctionArguments: 8,
    maxPathIris: 8,
    maxPathDepth: 4,
    maxIriBytes: 4_096,
    maxLiteralBytes: 1_024,
    maxLanguageBytes: 35,
    maxRegexBytes: 256,
    maxSeparatorBytes: 16,
    maxVariableLength: 64,
    maxLimit: 1_000,
    maxOffset: 10_000,
    maxDatasetQuads: 200_000,
    maxDatasetBytes: 16 * 1_048_576,
    maxAdmittedRequests: 4,
    /** Engine runs one reader may hold at once; every anonymous caller together is one reader. */
    maxEngineRunsPerReader: 1,
    requestMilliseconds: 60_000,
    datasetCacheBytes: 32 * 1_048_576,
    resultCacheEntries: 256,
    resultCacheBytes: 16 * 1_048_576,
    maxAuthorityMembers: 257,
});

export const RELEASE_QUERY_REJECTION_REASONS = Object.freeze([
    'syntax',
    'query-too-large',
    'encoding-invalid',
    'escape-forbidden',
    'form-forbidden',
    'base-forbidden',
    'relative-iri-forbidden',
    'unknown-prefix',
    'prefix-redeclared',
    'dataset-clause-forbidden',
    'unknown-graph',
    'blank-node-forbidden',
    'triple-term-forbidden',
    'subquery-forbidden',
    'unbounded-path-forbidden',
    'negated-path-forbidden',
    'path-limit',
    'regex-forbidden',
    'nondeterministic-function-forbidden',
    'extension-function-forbidden',
    'function-forbidden',
    'update-forbidden',
    'service-forbidden',
    'query-invalid',
    'token-limit',
    'complexity-limit',
    'depth-limit',
    'pattern-limit',
    'values-limit',
    'term-limit',
    'limit-exceeded',
    'offset-exceeded',
] as const);
export type ReleaseQueryRejectionReason = (typeof RELEASE_QUERY_REJECTION_REASONS)[number];

/** Rejections reported as `RELEASE_QUERY_LIMIT_EXCEEDED` rather than `RELEASE_QUERY_REJECTED` by transports. */
export const RELEASE_QUERY_LIMIT_REASONS: ReadonlySet<ReleaseQueryRejectionReason> = new Set([
    'token-limit',
    'complexity-limit',
    'depth-limit',
    'pattern-limit',
    'values-limit',
    'term-limit',
    'path-limit',
    'limit-exceeded',
    'offset-exceeded',
]);

export type ReleaseQueryForm = 'select' | 'ask';

export type ReleaseQueryTerm =
    | Readonly<{ kind: 'variable'; name: string }>
    | Readonly<{ kind: 'iri'; value: string }>
    | Readonly<{ kind: 'literal'; value: string; language: string | null; datatype: string | null }>;

export type ReleaseQueryPath =
    | Readonly<{ kind: 'link'; iri: string }>
    | Readonly<{ kind: 'inverse'; path: ReleaseQueryPath }>
    | Readonly<{ kind: 'sequence'; items: ReadonlyArray<ReleaseQueryPath> }>
    | Readonly<{ kind: 'alternative'; items: ReadonlyArray<ReleaseQueryPath> }>
    | Readonly<{ kind: 'zero-or-one'; path: ReleaseQueryPath }>;

export interface ReleaseQueryTriplePattern {
    readonly subject: ReleaseQueryTerm;
    readonly predicate: Readonly<{ kind: 'variable'; name: string }> | ReleaseQueryPath;
    readonly object: ReleaseQueryTerm;
}

export type ReleaseQueryBinaryOperator = '||' | '&&' | '=' | '!=' | '<' | '>' | '<=' | '>=' | '+' | '-' | '*' | '/';

export const RELEASE_QUERY_CALLS = Object.freeze([
    'STR',
    'LANG',
    'LANGMATCHES',
    'DATATYPE',
    'BOUND',
    'SAMETERM',
    'ISIRI',
    'ISURI',
    'ISBLANK',
    'ISLITERAL',
    'ISNUMERIC',
    'STRLEN',
    'SUBSTR',
    'UCASE',
    'LCASE',
    'STRSTARTS',
    'STRENDS',
    'CONTAINS',
    'STRBEFORE',
    'STRAFTER',
    'CONCAT',
    'COALESCE',
    'IF',
    'ABS',
    'ROUND',
    'CEIL',
    'FLOOR',
    'REGEX',
] as const);
export type ReleaseQueryCall = (typeof RELEASE_QUERY_CALLS)[number];

export const RELEASE_QUERY_AGGREGATES = Object.freeze([
    'COUNT',
    'SUM',
    'MIN',
    'MAX',
    'AVG',
    'SAMPLE',
    'GROUP_CONCAT',
] as const);
export type ReleaseQueryAggregate = (typeof RELEASE_QUERY_AGGREGATES)[number];

const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const RELEASE_QUERY_CASTS: ReadonlySet<string> = new Set(
    ['string', 'boolean', 'integer', 'decimal', 'double'].map((name) => `${XSD}${name}`),
);

export type ReleaseQueryExpression =
    | ReleaseQueryTerm
    | Readonly<{ kind: 'call'; name: ReleaseQueryCall; args: ReadonlyArray<ReleaseQueryExpression> }>
    | Readonly<{ kind: 'cast'; datatype: string; arg: ReleaseQueryExpression }>
    | Readonly<{ kind: 'unary'; operator: '!' | '+' | '-'; arg: ReleaseQueryExpression }>
    | Readonly<{
          kind: 'chain';
          first: ReleaseQueryExpression;
          rest: ReadonlyArray<Readonly<{ operator: ReleaseQueryBinaryOperator; arg: ReleaseQueryExpression }>>;
      }>
    | Readonly<{
          kind: 'in';
          negated: boolean;
          arg: ReleaseQueryExpression;
          list: ReadonlyArray<ReleaseQueryExpression>;
      }>
    | Readonly<{ kind: 'exists'; negated: boolean; group: ReleaseQueryGroup }>
    | Readonly<{
          kind: 'aggregate';
          name: ReleaseQueryAggregate;
          distinct: boolean;
          arg: ReleaseQueryExpression | null;
          separator: string | null;
      }>;

export type ReleaseQueryElement =
    | Readonly<{ kind: 'triples'; patterns: ReadonlyArray<ReleaseQueryTriplePattern> }>
    | Readonly<{ kind: 'group'; group: ReleaseQueryGroup }>
    | Readonly<{ kind: 'optional'; group: ReleaseQueryGroup }>
    | Readonly<{ kind: 'union'; groups: ReadonlyArray<ReleaseQueryGroup> }>
    | Readonly<{ kind: 'minus'; group: ReleaseQueryGroup }>
    | Readonly<{ kind: 'graph'; name: ReleaseQueryTerm; group: ReleaseQueryGroup }>
    | Readonly<{ kind: 'filter'; expression: ReleaseQueryExpression }>
    | Readonly<{ kind: 'bind'; expression: ReleaseQueryExpression; variable: string }>
    | Readonly<{
          kind: 'values';
          variables: ReadonlyArray<string>;
          rows: ReadonlyArray<ReadonlyArray<ReleaseQueryTerm | null>>;
      }>;

export interface ReleaseQueryGroup {
    readonly elements: ReadonlyArray<ReleaseQueryElement>;
}

export type ReleaseQueryProjection =
    | Readonly<{ kind: 'variable'; name: string }>
    | Readonly<{ kind: 'expression'; expression: ReleaseQueryExpression; name: string }>;

export type ReleaseQueryGroupKey =
    | Readonly<{ kind: 'expression'; expression: ReleaseQueryExpression }>
    | Readonly<{ kind: 'alias'; expression: ReleaseQueryExpression; name: string }>;

export interface ReleaseQueryOrderKey {
    readonly descending: boolean;
    readonly expression: ReleaseQueryExpression;
}

/** Internal closed AST (`erden.release-query-ast/v1`); never crosses a transport. */
export type ReleaseQueryAst =
    | Readonly<{
          schema: 'erden.release-query-ast/v1';
          form: 'select';
          distinct: boolean;
          projection: ReadonlyArray<ReleaseQueryProjection> | null;
          where: ReleaseQueryGroup;
          groupBy: ReadonlyArray<ReleaseQueryGroupKey>;
          having: ReadonlyArray<ReleaseQueryExpression>;
          orderBy: ReadonlyArray<ReleaseQueryOrderKey>;
          limit: number | null;
          offset: number | null;
      }>
    | Readonly<{ schema: 'erden.release-query-ast/v1'; form: 'ask'; where: ReleaseQueryGroup }>;

export interface ParsedReleaseQuery {
    readonly form: ReleaseQueryForm;
    readonly ast: ReleaseQueryAst;
    /** Canonical SPARQL without a final LF. */
    readonly canonical: string;
    /** SHA-256 over the canonical text plus one LF. */
    readonly querySha256: string;
    /** Canonical text with the row sentinel limit applied; the only text an engine receives. */
    readonly engineQuery: string;
    /** Ordered projected names, or null for `SELECT *`. Empty for ASK. */
    readonly projection: ReadonlyArray<string> | null;
    /** Every variable name in the query, sorted. */
    readonly variables: ReadonlyArray<string>;
}
