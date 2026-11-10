# Skill validation and evaluation

The six English skills were exercised on 2026-11-10 against Erden upstream `1dc6fd0`, with skill source `84c7038`, CLI package `0.1.0`, and Codex CLI `0.166.0-alpha.5.1` on macOS arm64. The qualified reasoner and SHACL engines were available. All 18 behavioral scenarios ran once with the relevant skill and once without it; two query scenarios then received paired reruns after correcting evaluation-harness limitations. All 36 automatic-selection prompts also ran once. These are initial behavioral measurements, not a reliability guarantee across models or clients.

## Current English evaluation

The [recorded results](evaluation-results/2026-11-10-english.json) preserve both the initial comparison and the corrected query reruns, along with per-assertion evidence. Each behavioral run used a fresh ephemeral Codex session, equivalent inputs, the real built CLI, and separate project/configuration/cache directories. With-skill runs received the relevant installed skill; baseline runs received no Erden skill. Generic host skills remained available to both. Separate grading agents checked command records, generated RDF, source hashes and validation reports rather than accepting the final answers alone. The exact executor model ID was not exposed, so no model-specific claim is made.

| Measurement                                         | With skill | Without skill  |
| --------------------------------------------------- | ---------- | -------------- |
| Initial comparison: observable assertions           | 55/56      | 48/56          |
| Corrected comparison: observable assertions         | 55/56      | 49/56          |
| Corrected comparison: cases meeting every assertion | 17/18      | 13/18          |
| Automatic selection, positive and near-miss prompts | 36/36      | Not applicable |

The corrected comparison uses the two query reruns plus the other 16 original scenarios. It does not discard the initial evidence or combine different harness conditions as repeated trials. Both query reruns finish successfully in both conditions; the skill's supported query succeeds immediately, while the baseline first receives an unbounded-path rejection and then recovers.

The one unmet with-skill assertion is a real CLI limitation: `update` returns `PROJECT_DEPENDENCIES_REGISTRY_UNAVAILABLE` before any HTTP request. At `1dc6fd0`, the default service wires `update` to `unavailableDependencyRegistry` in `packages/project/src/project-dependencies/operation.ts`. Both conditions kept the existing lock and reported the blocker. This is an incomplete user task, even though the skill handled the failure correctly. The dependency reference now documents the observed revision-specific limitation.

The baseline omitted SHACL and competency questions when creating a model, failed to inspect the checkout runtime pins, attempted unsupported `remove --dry-run` during a preview-only request, and attempted publication before checking. The latter failed locally before upload; it subsequently checked and completed the simulated publication. These are observed differences in individual runs, not statistically established benefits.

### Registry simulation and coverage limits

Registry scenarios used a disposable loopback server, real CLI archives and cache materialization, synthetic credentials, and an Oxigraph dataset containing the expected supplier. Offline restore, preview-only removal, exact-version querying, and publication polling were exercised. Publication advanced through simulated queued/validating/succeeded states. No production registry was contacted and no real model was published.

The initial query simulator accepted an unbounded property path that the production contract forbids. A targeted guard was added and checked with 18 lexical cases and seven real CLI requests before rerunning both query agents. It is still an incomplete policy simulator. Publication runs also shared an idempotent attempt: the baseline reused the first run's uploaded archive, so an independent second archive transfer was not tested. Real server-side validation, authorization failures, and separate-user publication isolation remain release checks.

The initial missing-version query comparison also had an overbroad network restriction. Both corrected reruns passed after the harness prohibited only premature requests. The rubric requires asking for the exact version; it does not require reciting an unused default registry. Setup grading likewise avoids requiring registry discussion for a question limited to local validation readiness. Original results and these corrections remain visible in the result record.

The setup scenario used already-installed runtimes selected by the harness; it proves inspection and verification, not installation or recovery on a clean machine. The model-creation example is close to the skill's documented example, so testing unrelated domains is still needed. The activation test stopped after observing the selected skill's content load and measured routing only; one pass per prompt does not measure repeatability.

### Evaluation repairs

