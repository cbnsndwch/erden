# Erden reasoner process protocol V1

This package defines the complete JSON stdin/stdout contract between Erden and the qualified bundled reasoner executable. The wrapped executable is selected only for the closed V1 profile; raw or unwrapped PurRDF remains research evidence and is not selected. `@erden/reasoner-distribution` resolves the exact qualified Windows x64 or Linux x64 glibc package and verifies it before use.

## Wire framing

Erden writes exactly one UTF-8 JSON request followed by one LF to the child process's standard input and then closes stdin. The executable writes exactly one UTF-8 JSON response followed by one LF to stdout. It must write diagnostics to stderr, never stdout. A byte-order mark, a second JSON value, banners, log text, partial JSON, or a missing or extra field makes the exchange invalid and therefore fail closed.

`protocolVersion` is exactly `1`. The request kind is `ReasonerRequest`, the response kind is `ReasonerResponse`, and the only V1 operation is `classify-and-materialize`. The caller pins the profile, tool name and version, executable SHA-256, adapter SHA-256, and calculus SHA-256. The response echoes the request identity and input digest and reports the actual tool identity. Erden must compare every value before trusting a decision.

All object keys use Unicode code-unit lexical order in the compact JSON encoding. Arrays that are semantically unordered are canonicalized: sources and axioms by identifier; equivalent and disjoint operands by canonical expression; output statements by subject, predicate, object, then identifier; premise and diagnostic axiom identifiers lexically; unsatisfiable classes by IRI; and diagnostics by severity, code, message, then axiom identifiers. JSON ends with one LF. The exported encoders produce these bytes and the canonical assertions reject alternate byte layouts even if their decoded JSON value is otherwise valid.

## V1 semantic profile

`erden-required-constructs-v1` is an Erden-specific allowlist and is not an OWL 2 DL conformance claim. Its authoritative descriptor and digest are exported as `ERDEN_REQUIRED_CONSTRUCTS_V1` and `REASONER_PROFILE_SHA256`. Accepted input uses the default graph and named IRI entities. Normalized finite, acyclic unions of named classes are accepted only where the profile says so. Literals have an explicit named datatype and an explicit language value or `null`.

The allowlist covers declarations, named subclass and class assertions, object, data, and annotation property domains and ranges, named-class equivalence and disjointness, inverse and transitive object properties, object, data, and annotation assertions, and the finite union-domain form used by the current demo. Subclass, class assertion, equivalence, and disjointness positions accept `NamedClass` only. `ObjectUnionOf` is accepted only as a property domain, and opaque expressions are never accepted. It deliberately excludes arbitrary OWL 2 DL.

Imports, named graphs or graph ambiguity, unknown reserved RDF, RDFS, or OWL terms, blank or anonymous entity terms outside normalized class expressions, opaque or outside-profile constructs, bottom properties, cyclic expressions, and `owl:Thing` equivalent to `owl:Nothing` in the empty-domain boundary must be refused. The last three categories include known PurRDF divergence cases and may not be waived because a candidate happens to return a result.

Unknown results, semantic-boundary exhaustion, reasoning-budget exhaustion, missing asserted or inferred provenance, a non-`Decided` or unchecked certificate, missing justification or certificate digests, and protocol, tool, profile, input, adapter, or calculus incompatibility are fail-closed outcomes. A refusal or incompatibility is a valid protocol response but never a successful validation result. A decided inconsistent ontology is a complete reasoner decision and remains a validation failure for the caller.

## Provenance and evidence

Every normalized asserted axiom carries a stable axiom identifier, source identifier, source content digest, and locator. `status: "missing"` exists only so a reasoner can return the required structured refusal; it can never participate in a trusted decided response. Decided output separates asserted statements from the inferred delta. Asserted statements point back to their axiom and source. Inferred statements name the rule, sorted premise identifiers, and a checked justification digest.

Every decided response has `completeness: "complete"` and a certificate with `decision: "Decided"`, `checked: true`, engine checker identity, the pinned Erden proof-checker identity and specification digest, canonical input and output digests, calculus digest, certificate digest, and aggregate justification digest. `assertTrustedDecidedResponse` takes caller-owned expected tool pins, cross-references every source, axiom, assertion, premise, and statement identifier, rejects cycles in the inferred-premise graph, structurally verifies each conclusion against the closed V1 proof-rule set, validates disjointness evidence, recomputes individual and aggregate justifications, recomputes the canonical ontology and output digests, and finally recomputes the certificate digest. A self-consistent set of rehashed claims, a syntactically valid SHA-256 string, or `checked: true` is never trusted by itself.

## Known-answer fixtures

`KNOWN_ANSWER_FIXTURES` exports canonical request and response JSON byte strings together with their decoded values. The cases cover subclass and type closure, domain and range, equivalence, disjointness, inverse and transitive properties, inconsistency, unsatisfiable classes, unsupported constructs and known divergence boundaries, and current demo constructs. They are executable-neutral qualification inputs: a future adapter must reproduce the semantic answers and canonical contract without treating the fixture-only tool identity as a selected reasoner.
