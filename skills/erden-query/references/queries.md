# Published release queries

## Invocation contract

```text
erden query <identifier>@<exact-version> (--file <path> | --stdin) [--registry <origin>] [--json | --sparql-json]
```

Exactly one input source is required. `--file` must refer to a regular file; the reader does not follow a final symlink. The CLI has no inline query-text argument. `--json` includes the Erden envelope; `--sparql-json` returns the SPARQL result representation and cannot be combined with `--json`.

The registry origin must be a canonical HTTP(S) origin with no API path. An explicit registry allows querying outside a local project. Without it, the CLI uses the nearest manifest registry or, when none is specified, `https://registry.erden.sh`. Invalid or unreadable manifests fail rather than silently changing the destination. The CLI uses an origin-scoped credential when present; do not assemble Authorization headers yourself.

## Supported language

This version supports a bounded SPARQL subset with `SELECT` and `ASK`, including supported filtering, grouping, aggregates, optional patterns and unions. It is not a general SPARQL endpoint. Query updates, `SERVICE`, `BASE`, dataset clauses, subqueries, arbitrary extension functions and unbounded property paths are rejected. Use absolute IRIs or declared prefixes.

Policy limits in the authored-against contract include query size 8,192 bytes, at most 64 triple patterns, `LIMIT` at most 1,000 and `OFFSET` at most 10,000. The installed/remote contract and returned diagnostics are authoritative if these change. Do not evade service limits by an unbounded sequence of requests.

When the distinction matters, the named graphs are:

- Declared: `urn:erden:release-query:v1:graph:declared`
- Inferred: `urn:erden:release-query:v1:graph:inferred`

Do not guess which graph contains a fact; use the named graph explicitly for questions about declaration or inference. Ordinary questions can use the release's default query dataset.

## Small vocabulary probe

If no vocabulary is available, a bounded type probe can help:

```sparql
SELECT DISTINCT ?type WHERE {
  ?item a ?type
}
ORDER BY ?type
LIMIT 50
```

This is a sample of types, not a claim to have enumerated a large schema. Inspect relevant predicates with similarly bounded queries after selecting the actual subject/type.

## Known-vocabulary examples

Only use these example IRIs when they match the dataset or after replacing them with verified vocabulary.

```sparql
PREFIX ex: <https://example.invalid/suppliers#>
SELECT ?supplier WHERE {
  ?supplier a ex:Supplier
}
ORDER BY ?supplier
LIMIT 100
```

```sparql
PREFIX ex: <https://example.invalid/suppliers#>
ASK {
  GRAPH <urn:erden:release-query:v1:graph:inferred> {
    ex:acme a ex:Supplier
  }
}
```

For a count, use an admitted aggregate such as `COUNT` rather than counting a truncated list. For a complete multi-page listing, use stable ordering and the same release, and disclose when policy limits prevent completing it.

## Results and errors

The JSON envelope includes a `binding` with release identity and dataset identity, the query hash, the result and its hash. Keep the exact release version and relevant hashes available for verification; do not replace them with a generic registry homepage citation.

Results are SPARQL JSON bindings or a boolean. An unbound variable is absent from its row; it is not an empty string or a false value. Preserve URI, blank-node and literal distinctions internally even when presenting friendly labels.

Semantic refusals use exit 1, usage errors use 2 and operational failures use 3. Errors such as query rejection, resource limits, not-found and unauthorized need their own explanation; never synthesize successful empty results from them. A concealed not-found response does not prove that an inaccessible private release does not exist.
