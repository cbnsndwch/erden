---
name: erden-setup
description: Check and prepare everything needed to use Erden, including the CLI, runtime, reasoning and SHACL engines, project configuration, and task-specific registry access. Use when someone wants to start using Erden, asks whether their computer is ready, says “set up Erden” or “Erden is not working for me”, or encounters installation and missing-engine errors. Do not use for generic machine setup unrelated to Erden or for checking the meaning of an ontology.
license: Apache-2.0
metadata:
    version: '0.1.0'
---

# Prepare Erden

Requirements: Requires an agent with terminal and filesystem access. Network is needed for downloads and registry operations, but not for local diagnostics.

Make the environment ready for the user's intended task and explain the result in their language. A request to inspect readiness authorizes diagnostics; a request to install or fix authorizes the corresponding setup work. Carry forward that scope without repeatedly asking for the same permission.

## Determine what needs to work

Use the conversation and current directory to identify the task. Full local validation needs both local engines. Initialization needs a verified reasoner identity but can succeed without SHACL; drafting files and packaging do not establish semantic validity. Remote queries need a working CLI, a registry and an exact published version; a missing local reasoner alone does not establish that a remote query is blocked. Publication also needs registry authorization. Do not require a project merely to run `doctor` or initialize a new one.

## Inspect before changing anything

1. Find `erden` or its equivalent alias `den` using the platform's executable lookup, then run `erden help`. Record the executable selected and its `erden --version` output. If an older CLI lacks that flag, use its available help and installation metadata instead.
2. Run `erden doctor --json`. Read the exit code, stderr and JSON. Inspect `node`, `reasoner`, `shaclEngine` and `outcome`; report a missing section as unverified. A binary existing somewhere on disk does not mean the CLI resolves and accepts it.
3. Distinguish a release archive installation from a source checkout. Release archives bundle Node and both engines. Do not require a separate Node, Rust, Docker or pnpm installation for a healthy release. For a source checkout, read its `.node-version`, `packageManager`, README and pinned toolchain files rather than guessing versions.
4. When a project is relevant, locate its actual `erden.config.*` and inspect the configured sources and registry without printing credentials. A project manifest is not required for a remote query: an explicit registry or the built-in hosted origin can be used. Do not fall back past an invalid or unreadable project manifest.
5. Check only the remote capability the task needs. `doctor` does not test registry connectivity, authorization or ontology validity. There is no `erden whoami` or `login --status`. Mark access as unverified until the requested read or publication establishes it; do not probe access by publishing.

Read [runtime.md](references/runtime.md) when installation, source builds, platform selection or a failed doctor report needs attention.

## Repair and verify

- If setup or repair was requested, apply the smallest relevant fix: select an existing compatible runtime, install the matching official user-local distribution, or build the missing pinned component in a source checkout. A check-only request should return findings without installing or modifying configuration.
- Resolve an official release and its supported platform before downloading. If no public release is available, state that and use the source workflow only when it fits the requested setup. Never substitute an unrelated npm package named `erden`.
- Treat a digest mismatch as a failed verification. Do not disable checks, edit pins or copy an arbitrary engine into place to make the report pass.
- If authentication is needed, run `erden login --registry <origin>` and let the user complete the displayed device-login step. Never read credential storage into the conversation or claim the user completed login before the CLI confirms it.
- Rerun `doctor --json` after a runtime/engine fix. For an existing local project, run the requested `check --json` separately. Fixing the environment does not certify the project's knowledge.
- If the same failure remains after a relevant correction, report its evidence and the next missing prerequisite. Do not keep reinstalling unchanged components.

## Report readiness precisely

Return a small table of the components checked, their observed status and any action taken. State readiness for the requested task, separating local engine readiness, project validation and registry access. Include the next concrete step only for unresolved items. Do not describe untested components as ready.

Example requests: “I want to use Erden for the first time; set up what I need.” / “Check whether this machine can run Erden locally; don't change anything.”
