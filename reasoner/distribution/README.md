# `@erden/reasoner-distribution`

Offline-only resolver and doctor probe for the Erden reasoner. It supports exactly Linux x64 and Linux arm64 with glibc, macOS arm64 and Windows x64. A released version is installed through exact optional platform dependencies; runtime resolution performs no downloads, install scripts, network lookup, native addon loading, or filesystem mutation.

`resolveBundledReasoner()` returns a path only after validating the platform manifest, qualification metadata, target, version, regular-file status, size, SHA-256 digest, and Linux executable bits. `resolveBundledReasonerArtifact()` returns that path with the complete immutable protocol `RequiredTool` identity derived from the validated artifact. `inspectBundledReasoner({ runSelfTest: true })` includes the same identity in structured doctor data and executes a committed protocol known-answer test whose byte count and SHA-256 bind the full canonical proof response.

## Before a release: the source build

Reasoner `0.3.0` is not released yet: its binaries are minted by the tools release workflow (`release.yml`) and published as GitHub Releases, and none is committed here (`REASONER_RELEASED` is `false`, and every pin is `null`). Until then the resolver runs a reasoner built from this repository's source, `pnpm run reasoner:build` (`cargo build --release --locked` in `reasoner/`, with the toolchain `reasoner/rust-toolchain.toml` pins), which writes `reasoner/target/release/erden-reasoner`. `ERDEN_REASONER_BIN` may name another absolute path to such a build; a relative path is refused.

A source build has no pins, so it is held to what it answers: a regular, executable file that is not a link, whose known-answer response is a decided, complete, certificate-checked answer naming this version's profile, proof checker, adapter and calculus digests and the build's own SHA-256. Doctor reports it as the platform package `source-build`. This resolver does not select the `0.2.0` platform packages; the tools release replaces them.

Tests and development may explicitly inject a runtime and package locator, and a source build path. A released version has intentionally no environment-variable path fallback.

npm clean installs prune the incompatible optional platform package. pnpm 10.15.0 may retain both when a clean-install fixture declares local platform tarballs directly; the resolver never treats presence as compatibility and still selects and verifies only the one matching runtime. This local-tarball fixture behavior does not weaken runtime selection.