The original model-edit fixture described an unrelated artifact and could not test preservation of a preferred-supplier rule. The English runs used a real supplier fixture instead. The checked-in modeling fixture now matches that scenario; the creation case supplies only notes. Its notes explicitly include the subclass rule, its manifest uses the hosted default rather than a local test-server port, and an offline install followed by a real check passes all six stages. The preparation rubric now accepts actual healthy validation and packaging rather than assuming the old missing-SHACL blocker. All 18 case files include their observable grading expectations.

## Structural and installation checks

- Formatting and repository boundary checks pass.
- All six entrypoints pass the installed skill-creator `quick_validate.py` with PyYAML supplied through an isolated `uv` environment.
- Names match their directories. All per-skill Markdown references resolve inside the installed skill. Evaluation fixture paths and Codex interface metadata were checked.
- The installed older validator does not recognize the standard's optional `compatibility` frontmatter field. Requirements therefore live in each skill body; the remaining frontmatter works with both that validator and the portable format.
- `npx skills add ./ --list` discovers exactly six skills.
- Installing all six with `--agent codex --copy --yes` into a clean temporary project succeeds. No global skill installation was performed. Telemetry and audit requests were disabled for this local test with `DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1`.

Portable structural validation can also use the [Agent Skills reference library](https://github.com/agentskills/agentskills/tree/main/skills-ref), once installed:

```bash
for skill in skills/erden-*; do
  skills-ref validate "$skill"
done
```

The reference-library command above is a documented alternative; the observed six passes were from the local skill-creator validator. Neither proves behavioral reliability.

From this repository root, formatting and discovery can be repeated with:

```bash
pnpm exec oxfmt --check skills docs/skills-research.md docs/superpowers/plans/2026-11-10-erden-skills.md README.md
npx skills add ./ --list
```

To check installation without changing the repository or global skills, run the following from a new temporary directory, replacing the path with the real checkout:

```text
npx skills add /absolute/path/to/erden --skill '*' --agent codex --copy --yes
```

## Historical initial behavioral smoke evaluation (`e937a6f`)

Three representative tasks were run once each with a skill and once without it, in separate fresh agents and output directories. The agents had the same built CLI and equivalent fixture copies. No remote registry operations were permitted.

| Task                                       | With skill       | Without skill    | Observation                                                                           |
| ------------------------------------------ | ---------------- | ---------------- | ------------------------------------------------------------------------------------- |
| Inspect local readiness without changes    | 3/3 expectations | 3/3 expectations | Both correctly distinguished healthy Node/reasoner from unavailable SHACL             |
| Query with no selected version or registry | 3/3              | 2/3              | The skill asked for both missing target fields; the baseline asked only for a version |
| Prepare version 1.2.0 without upload/login | 3/3              | 3/3              | Both created an archive and disclosed the blocked semantic check; neither published   |

The missing-registry expectation above is obsolete at `1dc6fd0`, which defaults to the hosted origin when no project/registry is specified. It must not be used to claim an advantage for the current skill. Current query instructions ask for the exact version and use the documented default unless another destination needs clarification.

The [recorded expectations and grading evidence](evaluation-results/2026-11-10-smoke.json) preserve the initial comparison. The author graded the saved answers and command logs and independently compared the preparation fixture hashes and produced archives. This is a narrow smoke evaluation, not a statistically reliable quality score or independent grading benchmark. The exact executor model ID, token totals and run durations were not exposed by the agent notifications, so no model-specific, cost or speed claims are made.

Both preparation agents initially chose an unsupported archive extension and recovered after reading the CLI error. This was a real instruction gap beyond the original pass/fail criteria. The publication reference now explicitly requires `.erdenpkg` and explains how to label a package when local validation is blocked. A fresh-agent follow-up used `.erdenpkg` on its first and only pack invocation, succeeded, preserved all fixture files and explicitly labeled the package unvalidated. The follow-up is recorded separately from the initial comparison.

Both successful initial artifacts contained six files, were 12,311 bytes and had SHA-256 `2e184e8dbf8827441da1fd9d9f631bec63a585dd0ee560485c2f64ffc94fc844`. All six source fixture files remained byte-identical to the supplied demo. Packaging success does not imply semantic validity.

An additional independent read-only source review found no material mismatch between the six skills and the inspected CLI/contracts. That review covers command and instruction consistency, not successful live execution of every workflow.

## Initial runtime findings (`e937a6f`)

The first diagnostic used the shell's Node 24.11.1 and found a mismatch with the checkout's required 24.17.0, plus missing SHACL. Node 24.17.0 and Rust 1.98.0 were already installed; selecting them for the task resolved the runtime selection issue without changing global shell configuration. Runtime package compilation passed.

With Node 24.17.0:

| Check                                                 | Observed result                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `doctor --json`                                       | Exit 1: Node and reasoner pass; SHACL reports `BINARY_MISSING`          |
| `check examples/erden-demo --offline --json`          | Exit 3: `CHECK_SHACL_ENGINE_UNAVAILABLE`                                |
| `init <new-temporary-project> --json`                 | Exit 0: project created with the verified reasoner despite absent SHACL |
| `pack 1.2.0` on an isolated demo copy                 | Exit 0: archive created and source files unchanged                      |
| `pnpm run build:shacl` with the pinned Rust toolchain | Compilation succeeds, but artifact verification rejects the result      |

The SHACL build produced 9,616,368 bytes with hash `4f27bf0db53dd9a12fdc7d6bbf9771baa3d579aaaa8c4c148d246e95ea6b26f5`; the pinned hash is `f96a8ddac5e32c2e9be0c5261626b7439bf5bd4de5a36d4dbfd627b2dfb4ad4f`. The build script correctly refused installation. No digest checks or production code were changed. This initially blocked semantic validation. The matching qualified binary was subsequently installed as described below; the host source-build mismatch remains reproducible.

Additional CLI checks confirmed that `query --offline` and a query target with a semver range both fail with usage exit 2 before a registry call. The initialization smoke test corrected an overly broad readiness assumption: setup guidance now separates initialization/packaging from full semantic validation.

## Upstream compatibility update (`1dc6fd0`)

The current instructions use `erden --version`, the hosted registry default for query/status/login/logout, the default registry written by `init`, the current evidence namespace, and `publish --no-wait` for an upload-then-poll workflow. `publish` itself still requires the selected manifest registry. Invalid or unreadable manifests must not silently fall back to another registry.

After rebuilding runtime packages, CLI smoke checks returned version `0.1.0`, initialized a new project with `registry: https://registry.erden.sh`, and confirmed that Node and the reasoner pass while SHACL still reports `BINARY_MISSING`. At this stage the engine rebuild had not been rerun after rebasing, and no engine pins were changed. The later recovery below includes a fresh reproduction.

The affected CLI suites were run with the pinned Node version and a canonical, task-local `TMPDIR` (avoiding macOS `/var` versus `/private/var` path aliases):

```bash
pnpm exec vitest run apps/cli/test/query.test.ts apps/cli/test/registry.test.ts apps/cli/test/index.test.ts
```

Initial result: **147 passed, 1 failed**. Both query and registry suites passed. The real `doctor` known-answer test failed because the SHACL engine was missing. All 148 CLI cases pass after the recovery below. The full workspace gate was not claimed to pass.

A fresh-agent query regression against the updated skill asked only for the missing exact version, named `https://registry.erden.sh` as the default, and made no registry calls. It verifies the revised clarification behavior, not a successful remote query or a new with/without benchmark.

The packaged demo fixtures now use `https://erden.sh/o/erden/evidence#`, matching upstream. The historical package hashes above apply to the old fixtures, not these updated copies. No live registry operations were used in this update.

## Qualified SHACL engine recovery (`560295c`)

A fresh source build reproduced the same `4f27bf0d...` digest mismatch with the pinned Rust 1.98.0 toolchain. Native linker inputs differ: the qualified Mach-O binary records SDK 15.5 and linker 1167.5, while the existing local source build records SDK 27.0 and linker 27037.1. Matching Rust and Cargo.lock alone therefore does not reproduce this platform's pinned executable.

The canonical upstream [SHACL workflow run 40711192325](https://github.com/cbnsndwch/erden/actions/runs/40711192325), built from `a65794c4d925c46d5ec31b5916d785b8e307010a`, still provided `shacl-aarch64-apple-darwin` (artifact ID `12826538833`). Its executable was downloaded into a temporary directory and verified against the current checkout's committed platform metadata before installation: **9,616,368 bytes**, SHA-256 **`f96a8ddac5e32c2e9be0c5261626b7439bf5bd4de5a36d4dbfd627b2dfb4ad4f`**. Both match exactly.

The verified executable was installed at `shacl/darwin-arm64/bin/erden-shacl` with executable permissions. This binary is gitignored and is not part of the PR. No source-build override, changed pin, or resolver bypass was used. CI artifacts can expire; this records the verified recovery source, not a permanent release download route.

With Node 24.17.0, the following direct checks now pass:

| Check                                                        | Observed result                                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `node shacl/qualification/build-from-source.mjs --check`     | Exit 0; installed engine matches its pin                                                  |
| `doctor --json`                                              | Exit 0; Node, reasoner and SHACL pass, including both engine self-tests                   |
| `check examples/erden-demo --offline --json`                 | Exit 0; all six stages pass, including SHACL and competency questions                     |
| An isolated demo with `sh:hasValue demo:MissingRequiredType` | Exit 1; SHACL reports one `HasValueConstraintComponent` violation and `shacl-conformance` |
| Fresh `init`, followed by offline `check`                    | Both exit 0; the empty scaffold skips SHACL and competency questions as expected          |
| `node shacl/qualification/verify-distribution-closure.mjs`   | Exit 0; platform metadata, executable and pinned known answer agree                       |

The existing demo retains its informational `no-commit-cited` citation warning. The invalid fixture was changed only in a temporary copy, leaving the checked-in demo intact.

The same three CLI suites plus `shacl/distribution/test/index.test.ts` now report **159 passed, 6 skipped, 0 failed** with the pinned Node runtime and a canonical temporary directory. This resolves the earlier real-doctor failure. These are runtime and CLI checks, not a rerun of the agent skill evaluations or a claim that the entire workspace gate passes.

## Evaluation cases included for continued work

Each skill has `evals/evals.json` with three behavioral cases, and `evals/triggers.json` with three positive and three near-miss negative activation prompts. Together these are 18 behavioral cases and 36 trigger queries in English. The case files describe the executed scenarios; they are not a standalone runner. Reproduce them with an agent-evaluation harness and the fixture preparation below.

Check and publish skills include the dependency-free demo under `evals/files/project/`; model editing uses the supplier fixture in its own skill. Model creation starts with `evals/files/notes.md` and no existing project. Copy only the case's listed files into a fresh temporary directory for each condition. For an existing project, run `erden install <temporary-project> --offline --json` during fixture preparation so the canonical lock has materialized installation state. Do not count this evaluator setup as an agent action. Preserve the user-supplied evidence. For a deliberately failing SHACL scenario, the evaluator must construct the stated failing condition in its temporary copy and record that change; the bundled fixture itself is the original valid demo.

For positive query, dependency and publication cases, provision a disposable test registry with known packages, versions, vocabulary, credentials and expected results. Replace example identities with that fixture's actual identities in the run metadata. Never aim a synthetic test at an unknown public registry or use real production credentials just to complete coverage.

Use the [skill-creator evaluation workflow](https://github.com/anthropics/skills/tree/main/skills/skill-creator): keep per-run outputs and command logs outside distributable skill directories, compare identical inputs with/without the skill, grade observable outcomes, and use its review generator to inspect results. Expand the trigger set and repeat each query across the intended agents/models before advertising reliable automatic activation.

Remaining release checks:

- Repeat behavioral and activation cases across the intended models and clients; add unrelated modeling domains, inconsistent ontologies, and clean-machine setup/recovery.
- Repeat registry workflows against a disposable instance of the actual registry service, including authorization failures, independent uploads and terminal validation failure. Resolve the real dependency-update CLI blocker.
- Verify automatic activation across supported target clients; the current 36-prompt run covers only the native Codex CLI environment.
- Clean public GitHub installation from `cbnsndwch/erden` and actual skills.sh indexing after the files are merged into its default branch.
