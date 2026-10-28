// The engine identity the qualification expects of the 0.3.0 build:
// the adapter and calculus contracts the binary hashes into its adapter and calculus digests, and its version.
export const HORN_ADAPTER_CONTRACT =
    'erden-reasoner-adapter-v1\nprotocol=1\nprofile=erden-required-constructs-v2\nproof-checker=erden-proof-checker-v3\nmax-wire-bytes=134217728\n';
export const HORN_CALCULUS_CONTRACT =
    'purrdf-entail=0.12.0\nsource=https://github.com/Blackcat-Informatics/purrdf\nrev=dfb1df73199668720116dfbc737c0585e23afb5e\nservices=classify-hierarchy,satisfiability-per-signature,consistency-per-data-range\nerden-calculi=v1-closure,horn-saturation\n';
export const HORN_TOOL_VERSION = '0.3.0+purrdf.0.12.0.dfb1df7';
