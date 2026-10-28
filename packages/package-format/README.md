# `@erden/package-format` V1 codec and fixture contract

This package contains the production package-format V1 `PackageCodec` and the original executable interoperability oracle. Production encoding accepts exact logical paths, bytes, and executable flags, snapshots caller-owned input, and emits the same deterministic bytes as the oracle. Production validation and extraction consume bounded byte streams without materializing the decompressed TAR archive.

The codec does not resolve dependencies, write a lockfile, manage a content-addressed package store, or inspect a filesystem project. The application-layer `PackProject` operation now snapshots a project, applies the shared ignore evaluator, authenticates its lock/toolchain, and supplies exact logical records to this codec; the codec remains independent of CLI and filesystem policy.

The exported ignore evaluator is also the executable fixture oracle's evaluator. `.erdenignore` takes precedence over `.gitignore`, while `.git/**`, `.erden/**`, both ignore-control files, and the generated package manifest are always excluded. Callers provide snapshotted UTF-8 control bytes and remain responsible for safely traversing or rejecting physical filesystem entries.

## Archive and manifest

- Every entry is rooted below `package/`; the generated manifest is `package/.erden/package-manifest.json`.
- The manifest records a nonempty canonical absolute package IRI and exact semantic version, exact resolved dependency IRIs and semantic versions, coherent requested semantic-version ranges, archive SHA-256 digests, exact validator and reasoner semantic versions and SHA-256 digests, and each shipped file's relative path, byte size, SHA-256 digest, and logical executable flag. Self-dependencies and repeated canonical dependency identities are invalid.
- The generated manifest does not list or hash itself. The SHA-256 of the complete gzip archive is stored by publication metadata and `erden.lock`, outside the archive, so the format has no recursive self-digest.
- V1 readers accept exactly `formatVersion: 1`; both older and newer values fail closed.

## Portable paths and selection

- Source separators are converted to `/` and paths are normalized to Unicode NFC before sorting or archiving.
- Empty, absolute, drive-prefixed, UNC, traversal, dot-segment, empty-segment, invalid-Unicode, Windows-reserved, control-character, trailing-dot, trailing-space, excessive-depth, and excessive-byte-length paths are rejected. Windows device basenames include the ordinary COM/LPT digits and the Windows-recognized superscript `¹`, `²`, and `³` variants.
- Exact duplicates, Unicode-equivalent names, deterministic Unicode ordinal-insensitive names such as `Σ`/`ς`, and a file colliding with a descendant path are rejected before bytes are emitted or accepted.
- `.erdenignore` is authoritative when present; otherwise `.gitignore` is used. Files are UTF-8, CRLF is normalized, blank and comment lines are ignored, `!` negates, leading `/` anchors, trailing `/` selects directories, `*`, `?`, and `**` are supported, and the last matching rule wins. A child cannot be re-included while an ancestor remains ignored.
- `.erdenignore`, `.gitignore`, `.git/**`, and `.erden/**` are never shipped. V1 fixtures reject symlinks, hardlinks, devices, and FIFOs. Executability is supplied as logical input, never inferred from a host filesystem.

## Deterministic bytes

- Entries use UTF-8 bytewise lexical order. Dependencies use canonical IRI, version, then requested constraint in the same ordering.
- Tar is strict USTAR with no GNU or PAX extensions. Directories are mode `0755`; regular files use type `0` and mode `0644` or `0755`; uid, gid, mtime, device numbers, uname, and gname are zero or empty; link names, unused header bytes, and padding are zero; name/prefix splitting and octal/checksum fields use the encoder's one canonical representation; and exactly two zero blocks terminate the archive.
- Gzip uses one member, a fixed header with mtime zero and OS `255`, byte-aligned stored DEFLATE blocks, a CRC-32 footer, and ISIZE. The reference encoder therefore produces identical bytes without depending on host zlib output.

## Production validation and extraction

The production validator enforces at most 10,000 entries, 64 MiB per regular file, 512 MiB decompressed TAR bytes, 513 MiB compressed bytes, a 200:1 expansion ratio, 32 relative path segments, and 240 UTF-8 path bytes. Limits are copied and validated before the source is read. It accepts exactly one fixed-profile stored-DEFLATE gzip member and incrementally validates gzip CRC/ISIZE, strict USTAR headers, the two-block terminator, canonical manifest bytes, exact directory closure, and every declared byte size, logical mode, and SHA-256 digest before returning a frozen result. The result binds the complete compressed archive SHA-256, canonical generated-manifest SHA-256, and every file's size, mode, and SHA-256; V1 defines no additional provenance digest.

Filesystem extraction streams into an invocation-owned, same-parent transaction area. It rejects symbolic or reparse ancestors and existing exact, case-folded, or NFC-equivalent destinations. Only after the full archive and EOF are trusted does it reserve the destination, install identity-bound support files, revalidate the exact tree, and move the generated manifest last as the publication point. Effect interruption observed before that final rename rolls back; interruption racing within the one atomic rename may leave either no package or one completely valid package, never a partially published package. Failed cleanup is nonrecursive and removes only files and directories whose captured filesystem identity and content still match; uncertainty returns a typed failure and may preserve inert destination, staging, or manifest-temporary residue, but no destination is installable without its generated manifest.

On POSIX filesystems the extractor explicitly applies and verifies exact `0755` directories plus each authenticated `0644`/`0755` file mode, including rejection of setuid, setgid, and sticky bits, independent of process umask. Windows extraction preserves and reports those authenticated logical modes but does not claim NTFS physically represents POSIX execute bits; Node projects them as platform modes such as `0666`.

As with `InitProject`, V1 assumes an injected filesystem operation does not replace the object it just created before that single operation returns. Once the extractor captures the returned file or directory identity, every observable substitution is detected and fails closed. Eliminating the syscall-return seam itself would require stronger native handle-relative primitives than Node exposes portably.

## Reference oracle

`encodeReferencePackageFixture` and `validateReferenceArchiveFixture` remain the bounded, in-memory conformance oracle and malicious-fixture builder. Production tests require byte and decision parity with that oracle; application code should use `PackageCodec`, `encodePackage`, `validatePackageArchive`, or `extractPackageArchive`.
