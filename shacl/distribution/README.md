# `@erden/shacl-distribution`

Offline-only resolver and doctor probe for `erden-shacl`, Erden's qualified SHACL engine (PurRDF `purrdf-shapes`
3.0.1 behind the `erden.shacl/v1` protocol). It supports exactly the reasoner's platforms: Linux x64 and Linux arm64
with glibc, macOS arm64 and Windows x64. Installation uses exact optional platform dependencies; resolution performs no
downloads, install scripts, network lookup, native addon loading or filesystem writes.

`resolveBundledShaclEngine()` returns the binary's path and its tool identity (name, version, engine digest,
executable digest) only after validating the platform manifest, the qualification metadata, target, version,
regular-file status, size, SHA-256 and, outside Windows, the executable bits, against the anchors the mint wrote.
`inspectBundledShaclEngine({ runSelfTest: true })` adds the committed known-answer request, whose answer bytes and
SHA-256 are pinned per platform.

## On a host that cannot reproduce the pin: the source build

A native macOS or Windows build links with the host's toolchain, so an Xcode or MSVC other than the mint runner's
(`macos-15`, `windows-2025`) produces a binary that works but is not byte-identical to the pin, and
`pnpm run build:shacl` refuses to install it. `pnpm run shacl:build` (`cargo build --release --locked` in `shacl/`)
writes `shacl/target/release/erden-shacl` instead, and `ERDEN_SHACL_BIN` may name the absolute path of such a build;
a relative path is refused.

A source build is opt-in and unqualified. With the variable set, the resolver uses it in place of the platform package,
and holds it to what it answers: a regular, executable file that is not a link, whose known-answer response is
byte-identical to the pinned response once its own SHA-256 stands where the qualified one does. It runs that known
answer on every resolution, answers carry the build's own executable digest, and doctor reports it as the platform
package `source-build`. The variable applies only to this host's own resolution; tests inject a runtime and package
locator, or a source build path.
