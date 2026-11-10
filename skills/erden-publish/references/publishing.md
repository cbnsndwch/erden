# Packaging and publication

## Command contract

```text
erden pack <version> [project-dir] [--config <file>] [--output <file>] [--json]
erden publish <version> [project-dir] [--config <file>] [--output <file>] [--create [--visibility public|private] [--yes]] [--no-wait] [--json]
erden publication <attempt-id> [--registry <origin>] [--wait] [--report] [--json]
erden login [--registry <origin>]
```

Use the exact requested version supported by the CLI. Project-directory and explicit-manifest selection should identify the same intended project; choose one method. `publish` uses the manifest's registry and does not advertise a `--registry` override. `publication` and `login` resolve an explicit registry, then the nearest manifest registry, then `https://registry.erden.sh` when none is specified. They do not fall back past an invalid or unreadable manifest; `publish` still requires its selected manifest registry.

There is no general publish `--dry-run` flag. A local `check` plus `pack` is the preparation workflow; neither proves that the registry will accept the result.

## Creation and visibility

Publishing to an existing project does not need `--create`. For creation in a noninteractive process, the CLI requires both explicit visibility and `--yes`. The interactive code defaults creation to private, but a skill should carry the user's actual visibility choice rather than depend on an unseen prompt.

Do not create a new project as a workaround for lack of access to an existing one. Resolve authorization or explain the limitation.

## Artifacts and retries

`pack` snapshots and encodes the project; `publish` also invokes packing before upload. An explicit output must end in `.erdenpkg`; `.tgz` is rejected. Prefer an absolute path to a new artifact. If preparing a separate archive and then publishing, avoid accidentally reusing an output path whose overwrite behavior has not been established. Validate the final source state; a changed project is a different candidate.

The CLI computes an idempotency key from registry, project identity, version, archive identity and creation mode. Preserve those inputs and the attempt ID when inspecting a pending result. Do not change the version just to retry a transport error. If upload outcome is unknown and there is no attempt ID, report that uncertainty before any retry that could change publication identity.

## Status and reporting

`publish` now waits by default for up to two hours; `--json` suppresses progress output. Use `--no-wait --json` for an agent-controlled upload-then-poll workflow. A default publish wait that times out returns the last attempt JSON and exit 3; retain the attempt ID and check its status instead of uploading again. This two-hour publish wait is distinct from the five-minute `publication --wait` limit.

Prefer `publication <attempt-id> --wait --report --json` for a requested final verdict, within a bounded tool execution. The CLI's wait is bounded to five minutes; use asynchronous execution or shorter non-waiting status reads so the user can still receive progress updates. A non-waiting query can return a still-pending attempt. Interpret the returned `state`, `failure`, report `outcome` and validation stages; do not infer success from the existence of an attempt.

The current attempt states are `queued`, `validating`, `succeeded` and `failed`. The first two are pending; `succeeded` is the positive terminal state, and `failed` requires reading its failure/report. An accepted pending attempt can have exit 0 with `publish --no-wait` or a non-waiting status read, as can a succeeded attempt. Interactive cancellation can also return exit 0 without an attempt.

The documented report-page route is `<registry-origin>/publications/<URL-encoded-attempt-id>/report`. It is members-only, so a report URL is not proof that the release is publicly visible. Only construct it from an observed attempt ID and actual origin.

Device login is interactive user authorization, even when started by an agent. Login takes no `--json` flag. Missing access, an expired login and a semantic registry rejection require different remedies.
