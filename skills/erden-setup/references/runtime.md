# Runtime and installation

## Diagnose the actual executable

On POSIX shells, use `command -v erden` and `command -v den`. On PowerShell, use `Get-Command erden, den -ErrorAction SilentlyContinue`. Run the executable you found; use `den` consistently if that is the available alias.

```text
erden help
erden --version
erden doctor --json
```

`doctor` succeeds with exit 0 when its inspected components pass and uses exit 1 for a failed readiness report. Usage errors use exit 2 and operational failures use exit 3. Read stderr even when no JSON was produced.

| Evidence                         | Interpretation and next step                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CLI absent                       | Verify the installation location and PATH, then install if setup was requested                                                     |
| `node.status: failed`            | Compare the CLI's actual `runtimeVersion` with `requiredVersion`; select the required source runtime or repair the bundled release |
| `SOURCE_BUILD_MISSING`           | Build the reasoner from the same source checkout using its documented workflow                                                     |
| Engine `BINARY_MISSING`          | Install/build that engine in the location its resolver expects; `target/release/` alone may not suffice                            |
| Digest/size verification failure | Reacquire the matching trusted artifact or reproduce the pinned build; never change the expected digest                            |
| Unsupported platform             | Report the supported targets of that release; do not use a binary for another architecture                                         |
| Engine self-test failure         | Preserve the failure code, investigate the selected build/runtime and rerun after a correction                                     |

## Release distribution

Resolve the official release through the project's current README/release links. This source tree documents `https://github.com/cbnsndwch/erden/releases`, but a release must actually exist before using it; do not infer availability from this reference.

The documented archive targets are Linux x64/arm64 with glibc, macOS arm64 and Windows x64. Verify the selected release's actual assets. Archives contain the CLI, Node and both engines. Installer scripts and archives must come from the same release; its installers verify the archive's size and SHA-256.

POSIX: download that release's `install.sh` to a task-local file, inspect it, then run `sh install.sh`. For an already obtained matching archive, use `sh install.sh --archive <archive-path>`. Windows: use that release's `install.ps1`; its offline argument is `-Archive <archive-path>`.

Default user-local install locations documented by this checkout are `~/.local/share/erden/<version>/`, with commands in `~/.local/bin`, and `%LOCALAPPDATA%\Programs\Erden\<version>\` on Windows. Resolve the real installed path before updating PATH. Use a process-local PATH change to verify the fix before making any persistent change requested by the user. No administrator rights are required by the documented installers.

Do not use `npm install -g erden` or assume `@erden/cli` is published to npm; the CLI package in this checkout is private.

## Source checkout

Operate from the actual Erden repository root. Read current files first: `.node-version`, `package.json`, `reasoner/rust-toolchain.toml` and `shacl/rust-toolchain.toml`. This skill was authored against a tree pinning Node 24.17.0 and pnpm 10.15.0; the checkout's files remain authoritative.

Check whether the required versions already exist in a version manager. A missing `rustup` in PATH does not prove Rust is uninstalled. Use the selected Node for pnpm and for the CLI so that `doctor` sees the intended runtime.

```bash
pnpm run bootstrap:workspace
pnpm run build:runtime
```

Build missing engines using the repository workflow:

- macOS arm64 / Windows x64: `pnpm run reasoner:build`, then `pnpm run build:shacl`, with the pinned Rust toolchains available.
- Linux x64 / arm64: `pnpm run reasoner:build:linux`, then `pnpm run build:shacl`, using the documented pinned Docker builder. Set `ERDEN_REASONER_BIN` to the absolute generated binary under `reasoner/source-build/<target>/erden-reasoner`, where `<target>` is `x86_64-unknown-linux-gnu` or `aarch64-unknown-linux-gnu`.

The SHACL build script installs only a byte-identical pinned result into its platform package. Simply building `shacl/target/release/erden-shacl` does not perform that installation. Do not invent an `ERDEN_SHACL_BIN` override.

After builds, use the selected Node runtime:

```bash
node apps/cli/dist/bin.js doctor --json
node apps/cli/dist/bin.js check examples/erden-demo --offline --json
```

Use `node <absolute-checkout>/apps/cli/dist/bin.js` as the command prefix for other source-checkout operations. It preserves the user's project working directory. Rebuild runtime packages after source changes; stale `dist/` files can describe behavior that no longer matches the source.

## Project and registry readiness

Supported manifest names are `erden.config.json`, `.jsonc`, `.yml`, `.yaml` and `.toml`. Inspect the existing manifest instead of adding a second one. `registry` is an HTTP(S) origin, not an API path; preserve a known origin and do not guess it from a package name.

Local offline checks require dependency artifacts already installed. `erden install --offline --frozen-lockfile --json` is a local installation operation, not a pure readiness probe; run it when restoration was requested, not during a check-only task.

Query, publication-status reads, login and logout resolve `--registry <origin>` first, then the nearest manifest registry, then the built-in `https://registry.erden.sh` when no registry is named. An invalid or unreadable manifest is an error, not a reason to switch origins. Publishing itself still requires a registry in its selected project manifest. Login has no JSON flag. Public remote reads may work without authentication; expired stored credentials can still require login. Let the actual operation determine whether access works.

Never publish or prune the store to test readiness. `erden store path --json` and `erden store status --json` provide non-destructive location/status information when relevant.
