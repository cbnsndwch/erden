# Erden Agent Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver six independently installable skills that let people set up and use Erden through natural language, with public distribution instructions and reproducible checks.

**Architecture:** Keep the portable skills in `skills/<name>/`, alongside the CLI they describe. Each skill owns its instructions, conditional references, Codex interface metadata and behavioral evaluation cases. Use the existing CLI and JSON contracts; add no production API, wrapper CLI or MCP service.

**Tech Stack:** Markdown, YAML, JSON, the Erden CLI, Agent Skills validators and the Vercel skills CLI.

---

The user accepted the proposed collection with an additional environment-readiness skill. This plan incorporates that requirement. Implementation proceeds in this session; no further design choice is required.

### Task 1: Runtime and setup

**Files:** Create `skills/erden-setup/SKILL.md`, `references/runtime.md`, `agents/openai.yaml`, `evals/evals.json` below that skill directory.

- [x] Describe checks for CLI availability, distribution versus source checkout, Node compatibility, reasoner and SHACL self-tests, and task-specific project/registry readiness.
- [x] Document the release installation route and the source-build route from the repository README; do not assume that a release exists or that npm installation is supported.
- [x] Use the pinned local Node runtime to build runtime packages and exercise `doctor --json`; report the actual state without treating engine failure as invalid knowledge.

### Task 2: Modeling and checking

**Files:** Create `skills/erden-model/` and `skills/erden-check/`, each with `SKILL.md`, `agents/openai.yaml`, `evals/evals.json`, and focused references.

- [x] Ground model creation in the manifest schema and the demo's evidence, SHACL and competency-question formats.
- [x] Define bounded edit/check loops, evidence preservation and a clear distinction between validated structure and factual truth.
- [x] Exercise a fresh project, the existing demo and an isolated fixture with an intentionally failing SHACL constraint. After installing the exact pinned upstream engine, the demo passes and the invalid fixture reports the expected violation. See `skills/TESTING.md`.

### Task 3: Querying, dependencies and publication

**Files:** Create `skills/erden-query/`, `skills/erden-dependencies/` and `skills/erden-publish/`, each with the same portable entrypoint and evaluation layout.

- [x] Document exact-version remote queries, supported query forms and result provenance; do not invent a local query command or latest-version alias.
- [x] Document dependency selection, manifest and lockfile handling, frozen installs, and read-only cache inspection.
- [x] Distinguish check, pack, upload, pending publication and final publication; preserve authorization and requested visibility.
- [x] Test query refusal, missing configuration and prepare-only publication behavior without publishing to a live registry.

### Task 4: Discovery and maintainability

**Files:** Create `skills/README.md` and `skills/TESTING.md`; update `README.md` and `docs/skills-research.md`.

- [x] Explain independent installation, prerequisites, natural-language examples, licensing, compatibility, update expectations and skills.sh indexing.
- [x] Confirm `cbnsndwch/erden` as the public upstream and `el-frontend/erden` as the contribution fork, using local installation commands before upstream integration.
- [x] Record test commands, observed outcomes and limits honestly, including any evaluations that require a registry fixture.

### Task 5: Validation

- [x] Validate all six frontmatters with the skill-creator validator and check local Markdown references and JSON evaluation cases.
- [x] Run `pnpm exec oxfmt --check skills docs/skills-research.md docs/superpowers/plans/2026-11-10-erden-skills.md README.md`.
- [x] Run `npx skills add ./ --list` with telemetry disabled and verify that all six skills are discoverable.
- [x] Perform representative behavioral evaluations of setup, query and publication boundaries; separate observed runs from proposed future tests.
- [x] Run all 18 English cases with and without skills, plus 36 automatic-selection prompts. Preserve two paired query reruns after correcting harness limitations, and record the real CLI update blocker separately from agent behavior.
- [x] Inspect the final diff and repository status; preserve the pre-existing untracked `shacl/target/` directory.

No production publishing, login or remote writes are required to deliver this collection. Public installation and registry-dependent end-to-end checks remain explicitly distinguished from local validation.

## Completion record

Six skills were authored and installed in a clean temporary project. Structure, fixture paths, interfaces, formatting and repository boundaries pass. Initial smoke testing identified an output-extension gap, which was fixed and verified. The qualified SHACL engine was restored from an exact-match upstream artifact; direct CLI semantic validation and an invalid-constraint check pass their expected outcomes.

All 18 English scenarios then ran with and without skills, plus two paired query reruns after harness corrections. With skills, 17/18 scenarios meet every assertion; the remaining update scenario is blocked by the actual CLI resolver wiring. All 36 automatic-selection prompts pass once. Registry behavior was exercised through a disposable simulator, with real-service and broader client/model checks still pending as recorded in `skills/TESTING.md`. No production code, engine pins, global shell configuration or production registry state was changed.
