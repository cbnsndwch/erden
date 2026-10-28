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

There is no environment-variable path fallback; tests inject a runtime and package locator.
