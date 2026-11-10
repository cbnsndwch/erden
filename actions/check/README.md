# Erden Check for GitHub Actions

Validate an Erden project in a pull request using the real CLI. The action verifies the selected CLI version, runs `doctor`, restores the locked dependencies, and runs `check`. GitHub receives a job summary and diagnostic annotations; JSON reports and phase logs remain available even when validation fails.

This action does not publish models or log in. It needs only `contents: read` for the checkout. A local JavaScript action runs with the runner's Node 24; Erden itself runs with the Node executable in its selected distribution.

## Availability

As of November 10, 2026, `cbnsndwch/erden` has no published release assets. The download mode requires an actual release containing the platform archive and `SHA256SUMS`; `0.1.0` below is an example, not a claim that it is downloadable. Until the first release, use a prepared distribution through `erden-root`. Source-building the qualified engines remains the caller's responsibility.

The action is in `actions/check/`. Public references work only after the referenced commit is available in the selected repository. Pin the action to a full reviewed commit SHA that contains this directory. The action commit and the CLI `version` are independent pins. A Marketplace listing is not required to use a repository action.

## Workflow example

Replace `<ACTION_COMMIT_SHA>` and the example CLI version with available, reviewed values. Commit `erden.lock` alongside your project. Checkout happens before validation; full history helps when evidence cites earlier commits.

```yaml
name: Validate knowledge
on:
    pull_request:
    push:
        branches: [main]
permissions:
    contents: read
jobs:
    validate:
        runs-on: ubuntu-24.04
        steps:
            - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
              with:
                  fetch-depth: 0
                  persist-credentials: false
            - name: Validate the Erden project
              id: erden
              uses: cbnsndwch/erden/actions/check@<ACTION_COMMIT_SHA>
              with:
                  version: '0.1.0'
                  project: knowledge
            - name: Save reports, including failed validation
              if: ${{ always() && steps.erden.outputs.reports-path != '' }}
              uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
              with:
                  name: erden-validation
                  path: ${{ steps.erden.outputs.reports-path }}
                  if-no-files-found: error
```

For an action checked out in the current repository, use `uses: ./actions/check`. A consuming repository must check out the action code separately before using a local path to it; downloading the CLI alone does not install this action.

## Inputs

| Input        | Default  | Meaning                                                                                                                                                |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`    | Required | Exact CLI version, optionally prefixed with `v`. No `latest`, semver ranges, or silent fallback. The selected executable must report the same version. |
| `project`    | `.`      | Project directory inside `GITHUB_WORKSPACE`; absolute paths inside the workspace are also accepted. Paths resolving outside it are refused.            |
| `offline`    | `false`  | Pass `--offline` to dependency installation and checking. Required dependency artifacts must already be cached.                                        |
| `erden-root` | Empty    | Prepared release directory. Skips all runtime downloads and executes its bundled Node and CLI directly.                                                |

An empty `erden-root` downloads `erden-<version>-<platform>.tar.gz` (ZIP on Windows) and `SHA256SUMS` from the exact `cbnsndwch/erden` GitHub release. The archive must match its one listed SHA-256 before extraction. This verifies consistency with that release's checksum file; it is not an independent signature or protection against a compromised publisher. The verified release code is trusted to execute. Installation is temporary and does not change the user's home, PATH or global tools. `tar` must be available on the runner.

Supported release platforms are Linux x64/arm64 with glibc, macOS arm64, and Windows x64. Self-hosted runners must support JavaScript actions using `node24`. Each CLI phase has a five-minute timeout; download requests have a one-minute timeout and archives are limited to 512 MiB.

### Prepared distribution

A prior trusted workflow step can build or acquire a qualified distribution. Supply its root:

```yaml
- uses: ./actions/check
  id: erden
  with:
      version: '0.1.0'
      project: knowledge
      erden-root: ${{ runner.temp }}/prepared-erden
      offline: 'true'
```

The root contains `node/node` (`node/node.exe` on Windows), `lib/dist/bin.js`, and the CLI's runtime dependencies and engine distributions. This is the layout produced by `release/build-cli-archive.mjs`, not an arbitrary source checkout or a directory containing only a launcher. The action preserves an existing prepared distribution and still runs version verification and `doctor`.

`offline: true` covers project operations, not runtime acquisition. Combine it with `erden-root` for a run that does not download the runtime. Private dependency authorization must already be configured through Erden's supported credential mechanism; the action introduces no credential format or token input. Use the normal `pull_request` event, not a privileged `pull_request_target` workflow that checks out and runs untrusted changes with secrets.

## Results and failure behavior

| Output         | Meaning                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outcome`      | `passed`: the CLI completed validation successfully. `failed`: completed validation rejected the knowledge. `error`: setup, installation or validation could not complete, or its report was unusable. |
| `exit-code`    | Exit code from the failing CLI phase; action/input/report errors use 1.                                                                                                                                |
| `report-path`  | Absolute path to `check.json` for a completed, consistent check report; empty when none is available.                                                                                                  |
| `reports-path` | Temporary directory with `result.json`, raw stdout/stderr per executed phase, and structured reports.                                                                                                  |

A `failed` or `error` outcome fails the action. Outputs and reports are written before it exits. Use a subsequent `always()` upload step, as shown above; the action itself does not upload artifacts or write PR comments. The summary lists stage outcomes without converting skipped stages into passes. Warnings keep the CLI's existing policy and do not independently fail the job.

The action runs:

```text
erden --version
erden doctor --json
erden install <project> --frozen-lockfile [--offline] --json
erden check <project> [--offline] --json
```

Frozen installation requires a compatible committed lockfile. It materializes local installation state and may populate the artifact cache; it does not resolve a new dependency set. No `update`, `publish`, `login`, shell command supplied by an input, or unchecked engine fallback is used. Raw CLI output is captured rather than replayed as workflow commands; annotations escape diagnostic text. File annotations use known source files without inventing source locations. The full JSON report retains details beyond the bounded annotation/summary excerpts.

## Development and validation

Run the dependency-free adapter tests with the repository's pinned Node version:

```bash
node --test scripts/test/check-action.test.mjs
```

The tests execute a protocol fixture through real child processes and exercise verified synthetic archive extraction. `.github/workflows/check-action.yml` runs those tests and invokes the local action on all four supported runner platforms. The fixture explicitly does not validate ontologies or stand in for the Erden engines.

Local integration on macOS arm64 additionally runs this action against the existing qualified CLI and engines: the demo passes all six stages, and an isolated SHACL violation produces `outcome: failed`, exit code 1, and retained reports. Both runs preserve the project source files and lockfile. Downloading and checking an actual public release remains unverified until the first release is available.

The first native [GitHub Actions verification run](https://github.com/cbnsndwch/erden/actions/runs/42899530417) passed all four platform jobs at implementation commit `5ebd498`, including all 18 adapter tests and the local action's passing/failing protocol fixtures. This verifies the GitHub integration separately from the local real-engine checks above.
