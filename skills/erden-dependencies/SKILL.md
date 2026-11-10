---
name: erden-dependencies
description: Add, install, update or remove shared ontology dependencies in an Erden project while preserving its manifest, version constraints and lockfile. Use when someone wants to reuse a known Erden vocabulary, restore dependencies, “actualiza las dependencias de Erden”, or reproduce a project offline. Do not use for npm or Python dependencies, searching an unspecified global catalog, or publishing a release.
license: Apache-2.0
metadata:
    version: '0.1.0'
---

# Manage Erden dependencies

Requirements: Requires filesystem/terminal access and the Erden CLI. Registry resolution needs network access; offline installation requires previously cached artifacts and a suitable lockfile.

Translate the requested dependency change into the existing CLI operation and explain its effect in the user's language. Do not change unrelated version constraints or prune the shared store as a side effect.

## Select the operation

Inspect the project's actual `erden.config.*`, `erden.lock`, intended registry and existing dependency identities. Use `erden help` or `den help` to confirm the installed interface. If the CLI is missing, report the prerequisite or use `erden-setup` when available; do not install an unrelated npm package.

Read [dependencies.md](references/dependencies.md) for invocation details, identifiers and error handling.

| User intent                                      | Operation                                          |
| ------------------------------------------------ | -------------------------------------------------- |
| Add a known vocabulary and allowed version range | `erden add <identifier>@<range> --json`            |
| Restore dependencies from this project           | `erden install --json`                             |
| Reproduce without changing the locked resolution | `erden install --frozen-lockfile --json`           |
| Restore offline from available artifacts         | `erden install --offline --frozen-lockfile --json` |
| Resolve newer permitted versions                 | `erden update [identifier] --json`                 |
| Remove a dependency                              | `erden remove <identifier> --json`                 |

Run from the intended project directory or use the supported `--config` selection. `install` also takes a project directory; `add`, `remove` and `update` do not take that extra positional argument.

Use an identifier/range present in the request or known project information. If the user asks for an unspecified vocabulary, explain the missing identity and help resolve it through available official discovery information; do not invent `erden search` or guess a package name. Ask about a broader version range only when their requested update requires changing it.

## Apply and verify

Record the relevant manifest and lockfile state before mutation without overwriting existing user edits. Execute the one operation that matches the request, then inspect the actual report and changes. Let Erden own manifest/lock transactions; do not repair them manually to bypass a mismatch.

If offline artifacts are missing, explain which dependency cannot be restored and that online acquisition is needed. Do not switch to network access when the user requested offline operation. If authorization fails, distinguish it from version resolution failure and use the selected registry's login flow when the task calls for it.

After a dependency change, run `erden check --json` when the local runtime is ready; use `--offline` if the required artifacts are present and offline operation is intended. If validation cannot run, report the successful dependency change separately from the unverified model. Do not assert a passed check from a successful install alone.

Report identifiers and resolved versions, changed constraints if any, lockfile status and verification results. Use `store status` or `store path` only when they help diagnose cache problems; actual store pruning requires a cleanup request.

Example requests: “Añade @equipo/proveedores en la serie 1.x a mi proyecto Erden.” / “Restore this Erden project's exact locked dependencies without using the network.”
