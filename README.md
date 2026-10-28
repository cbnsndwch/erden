# Erden

GitHub for ontologies: versioned, proof-checked company knowledge that AI agents can build on.

Open-source local tools for Erden: the `erden`/`den` CLI, registry client, contracts, local checking, package format, reasoner protocol, and both engines. Apache-2.0.

The local tools in this repository are Apache-2.0 (see [LICENSE](/LICENSE)). The hosted Erden registry is closed source and not part of this repository. Publishing, discovery, and the web UI are provided by the hosted service at [erden.sh](https://erden.sh). Self-hosting isn't offered. The name "Erden" is a trademark of cbnsndwch LLC (see [TRADEMARKS.md](/TRADEMARKS.md)).

## What is here

| Path                       | What it is                                                               |
| -------------------------- | ------------------------------------------------------------------------ |
| `apps/cli/`                | the `erden` CLI: `init`, `check`, `install`, `pack`, `publish`, `doctor` |
| `packages/client/`         | registry client: upload, download, reads                                 |
| `packages/contracts/`      | manifest, lockfile, check report and registry wire formats               |
| `packages/project/`        | local project operations: check, install, pack, the package store        |
| `packages/ontology/`       | local assembly, SHACL, competency questions                              |
| `packages/package-format/` | the package archive format                                               |
| `reasoner/`                | the reasoner's Rust source, qualification, protocol and resolver         |
| `shacl/`                   | the `erden-shacl` engine's Rust source, qualification and resolver       |

The engine binaries are never committed. A release ships them inside the CLI archive; a checkout builds them from
source.

## Installing

The first public release is being prepared. Until its archives are published, use the source build below.

Each release has one archive per platform: Linux x64 and arm64 (glibc), macOS arm64 and Windows x64. An archive
holds the `erden` CLI, the Node.js runtime it runs on, and both engines. Each release also has `install.sh`,
`install.ps1` and `SHA256SUMS`. An install script carries its release's archive digests and refuses any other
file. It installs for the current user, with no administrator rights, to `~/.local/share/erden/<version>/` with
`erden` and `den` linked into `~/.local/bin` (Windows: `%LOCALAPPDATA%\Programs\Erden\<version>\`).

```bash
curl -fsSLO https://github.com/cbnsndwch/erden/releases/latest/download/install.sh
sh install.sh
```

On Windows, download `install.ps1` from the same release and run `powershell -ExecutionPolicy Bypass -File install.ps1`.

### Installing without network access

1. On a connected machine, download the install script (`install.sh`, or `install.ps1` on Windows) and the archive for
   the offline machine's platform, both from the same release.
2. Carry both files to the offline machine.
3. Run `sh install.sh --archive erden-<version>-<platform>.tar.gz`. On Windows, run
   `powershell -ExecutionPolicy Bypass -File install.ps1 -Archive erden-<version>-win32-x64.zip`.

The script checks the archive's size and SHA-256 before it extracts anything, and makes no network request. The CLI
makes none either, except to a registry you configure. It also checks each engine binary against its pinned size and
SHA-256 before every use.

## Building from source

Node.js 24 (the exact version is in `.node-version`) and pnpm 10.15.0 (`packageManager`). The engines build in a
pinned Docker builder image on Linux, or with the Rust toolchain each engine's `rust-toolchain.toml` names on macOS and Windows, and
each build is installed only if it is byte-identical to its pin.

```bash
pnpm run bootstrap:workspace
pnpm run reasoner:build:linux   # the reasoner, built twice and compared
pnpm run build:shacl            # erden-shacl, checked against its pin
ERDEN_REASONER_BIN="$PWD/reasoner/source-build/x86_64-unknown-linux-gnu/erden-reasoner" pnpm test
```

These commands are for Linux x64. On Linux arm64, use `aarch64-unknown-linux-gnu` in the executable path.
On macOS arm64 and Windows x64, install the toolchain in `reasoner/rust-toolchain.toml`, build the reasoner
with `pnpm run reasoner:build`, then run `pnpm run build:shacl` and `pnpm test`. The CLI finds that native
reasoner in `reasoner/target/release/` without an environment override.

`pnpm test` runs the workspace gate: the repository guards, formatting, lint, typecheck, the package packs, a packed
CLI install, and every test.

## Contributing and security

Outside contributions are not accepted at this time; issues are welcome (see [CONTRIBUTING.md](/CONTRIBUTING.md)).
Report vulnerabilities privately as [SECURITY.md](/SECURITY.md) describes.
