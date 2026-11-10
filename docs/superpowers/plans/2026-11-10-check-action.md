# Erden Check Action Implementation Plan

> **For agentic workers:** Use inline execution with test-driven development and verification before completion. The user authorized implementation of the proposed validation action.

**Goal:** Let developers validate an Erden project in GitHub Actions and inspect its actual results.

**Architecture:** A dependency-free Node 24 action adapts the existing CLI. Separate runtime acquisition, workflow reporting, and orchestration; keep JSON evidence in the runner temporary directory.

**Tech Stack:** JavaScript ESM, Node built-ins, GitHub Action metadata, existing Erden CLI contracts.

## Task 1: Behavioral contract

Files: `scripts/test/check-action.test.mjs`, `actions/check/action.yml`, `actions/check/index.mjs`, `actions/check/lib/reporting.mjs`.

- [x] Create a process-based release-layout fixture and run the action as GitHub does, through INPUT_* and runner environment files.
- [x] Assert version → doctor → install --frozen-lockfile → check, exact/offline arguments, output JSON, and preserved failing exit codes. Observe a failing test before implementation.
- [x] Implement orchestration and escaped reports. Add operational failure, malformed JSON, hostile text and path tests; run `node --test scripts/test/check-action.test.mjs`.

## Task 2: Runtime acquisition

Files: `actions/check/lib/runtime.mjs`, `scripts/test/check-action.test.mjs`.

- [x] Add failing tests for exact-version selection, archive names, checksum refusal, unsupported platforms, and release HTTP failures.
- [x] Download the archive from the canonical versioned release URL and verify SHA256SUMS before extraction. Reuse an explicitly selected prepared runtime without network.
- [x] Test actual extraction of a synthetic archive and execute the resulting fixture CLI; rerun the complete action suite.

## Task 3: Integration and documentation

Files: `actions/check/README.md`, `.github/workflows/check-action.yml`, `scripts/test/fixtures/check-action-cli.mjs`, `README.md`.

- [x] Document inputs, outputs, permissions, prepared runtimes, reproducible action refs, and an always-upload example.
- [x] Add native runner tests and invoke the actual local action with the clearly labeled fixture.
- [x] Run the action against the real qualified CLI on a valid demo and an isolated invalid SHACL fixture.
- [x] Run formatting, lint, repository boundaries, and metadata/workflow validation; review the final diff, commit, and open an independent upstream PR.

## Decisions and evidence

- The new branch starts at upstream main so the action PR does not include the skills changes.
- No published releases exist yet. Prepared-runtime execution and synthetic download tests can be verified now; real public-release installation remains pending the first release.
- Existing `shacl/target/` and the skills branch stay in the original checkout.

- Task 1: complete. Initial process tests failed without the action implementation, then all ten passed. A subsequent regression test demonstrated missing doctor.json on engine failure; preserving that structured report fixed it.
- Task 2: complete. Three download tests failed before acquisition existed, then passed after exact-release download, digest verification and extraction were implemented. A fixture-construction mistake was corrected before treating the download tests as the red baseline.
- Task 3: local real-CLI integration passes for both a valid demo and an isolated SHACL failure. Source files and lockfile remain unchanged. The fresh review and its regression fixes are complete. All four native action jobs passed on upstream GitHub Actions run 42899530417.
- Ruling: checksum verification trusts the canonical publisher and release checksum file; it does not imply an independent signature. Prepared runtimes are explicitly trusted caller inputs and still undergo doctor checks.

- Final fresh review identified an expected-competency-failure annotation mismatch and a dependency-source locator mismatch. Both were reproduced with failing process tests and corrected: annotations follow blocking policy and only root-owned shape sources receive checkout file links.

- Final verification: 18/18 action tests pass locally; the real CLI integrations still return passed/0 and failed/1 after the review fixes. Formatting, type-aware lint, repository boundaries, legal checks, metadata and YAML examples pass.
- Native verification: [upstream run 42899530417](https://github.com/cbnsndwch/erden/actions/runs/42899530417) passed the action suite and local action invocations on Ubuntu x64, Ubuntu arm64, macOS arm64, and Windows x64 at implementation commit `5ebd498`. These use the explicitly labeled protocol fixture; real engine integration was run locally on macOS arm64.
- Delivery: [PR #7](https://github.com/cbnsndwch/erden/pull/7), based directly on upstream main and independent of the skills PR. Actual public-release acquisition remains pending the first upstream release; no release or tag was created.
