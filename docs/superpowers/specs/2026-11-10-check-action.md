# Erden validation action

The user selected the proposed GitHub Action: validate ontology changes in pull requests and expose actionable results. Implement it independently of the skills PR, based on upstream `1dc6fd0`.

## Interface and execution

Publish a JavaScript action at `actions/check/action.yml`, using GitHub's Node 24 runtime and no installed npm dependencies. Inputs are `version` (required exact CLI version, optional leading v), `project` (workspace-relative directory, default .), `offline` (false by default), and `erden-root` (optional prepared release directory). A prepared directory contains `node/node[.exe]` and `lib/dist/bin.js`; its reported CLI version must match the requested version.

Without `erden-root`, download only the exact upstream platform archive and SHA256SUMS, verify the archive digest before extraction, and unpack under RUNNER_TEMP. Support the existing release matrix: Linux x64/arm64, macOS arm64, Windows x64. Execute the bundled Node directly with argument arrays. No global installation, shell interpolation, publication, or login.

Run version verification, doctor, frozen dependency installation, and check in that order. Offline mode applies to install and check; downloading the runtime still requires network unless erden-root is supplied. Preserve the project's lock and manifest. Classify completed semantic validation separately from operational errors: `passed`, `failed`, or `error`. Keep the original check exit code available.

Write escaped GitHub annotations and a Markdown job summary. Save stdout/stderr for each executed phase, structured reports when available, and a result envelope under RUNNER_TEMP. Expose `outcome`, `exit-code`, `report-path`, and `reports-path`; the documented caller uploads the directory using always(), including after failure. A failing check fails the action. Warnings retain the CLI's existing policy.

## Verification and distribution boundary

Use dependency-free Node tests with a process fixture to verify phase ordering, exit codes, frozen/offline arguments, path boundaries, malformed reports, version/engine failures, and workflow-command escaping. Test download integrity/extraction against synthetic release archives and verify real check success and SHACL failure with the existing qualified local CLI. Add native GitHub runner tests and a local action invocation using a clearly labeled protocol fixture.

As of November 10, 2026 the upstream release list is empty. An exact public release cannot be downloaded end to end yet. Document this honestly, support prepared runtimes now, and do not create a release/tag or change engine pins as part of this work. Keep all repository content in English.
