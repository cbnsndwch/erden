import { createHash } from 'node:crypto';

/** The `erden-shacl` program this release of Erden runs, and the protocol it speaks (`erden.shacl/v1`). */
export const SHACL_ENGINE_NAME = 'erden-shacl' as const;
export const SHACL_ENGINE_VERSION = '0.1.0+purrdf.3.0.1' as const;
export const SHACL_PROTOCOL_VERSION = 1 as const;
/** The largest request or answer line, newline included (`MAX_WIRE_BYTES` in `shacl/erden-shacl/src/lib.rs`). */
export const MAX_SHACL_WIRE_BYTES = 134_217_728 as const;
export const MAX_SHACL_REQUEST_ID_BYTES = 1_024 as const;
export const MAX_SHACL_GRAPHS = 4_096 as const;
/** The SHA-256 of `shacl/Cargo.lock`, named by the engine identity (`CARGO_LOCK_SHA256` in the Rust program). */
export const SHACL_ENGINE_CARGO_LOCK_SHA256 =
    'sha256:4f85d22854b0747423c286fd019533a6caf08a9dc3d4770ddbb637d307713244' as const;

/**
 * The engine identity document, byte for byte the one `erden-shacl` compiles in (`engine_identity_document()`); its
 * SHA-256 is the `engineDigest` every answer carries. A test runs the program and compares.
 */
export const SHACL_ENGINE_IDENTITY_DOCUMENT =
    `{"format":"erden.shacl-engine-identity/v1",` +
    `"tool":{"name":"${SHACL_ENGINE_NAME}","version":"${SHACL_ENGINE_VERSION}"},` +
    `"protocol":"erden.shacl/v${String(SHACL_PROTOCOL_VERSION)}",` +
    `"engine":{"crate":"purrdf-shapes","version":"3.0.1","source":"crates.io",` +
    `"repository":"https://github.com/Blackcat-Informatics/purrdf",` +
    `"commit":"dcd24b1cc56cd7ac24cbe0d38dcf5a89022eaccf","licenseElected":"MIT OR Apache-2.0"},` +
    `"cargoLockSha256":"${SHACL_ENGINE_CARGO_LOCK_SHA256}",` +
    `"semantics":{"input":"n-triples-utf8",` +
    `"shapes":"from_dataset_with_base(no-base,no-prefixes,no-box-roles,request-graph-iri,empty-imports)",` +
    `"validation":"validate_dataset(default-options)",` +
    `"conformanceDisallows":"sh:Violation,sh:Warning,sh:Info",` +
    `"results":"engine-order"}}\n`;

export const SHACL_ENGINE_DIGEST = `sha256:${createHash('sha256').update(SHACL_ENGINE_IDENTITY_DOCUMENT).digest('hex')}`;

/** The identity an answer must carry: the platform-independent engine and the executable that answered. */
export interface ShaclEngineTool {
    readonly name: string;
    readonly version: string;
    readonly engineDigest: string;
    readonly executableDigest: string;
}

/** The tool identity of a resolved executable whose SHA-256 the caller measured. */
export function shaclEngineTool(executableDigest: string): ShaclEngineTool {
    return Object.freeze({
        name: SHACL_ENGINE_NAME,
        version: SHACL_ENGINE_VERSION,
        engineDigest: SHACL_ENGINE_DIGEST,
        executableDigest,
    });
}
