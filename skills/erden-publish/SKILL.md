---
name: erden-publish
description: Prepare, package and publish an Erden knowledge release, or inspect its publication status and validation report. Use when someone asks to share/version knowledge in the Erden registry, “publish this version”, prepare a release without uploading, or investigate a rejected publication. Do not publish merely because someone asked to model, validate or query knowledge.
license: Apache-2.0
metadata:
    version: '0.1.0'
---

# Release Erden knowledge

Requirements: Requires terminal/filesystem access and the Erden CLI. Local validation needs its engines; publication and status reads need the configured registry, network and appropriate authorization.

Complete the requested release stage and explain the result in the user's language. Preparing a release, uploading an attempt and obtaining a published version are distinct outcomes.

## Establish release intent

Inspect the actual manifest, requested version, canonical identity, alias, registry and project visibility when known. Reuse the user's explicit choices and authorization. Resolve only missing consequential information before a remote write; do not ask again for publication permission already given.

“Prepare”, “package” or “show what would be published” alone means local preparation. “Publish version X to this registry” authorizes that specified publication. Do not infer a public visibility change from a request to share privately. Read [publishing.md](references/publishing.md) before choosing flags.

## Prepare a reviewable artifact

1. Locate `erden`/`den`, or an already built source CLI. If necessary, run `doctor --json` and resolve relevant local engine issues; use `erden-setup` if available, otherwise report the concrete prerequisite.
2. Inspect the source set and package boundaries. Preserve existing user edits, intended evidence and dependency constraints. Do not put credentials or unrelated files into a package.
3. Run `erden check <project-dir> --json`. A failed check needs its actual explanation; do not suppress diagnostics or change semantic expectations just to publish. Do not proceed to publication while the required validation is unsuccessful or unavailable. A local pass does not guarantee the registry verdict under different limits.
4. Use `erden pack <version> <project-dir> --json` for a requested local artifact, with an explicit `--output <new-file.erdenpkg>` when useful. Keep its actual path, version, manifest hash and archive hash from the report. Packing itself is not semantic validation. If validation was blocked, a requested local package may still be produced; label it unvalidated and do not present it as ready for publication.
5. For a preparation-only request, finish here with the validation result, package details and unresolved decisions. Do not log in or call `publish` just to test access.

## Publish and follow the attempt

For a requested publication, ensure the configured registry and identity match the requested destination. If credentials are missing or expired, run `erden login --registry <origin>` and wait for the user's device authorization; never display stored secrets.

Run `erden publish <version> <project-dir> --no-wait --json` for an upload-then-poll workflow, with creation flags only when creating a registry project is part of the request. `publish` packs the project itself; it does not accept the previously created archive as its positional input. Keep the prepared source state stable between validation and publication.

For a new project in a noninteractive agent session, use `--create --visibility <public|private> --yes` only after identity, creation and visibility are covered by the user's request. `--yes` carries that authorization to the CLI; it does not create authorization by itself.

Read the returned attempt state and identifier. Use `erden publication <attempt-id> --registry <origin> --wait --report --json` to obtain status/report, or the non-waiting form for a quick status check. Preserve the same attempt when an operation is pending or a wait times out; do not blindly create another upload. If a bounded wait remains pending, report that state and the next status command.

## Report the actual outcome

Distinguish prepared, cancelled, pending, published and rejected/failed states from the returned evidence. Include version, identity, registry, attempt ID when present, and validation findings. A zero exit code or an accepted upload alone does not prove publication. Do not invent a release URL; use a returned URL or a documented report link derived from the actual registry and attempt.

Example requests: “Prepare version 1.2.0, but do not upload it.” / “Publish this validated Erden release privately and explain the registry's final verdict.”
