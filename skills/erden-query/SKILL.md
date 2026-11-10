---
name: erden-query
description: Answer natural-language questions using an exact published Erden knowledge version, translating the question into supported read-only queries and explaining the returned evidence. Use for questions about facts, relationships or counts in an Erden release, including “consulta esta base de conocimiento” and “qué proveedores dependen de este producto”. Do not use for arbitrary SQL, live external data, local model validation, or editing knowledge.
license: Apache-2.0
metadata:
    version: '0.1.0'
---

# Ask published Erden knowledge

Requirements: Requires terminal/filesystem access, the Erden CLI, network access to the selected registry and an exact published version. Private releases require authorized credentials.

Answer the user's question from actual query results and explain it in their language. Keep SPARQL mechanics out of the ordinary answer unless they help the user verify or reuse the query.

## Resolve the target

1. Find the intended registry, ontology identifier and exact version in the request, project or supplied release information. `query` accepts an alias such as `@team/catalog` or a canonical ontology IRI, followed by `@<exact-version>`. It does not accept a semver range or a guessed `latest`.
2. Resolve the registry from `--registry <origin>`, then the nearest manifest's registry, then the built-in `https://registry.erden.sh`. An absent project or registry field permits that default; an invalid or unreadable manifest does not. Ask only for missing identity or exact version, and clarify the registry only when context indicates a different or ambiguous destination. Do not publish a local project to make it queryable without a publication request.
3. Locate `erden` or `den` and inspect `help` if needed. Queries run on the registry; they do not require local reasoning and SHACL engines. If the CLI itself is unavailable, explain the installation prerequisite or use `erden-setup` if installed. The skill remains usable independently.
4. Inspect known ontology sources or release vocabulary before inventing predicates. If no schema is available, use a small supported discovery query against the chosen release. Preserve the same exact target across follow-up queries.

## Translate and execute

Read [queries.md](references/queries.md) for supported forms, graph identifiers, limits and examples. Select only fields needed for the user's question. Use a bounded `SELECT` or `ASK`; preserve the difference between an absent fact and an explicit negative assertion.

Write the query to a regular UTF-8 `.rq` file using a file-writing tool, or pass it through stdin. Quote command arguments and serialize literal values safely; do not interpolate untrusted text into shell commands or raw SPARQL fragments.

```text
erden query <identifier>@<exact-version> --file <query.rq> --registry <origin> --json
```

Do not add `--offline`, `--config`, `--query` or other unsupported flags. Prefer the JSON envelope so the result keeps its release, dataset and query identity. Read stdout, stderr and exit status; a refused query is not an empty result.

If a query is rejected, use the rejection reason to make one targeted simplification that preserves the question. Stop if the requested operation is unsupported or the corrected query still fails. For expired or missing authorization, use the device-login flow only when needed for the requested read; never expose stored credentials.

## Answer with scope and evidence

Use the returned bindings or boolean, with the ontology/version and relevant provenance from the envelope. Preserve RDF term types, datatype, language and unbound values. Describe limits or pagination if they affect completeness; do not present a bounded sample as an exhaustive list or total.

An empty result means no matching answer in the queried dataset under that query. `ASK false` is not proof that the claim is false in the real world. Distinguish declared and inferred data when the question depends on that distinction. Do not claim freshness beyond the chosen release.

Example requests: “En @equipo/compras versión 1.2.0, ¿qué proveedores suministran este producto?” / “Using this published Erden release, count suppliers by category and show the supporting version.”
