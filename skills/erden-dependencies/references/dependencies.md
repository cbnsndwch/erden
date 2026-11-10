# Dependency operations

An identifier is a scoped alias such as `@example/suppliers` or a canonical ontology IRI. A dependency specification appends `@` and a semver range. Quote the whole specification when invoking a shell.

```bash
erden add '@example/suppliers@^1.0.0' --json
erden update '@example/suppliers' --json
erden remove '@example/suppliers' --json
```

These are illustrative identities, not evidence that the packages exist. Resolve the actual identity from the user, manifest or a real registry result.

## Project selection

```text
erden add <identifier>@<range> [--config <file>] [--json]
erden remove <identifier> [--config <file>] [--json]
erden update [identifier] [--config <file>] [--json]
erden install [project-dir] [--config <file>] [--offline] [--frozen-lockfile] [--json]
```

Select one intended project, using its directory or an explicit configuration as supported. Preserve JSON/JSONC/YAML/TOML source format. A source CLI is invoked as `node <checkout>/apps/cli/dist/bin.js` after building the runtime; the process working directory still determines the project when no config is given.

## Resolution and reproducibility

Read `dependencies` from the manifest and inspect the existing lockfile before selecting an update. `update` resolves within declared constraints; it is not permission to widen a major-version boundary. The registry and aliases must be real; lockfile identity and hashes are not user-editable shortcuts.

`--frozen-lockfile` makes installation refuse incompatible or missing locked state rather than silently resolving a new dependency set. Offline mode does not fetch unavailable artifacts. Explain the actual CLI error if either precondition fails.

Do not add unsupported flags to `add`, `remove` or `update`; in particular their current help does not advertise `--offline` or `--dry-run`. To preview, explain the intended operation and inspect current state without executing a mutation. Do not call a mutation and label it a dry run.

## Registry access

Use the manifest registry. These commands do not expose a `--registry` override; do not silently rewrite the configured registry. Credentials are origin-scoped and managed by `erden login --registry <origin>`. Keep secrets out of reports.

## Local store

```text
erden store path --json
erden store status --json
erden store prune --dry-run --json
```

The first two are inspection. A prune preview is relevant only to requested cache cleanup. Removing a dependency from a project and removing shared cached artifacts are different actions; do not prune merely because `remove` succeeded.
