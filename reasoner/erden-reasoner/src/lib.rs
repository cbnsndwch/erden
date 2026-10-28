use purrdf_core::{BlankScope, RdfDataset, RdfDatasetBuilder, RdfLiteral, TermValue};
use purrdf_entail::{DlCompleteness, Reasoner, Verdict};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::sync::Arc;
use std::time::Instant;

/// Per-phase wall time on stderr, compiled only with the `phase-timing` feature.
///
/// With the feature off the macro expands to nothing, so a release build is byte-identical to
/// one without it. The timing gate (`reasoner/qualification/timing.test.ts`) reads these lines.
#[cfg(feature = "phase-timing")]
mod phase_timing {
    use std::sync::{Mutex, PoisonError};
    use std::time::Instant;

    static LAST: Mutex<Option<Instant>> = Mutex::new(None);

    pub fn mark(phase: &str) {
        let now = Instant::now();
        let mut last = LAST.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(previous) = *last {
            eprintln!(
                "erden-reasoner phase {phase} {:.3} ms",
                now.duration_since(previous).as_secs_f64() * 1000.0
            );
        }
        *last = Some(now);
    }
}

macro_rules! phase {
    ($name:literal) => {
        #[cfg(feature = "phase-timing")]
        crate::phase_timing::mark($name);
    };
}

mod engine;
mod horn;

const PROTOCOL_VERSION: u64 = 1;
const OPERATION: &str = "classify-and-materialize";
const PROFILE_ID: &str = "erden-required-constructs-v2";
const PROFILE_DIGEST: &str =
    "sha256:ff36438e2500497ed8dc8b955cf7033c9bed781495c214793c0ba6859bbede5f";
const PROOF_CHECKER_ID: &str = "erden-proof-checker-v3";
const PROOF_CHECKER_DIGEST: &str =
    "sha256:945ef6fb5e692112780308adccbb02695ef6a83183af6416284642ed475dee44";
const TOOL_NAME: &str = "erden-reasoner";
const TOOL_VERSION: &str = "0.3.0+purrdf.0.12.0.dfb1df7";
const PURRDF_COMMIT: &str = "dfb1df73199668720116dfbc737c0585e23afb5e";
const ADAPTER_CONTRACT: &str = "erden-reasoner-adapter-v1\nprotocol=1\nprofile=erden-required-constructs-v2\nproof-checker=erden-proof-checker-v3\nmax-wire-bytes=134217728\n";
const CALCULUS_CONTRACT: &str = "purrdf-entail=0.12.0\nsource=https://github.com/Blackcat-Informatics/purrdf\nrev=dfb1df73199668720116dfbc737c0585e23afb5e\nservices=classify-hierarchy,satisfiability-per-signature,consistency-per-data-range\nerden-calculi=v1-closure,horn-saturation\n";
/// The hard ceiling for one request or response, 128 MiB; deployments set a lower request ceiling.
pub const MAX_WIRE_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_WORKER_STDOUT_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_REASONER_REQUEST_ID_BYTES: usize = 1024;

const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDF_FIRST: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
const RDF_REST: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
const RDF_NIL: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";
const RDFS_SUBCLASS: &str = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDFS_DOMAIN: &str = "http://www.w3.org/2000/01/rdf-schema#domain";
const RDFS_RANGE: &str = "http://www.w3.org/2000/01/rdf-schema#range";
const OWL_EQUIVALENT: &str = "http://www.w3.org/2002/07/owl#equivalentClass";
const OWL_DISJOINT: &str = "http://www.w3.org/2002/07/owl#disjointWith";
const OWL_INVERSE: &str = "http://www.w3.org/2002/07/owl#inverseOf";
const OWL_TRANSITIVE: &str = "http://www.w3.org/2002/07/owl#TransitiveProperty";
const OWL_UNION: &str = "http://www.w3.org/2002/07/owl#unionOf";
const OWL_THING: &str = "http://www.w3.org/2002/07/owl#Thing";
const OWL_NOTHING: &str = "http://www.w3.org/2002/07/owl#Nothing";
const OWL_BOTTOM_OBJECT: &str = "http://www.w3.org/2002/07/owl#bottomObjectProperty";
const OWL_BOTTOM_DATA: &str = "http://www.w3.org/2002/07/owl#bottomDataProperty";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u64,
    kind: String,
    request_id: String,
    operation: String,
    profile: Profile,
    required_tool: Tool,
    limits: Limits,
    ontology: Ontology,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    id: String,
    digest: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tool {
    name: String,
    version: String,
    executable_digest: String,
    adapter_digest: String,
    calculus_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Limits {
    max_input_axioms: u64,
    max_inferences: u64,
    max_wall_time_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ontology {
    digest: String,
    sources: Vec<Value>,
    axioms: Vec<Value>,
}

#[derive(Clone, Debug)]
struct Fact {
    subject: String,
    predicate: String,
    object: Value,
    premise_id: String,
}

#[derive(Clone, Debug)]
struct Candidate {
    key: String,
    /// The candidate's sort key (`candidate_key_parts` in UTF-16), so comparing two is a slice
    /// comparison instead of rebuilding and re-encoding both keys every time.
    order: Box<[u16]>,
    subject: String,
    predicate: String,
    object: Value,
    rule: &'static str,
    premises: Vec<String>,
}

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Candidate {}
impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> Ordering {
        cmp_candidate(self, other)
    }
}

#[derive(Clone, Debug)]
struct Diagnostic {
    code: &'static str,
    message: String,
    axiom_ids: Vec<String>,
}

#[derive(Clone, Debug)]
struct Refusal {
    reason: &'static str,
    diagnostics: Vec<Diagnostic>,
}

fn cmp_diagnostic(left: &Diagnostic, right: &Diagnostic) -> Ordering {
    cmp_utf16_parts(&diagnostic_key_parts(left), &diagnostic_key_parts(right))
}

fn diagnostic_key_parts(diagnostic: &Diagnostic) -> Vec<&str> {
    // Rust only emits error diagnostics. Keep the constant severity because it is the first
    // field in canonical.ts diagnosticKey, even though it cannot distinguish two local values.
    let mut parts = Vec::with_capacity(5 + diagnostic.axiom_ids.len() * 2);
    parts.extend(["error", "\0", diagnostic.code, "\0", &diagnostic.message]);
    for axiom_id in &diagnostic.axiom_ids {
        parts.extend(["\0", axiom_id]);
    }
    parts
}

/// Answers one request. The process exits right after writing the answer, so the parsed
/// request is not taken apart: freeing a large one would cost time and change nothing.
pub fn run(input: &[u8]) -> Result<Vec<u8>, String> {
    phase!("start");
    let parsed = parse_request(input)?;
    phase!("parse");
    let answer = run_request(&parsed);
    std::mem::forget(parsed);
    answer
}

/// The request's wall-time budget, which both processes need before anything else.
///
/// Every valid request is canonical JSON whose sorted keys put `kind` and `limits` first, so the
/// budget is read from that prefix without parsing the rest. Anything else is parsed in full,
/// which either finds the budget or names what is wrong with the request.
pub fn wall_time_limit_ms(input: &[u8]) -> Result<u64, String> {
    match canonical_prefix_wall_time_ms(input) {
        Some(limit) => Ok(limit),
        None => Ok(parse_request(input)?.request.limits.max_wall_time_ms),
    }
}

fn canonical_prefix_wall_time_ms(input: &[u8]) -> Option<u64> {
    let rest = input.strip_prefix(br#"{"kind":"ReasonerRequest","limits":{"maxInferences":"#)?;
    let (_, rest) = canonical_integer(rest)?;
    let rest = rest.strip_prefix(br#","maxInputAxioms":"#)?;
    let (_, rest) = canonical_integer(rest)?;
    let rest = rest.strip_prefix(br#","maxWallTimeMs":"#)?;
    let (limit, rest) = canonical_integer(rest)?;
    rest.starts_with(br#"},"ontology":{"#).then_some(limit)
}

/// A canonical JSON non-negative integer (`0`, or no leading zero) that fits in `u64`.
fn canonical_integer(input: &[u8]) -> Option<(u64, &[u8])> {
    let length = input
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if length == 0 || (length > 1 && input[0] == b'0') {
        return None;
    }
    let value = std::str::from_utf8(&input[..length]).ok()?.parse().ok()?;
    Some((value, &input[length..]))
}

/// A refusal for a containment event the supervisor observed (deadline, output, worker failure).
///
/// Only reached when the worker produced no answer, so this is the request's only full parse
/// on that path.
pub fn supervisor_refusal(
    input: &[u8],
    code: &'static str,
    message: impl Into<String>,
) -> Result<Vec<u8>, String> {
    let parsed = parse_request(input)?;
    let tool = actual_tool()?;
    let result = refused_value(engine_refusal("budget-exhausted", code, message.into()));
    Ok(canonical_bytes(&response_value(
        &parsed.request,
        &tool,
        result,
    )))
}

/// The framing every public answer must have: within the hard ceiling, one line, LF-terminated.
///
/// Its canonical JSON form is checked once, by its one consumer, the TypeScript adapter.
pub fn check_output_framing(output: &[u8]) -> Result<(), String> {
    if output.len() > MAX_WORKER_STDOUT_BYTES {
        return Err(format!(
            "worker response exceeds {MAX_WORKER_STDOUT_BYTES} byte wire limit"
        ));
    }
    if !output.ends_with(b"\n")
        || output.ends_with(b"\r\n")
        || output[..output.len().saturating_sub(1)].contains(&b'\n')
    {
        return Err("worker response must be exactly one LF-terminated JSON value".into());
    }
    Ok(())
}

/// The framing of [`check_output_framing`] plus canonical JSON, for tests and qualification.
pub fn validate_worker_output(output: &[u8]) -> Result<(), String> {
    check_output_framing(output)?;
    let value: Value = serde_json::from_slice(output)
        .map_err(|error| format!("invalid worker response JSON: {error}"))?;
    if canonical_bytes(&value) != output {
        return Err("worker response is not canonical JSON".into());
    }
    Ok(())
}

/// The request as the wire carries it: every envelope field typed, and the two ontology arrays
/// borrowed as the exact bytes the input digest covers.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRequest<'a> {
    protocol_version: u64,
    kind: String,
    request_id: String,
    operation: String,
    profile: Profile,
    required_tool: Tool,
    limits: Limits,
    #[serde(borrow)]
    ontology: WireOntology<'a>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireOntology<'a> {
    digest: String,
    #[serde(borrow)]
    sources: &'a RawValue,
    #[serde(borrow)]
    axioms: &'a RawValue,
}

/// A parsed request and the digest of the ontology it carries, computed once from its bytes.
struct Parsed {
    request: Request,
    input_digest: String,
}

fn parse_request(input: &[u8]) -> Result<Parsed, String> {
    if input.len() > MAX_WIRE_BYTES {
        return Err(format!("request exceeds {MAX_WIRE_BYTES} byte wire limit"));
    }
    if !input.ends_with(b"\n")
        || input.ends_with(b"\r\n")
        || input[..input.len().saturating_sub(1)].contains(&b'\n')
    {
        return Err("request must be exactly one LF-terminated JSON value".into());
    }
    let text = std::str::from_utf8(input).map_err(|_| "request is not UTF-8")?;
    let wire: WireRequest<'_> = serde_json::from_str(&text[..text.len() - 1])
        .map_err(|error| format!("invalid request envelope: {error}"))?;
    if !canonical_envelope(input, &wire) {
        return Err("request is not canonical JSON".into());
    }
    let sources: Vec<Value> = serde_json::from_str(wire.ontology.sources.get())
        .map_err(|error| format!("invalid request envelope: {error}"))?;
    let axioms: Vec<Value> = serde_json::from_str(wire.ontology.axioms.get())
        .map_err(|error| format!("invalid request envelope: {error}"))?;
    let input_digest = raw_input_digest(&wire.ontology);
    // The digest covers the two arrays byte for byte. A request whose arrays hash to the digest it
    // claims carries the bytes its writer hashed, so their canonical form is not encoded again; a
    // mismatch is examined in full here, to refuse a non-canonical request as such.
    if input_digest != wire.ontology.digest
        && (!canonical_raw(wire.ontology.sources.get(), &sources)
            || !canonical_raw(wire.ontology.axioms.get(), &axioms))
    {
        return Err("request is not canonical JSON".into());
    }
    let request = Request {
        protocol_version: wire.protocol_version,
        kind: wire.kind,
        request_id: wire.request_id,
        operation: wire.operation,
        profile: wire.profile,
        required_tool: wire.required_tool,
        limits: wire.limits,
        ontology: Ontology {
            digest: wire.ontology.digest,
            sources,
            axioms,
        },
    };
    validate_envelope(&request)?;
    validate_semantic_order(&request)?;
    Ok(Parsed {
        request,
        input_digest,
    })
}

/// Whether everything around the two ontology arrays is exactly the canonical encoding of the
/// envelope: sorted keys, no whitespace, canonical strings and numbers, one trailing LF.
fn canonical_envelope(input: &[u8], wire: &WireRequest<'_>) -> bool {
    let quoted = |value: &str| serde_json::to_string(value).expect("strings serialize as JSON");
    let prefix = format!(
        "{{\"kind\":{},\"limits\":{{\"maxInferences\":{},\"maxInputAxioms\":{},\"maxWallTimeMs\":{}}},\"ontology\":{{\"axioms\":",
        quoted(&wire.kind),
        wire.limits.max_inferences,
        wire.limits.max_input_axioms,
        wire.limits.max_wall_time_ms
    );
    let middle = format!(",\"digest\":{},\"sources\":", quoted(&wire.ontology.digest));
    let tool = &wire.required_tool;
    let suffix = format!(
        "}},\"operation\":{},\"profile\":{{\"digest\":{},\"id\":{}}},\"protocolVersion\":{},\"requestId\":{},\"requiredTool\":{{\"adapterDigest\":{},\"calculusDigest\":{},\"executableDigest\":{},\"name\":{},\"version\":{}}}}}\n",
        quoted(&wire.operation),
        quoted(&wire.profile.digest),
        quoted(&wire.profile.id),
        wire.protocol_version,
        quoted(&wire.request_id),
        quoted(&tool.adapter_digest),
        quoted(&tool.calculus_digest),
        quoted(&tool.executable_digest),
        quoted(&tool.name),
        quoted(&tool.version)
    );
    let axioms = wire.ontology.axioms.get().as_bytes();
    let sources = wire.ontology.sources.get().as_bytes();
    let (Some(axioms_at), Some(sources_at)) = (offset_in(input, axioms), offset_in(input, sources))
    else {
        return false;
    };
    let axioms_end = axioms_at + axioms.len();
    let sources_end = sources_at + sources.len();
    axioms_end <= sources_at
        && input[..axioms_at] == *prefix.as_bytes()
        && input[axioms_end..sources_at] == *middle.as_bytes()
        && input[sources_end..] == *suffix.as_bytes()
}

/// Where `part`, a slice borrowed from `whole`, begins in it.
fn offset_in(whole: &[u8], part: &[u8]) -> Option<usize> {
    let start = (part.as_ptr() as usize).checked_sub(whole.as_ptr() as usize)?;
    (start + part.len() <= whole.len()).then_some(start)
}

fn canonical_raw(raw: &str, value: &[Value]) -> bool {
    serde_json::to_vec(value).expect("JSON values serialize") == raw.as_bytes()
}

/// The input digest, `sha256` of the canonical `{"axioms":…,"sources":…}` document and its LF,
/// hashed straight from the request's own bytes for the two arrays.
fn raw_input_digest(ontology: &WireOntology<'_>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"{\"axioms\":");
    hasher.update(ontology.axioms.get().as_bytes());
    hasher.update(b",\"sources\":");
    hasher.update(ontology.sources.get().as_bytes());
    hasher.update(b"}\n");
    format!("sha256:{:x}", hasher.finalize())
}

fn run_request(parsed: &Parsed) -> Result<Vec<u8>, String> {
    let request = &parsed.request;
    let tool = actual_tool()?;
    if let Some(response) = incompatibility_response(request, &tool) {
        return Ok(canonical_bytes(&response));
    }
    if request.ontology.digest != parsed.input_digest {
        return Ok(canonical_bytes(&incompatible(
            request,
            &tool,
            "input-digest",
            &parsed.input_digest,
            &request.ontology.digest,
        )));
    }

    phase!("digest");
    let started = Instant::now();
    let bytes = match preflight(request) {
        Ok(used) => {
            phase!("preflight");
            match decide(request, started, &used) {
                Ok(evidence) => encode_decided(request, &tool, evidence),
                Err(refusal) => {
                    canonical_bytes(&response_value(request, &tool, refused_value(refusal)))
                }
            }
        }
        Err(refusal) => canonical_bytes(&response_value(request, &tool, refused_value(refusal))),
    };
    phase!("serialize");
    Ok(bytes)
}

pub fn actual_tool() -> Result<Tool, String> {
    debug_assert!(CALCULUS_CONTRACT.contains(PURRDF_COMMIT));
    let executable =
        std::env::current_exe().map_err(|error| format!("resolve executable: {error}"))?;
    let bytes = fs::read(&executable)
        .map_err(|error| format!("hash executable {}: {error}", executable.display()))?;
    Ok(Tool {
        name: TOOL_NAME.into(),
        version: TOOL_VERSION.into(),
        executable_digest: sha256_bytes(&bytes),
        adapter_digest: sha256_bytes(ADAPTER_CONTRACT.as_bytes()),
        calculus_digest: sha256_bytes(CALCULUS_CONTRACT.as_bytes()),
    })
}

fn validate_envelope(request: &Request) -> Result<(), String> {
    if request.kind != "ReasonerRequest" {
        return Err("kind must be ReasonerRequest".into());
    }
    if request.request_id.is_empty()
        || request.request_id.len() > MAX_REASONER_REQUEST_ID_BYTES
        || !is_identifier(&request.request_id)
    {
        return Err(format!(
            "requestId must be a V1 ASCII identifier of at most {MAX_REASONER_REQUEST_ID_BYTES} bytes"
        ));
    }
    if request.operation != OPERATION {
        return Err("operation is not a V1 operation".into());
    }
    if request.limits.max_input_axioms == 0
        || request.limits.max_inferences == 0
        || request.limits.max_wall_time_ms == 0
    {
        return Err("reasoning limits must be positive integers".into());
    }
    if request.ontology.sources.is_empty() {
        return Err("ontology.sources must be non-empty".into());
    }
    if !is_digest(&request.ontology.digest) {
        return Err("ontology.digest is not SHA-256".into());
    }
    Ok(())
}

fn validate_semantic_order(request: &Request) -> Result<(), String> {
    let source_ids: Vec<&str> = request
        .ontology
        .sources
        .iter()
        .map(|v| string(v, "id"))
        .collect::<Result<_, _>>()?;
    let axiom_ids: Vec<&str> = request
        .ontology
        .axioms
        .iter()
        .map(|v| string(v, "id"))
        .collect::<Result<_, _>>()?;
    strictly_sorted_unique(&source_ids, "ontology.sources")?;
    strictly_sorted_unique(&axiom_ids, "ontology.axioms")?;
    for axiom in &request.ontology.axioms {
        match string(axiom, "kind")? {
            "EquivalentClasses" | "DisjointClasses" => {
                let classes = array(axiom, "classes")?;
                if classes.len() < 2 {
                    return Err("class lists need two entries".into());
                }
                for class in classes {
                    validate_union_order(class)?;
                }
                let enc: Vec<String> = classes
                    .iter()
                    .map(class_expression_key)
                    .collect::<Result<_, _>>()?;
                strictly_sorted_unique(
                    &enc.iter().map(String::as_str).collect::<Vec<_>>(),
                    "class list",
                )?;
            }
            "PropertyDomain" => {
                if let Some(domain) = axiom.get("domain") {
                    validate_union_order(domain)?;
                }
            }
            "PropertyRange" => {
                if let Some(range) = axiom.get("range").filter(|range| range.is_object()) {
                    validate_union_order(range)?;
                }
            }
            "SubClassOf" => {
                validate_union_order(field(axiom, "subClass")?)?;
                validate_union_order(field(axiom, "superClass")?)?;
            }
            "ClassAssertion" => validate_union_order(field(axiom, "classExpression")?)?,
            "EquivalentObjectProperties" => {
                let keys: Vec<String> = array(axiom, "properties")?
                    .iter()
                    .map(property_expression_key)
                    .collect::<Result<_, _>>()?;
                strictly_sorted_unique(
                    &keys.iter().map(String::as_str).collect::<Vec<_>>(),
                    "EquivalentObjectProperties.properties",
                )?;
            }
            "EquivalentDataProperties" => {
                let properties: Vec<&str> = array(axiom, "properties")?
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .ok_or_else(|| "data property must be an IRI".to_owned())
                    })
                    .collect::<Result<_, _>>()?;
                strictly_sorted_unique(&properties, "EquivalentDataProperties.properties")?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Checks the canonical order inside a class expression, at every depth: the operands of a union
/// (IRIs) and of an intersection (by `class_expression_key`) strictly sorted and unique.
fn validate_union_order(expression: &Value) -> Result<(), String> {
    match expression.get("kind").and_then(Value::as_str) {
        Some("ObjectUnionOf") => {
            let operands = array(expression, "operands")?;
            if operands.len() < 2 {
                return Err("ObjectUnionOf needs two operands".into());
            }
            let values: Vec<&str> = operands
                .iter()
                .map(|v| {
                    v.as_str()
                        .ok_or_else(|| "union operand must be an IRI".to_owned())
                })
                .collect::<Result<_, _>>()?;
            strictly_sorted_unique(&values, "ObjectUnionOf.operands")?;
        }
        Some("ObjectIntersectionOf") => {
            let operands = array(expression, "operands")?;
            if operands.len() < 2 {
                return Err("ObjectIntersectionOf needs two operands".into());
            }
            for operand in operands {
                validate_union_order(operand)?;
            }
            let keys: Vec<String> = operands
                .iter()
                .map(class_expression_key)
                .collect::<Result<_, _>>()?;
            strictly_sorted_unique(
                &keys.iter().map(String::as_str).collect::<Vec<_>>(),
                "ObjectIntersectionOf.operands",
            )?;
        }
        Some("ObjectSomeValuesFrom" | "ObjectAllValuesFrom" | "ObjectMaxCardinality") => {
            validate_union_order(field(expression, "filler")?)?;
        }
        Some("ObjectComplementOf") => validate_union_order(field(expression, "operand")?)?,
        _ => {}
    }
    Ok(())
}

/// A property expression's sort key: `JSON.stringify` of it with its fields in schema order.
fn property_expression_key(property: &Value) -> Result<String, String> {
    let quoted = |value: &str| serde_json::to_string(value).expect("strings serialize as JSON");
    if let Some(iri) = property.as_str() {
        return Ok(quoted(iri));
    }
    if string(property, "kind")? != "ObjectInverseOf" {
        return Err("unknown property expression kind".into());
    }
    Ok(format!(
        "{{\"kind\":\"ObjectInverseOf\",\"property\":{}}}",
        quoted(string(property, "property")?)
    ))
}

fn class_expression_key(expression: &Value) -> Result<String, String> {
    // canonical.ts intentionally sorts class expressions by JSON.stringify(normalizeExpression).
    // Effect reconstructs Struct values in schema field order, so reproduce that order explicitly
    // instead of reusing canonical JSON, whose object keys are alphabetized.
    let kind = string(expression, "kind")?;
    let quoted = |value: &str| serde_json::to_string(value).expect("strings serialize as JSON");
    match kind {
        "NamedClass" => Ok(format!(
            "{{\"kind\":\"NamedClass\",\"iri\":{}}}",
            quoted(string(expression, "iri")?)
        )),
        "ObjectUnionOf" => Ok(format!(
            "{{\"kind\":\"ObjectUnionOf\",\"operands\":{}}}",
            serde_json::to_string(array(expression, "operands")?).expect("JSON values serialize")
        )),
        "OpaqueClassExpression" => Ok(format!(
            "{{\"kind\":\"OpaqueClassExpression\",\"constructIri\":{},\"canonicalForm\":{}}}",
            quoted(string(expression, "constructIri")?),
            quoted(string(expression, "canonicalForm")?)
        )),
        "CyclicClassExpression" => Ok(format!(
            "{{\"kind\":\"CyclicClassExpression\",\"expressionId\":{}}}",
            quoted(string(expression, "expressionId")?)
        )),
        "ObjectIntersectionOf" => {
            let operands: Vec<String> = array(expression, "operands")?
                .iter()
                .map(class_expression_key)
                .collect::<Result<_, _>>()?;
            Ok(format!(
                "{{\"kind\":\"ObjectIntersectionOf\",\"operands\":[{}]}}",
                operands.join(",")
            ))
        }
        "ObjectSomeValuesFrom" | "ObjectAllValuesFrom" => Ok(format!(
            "{{\"kind\":\"{kind}\",\"property\":{},\"filler\":{}}}",
            property_expression_key(field(expression, "property")?)?,
            class_expression_key(field(expression, "filler")?)?
        )),
        "ObjectMaxCardinality" => Ok(format!(
            "{{\"kind\":\"ObjectMaxCardinality\",\"cardinality\":{},\"property\":{},\"filler\":{}}}",
            field(expression, "cardinality")?,
            property_expression_key(field(expression, "property")?)?,
            class_expression_key(field(expression, "filler")?)?
        )),
        "ObjectComplementOf" => Ok(format!(
            "{{\"kind\":\"ObjectComplementOf\",\"operand\":{}}}",
            class_expression_key(field(expression, "operand")?)?
        )),
        _ => Err("unknown class expression kind".into()),
    }
}

fn cmp_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn cmp_utf16_parts(left: &[&str], right: &[&str]) -> Ordering {
    left.iter()
        .flat_map(|part| part.encode_utf16())
        .cmp(right.iter().flat_map(|part| part.encode_utf16()))
}

fn sort_utf16<T: AsRef<str>>(items: &mut [T]) {
    items.sort_by(|left, right| cmp_utf16(left.as_ref(), right.as_ref()));
}

fn sort_dedup_utf16(items: &mut Vec<String>) {
    sort_utf16(items);
    items.dedup();
}

fn strictly_sorted_unique(items: &[&str], label: &str) -> Result<(), String> {
    if items
        .windows(2)
        .any(|pair| cmp_utf16(pair[0], pair[1]) != Ordering::Less)
    {
        return Err(format!("{label} must be strictly sorted and unique"));
    }
    Ok(())
}

fn incompatibility_response(request: &Request, actual: &Tool) -> Option<Value> {
    let checks = [
        (
            request.protocol_version != PROTOCOL_VERSION,
            "protocol-version",
            PROTOCOL_VERSION.to_string(),
            request.protocol_version.to_string(),
        ),
        (
            request.profile.id != PROFILE_ID,
            "profile-id",
            PROFILE_ID.into(),
            request.profile.id.clone(),
        ),
        (
            request.profile.digest != PROFILE_DIGEST,
            "profile-digest",
            PROFILE_DIGEST.into(),
            request.profile.digest.clone(),
        ),
        (
            request.required_tool.name != actual.name,
            "tool-name",
            actual.name.clone(),
            request.required_tool.name.clone(),
        ),
        (
            request.required_tool.version != actual.version,
            "tool-version",
            actual.version.clone(),
            request.required_tool.version.clone(),
        ),
        (
            request.required_tool.executable_digest != actual.executable_digest,
            "executable-digest",
            actual.executable_digest.clone(),
            request.required_tool.executable_digest.clone(),
        ),
        (
            request.required_tool.adapter_digest != actual.adapter_digest,
            "adapter-digest",
            actual.adapter_digest.clone(),
            request.required_tool.adapter_digest.clone(),
        ),
        (
            request.required_tool.calculus_digest != actual.calculus_digest,
            "calculus-digest",
            actual.calculus_digest.clone(),
            request.required_tool.calculus_digest.clone(),
        ),
    ];
    checks
        .into_iter()
        .find(|item| item.0)
        .map(|(_, reason, expected, got)| incompatible(request, actual, reason, &expected, &got))
}

fn incompatible(
    request: &Request,
    tool: &Tool,
    reason: &str,
    expected: &str,
    actual: &str,
) -> Value {
    response_value(
        request,
        tool,
        json!({
            "actual": actual,
            "completeness": "incomplete",
            "diagnostics": [{"axiomIds": [], "code": reason, "message": format!("required {reason} does not match"), "severity": "error"}],
            "expected": expected,
            "outcome": "incompatible",
            "reason": reason
        }),
    )
}

fn response_value(request: &Request, tool: &Tool, result: Value) -> Value {
    json!({
        "inputDigest": request.ontology.digest,
        "kind": "ReasonerResponse",
        "profile": {"digest": PROFILE_DIGEST, "id": PROFILE_ID},
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request.request_id,
        "result": result,
        "tool": tool_value(tool)
    })
}

fn tool_value(tool: &Tool) -> Value {
    json!({
        "adapterDigest": tool.adapter_digest,
        "calculusDigest": tool.calculus_digest,
        "executableDigest": tool.executable_digest,
        "name": tool.name,
        "version": tool.version
    })
}

/// The canonical wire encoding of `value` and its LF.
///
/// `serde_json` keeps object keys in a `BTreeMap` (the `preserve_order` feature is never enabled;
/// a test pins it), so its output already has sorted keys, and every V1 protocol key is ASCII,
/// where byte order and UTF-16 order agree.
fn canonical_bytes(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).expect("JSON values serialize");
    bytes.push(b'\n');
    bytes
}

/// The canonical encoding of `value` without the LF, as the closure's fact keys use it.
fn canonical_text(value: &Value) -> String {
    serde_json::to_string(value).expect("JSON values serialize")
}

/// Feeds whatever is written into a SHA-256 state, so a digest needs no encoded copy.
struct HashWriter<'a>(&'a mut Sha256);

impl std::io::Write for HashWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// `sha256` of the canonical encoding of `value` and its LF, streamed into the hash.
fn sha256_json(value: &impl serde::Serialize) -> String {
    let mut hasher = Sha256::new();
    serde_json::to_writer(HashWriter(&mut hasher), value).expect("JSON values serialize");
    hasher.update(b"\n");
    format!("sha256:{:x}", hasher.finalize())
}

#[cfg(test)]
fn input_digest(sources: &[Value], axioms: &[Value]) -> String {
    sha256_json(&json!({"axioms": axioms, "sources": sources}))
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value, String> {
    value
        .get(name)
        .ok_or_else(|| format!("missing field {name}"))
}

fn string<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    field(value, name)?
        .as_str()
        .ok_or_else(|| format!("{name} must be a string"))
}

fn array<'a>(value: &'a Value, name: &str) -> Result<&'a Vec<Value>, String> {
    field(value, name)?
        .as_array()
        .ok_or_else(|| format!("{name} must be an array"))
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || ". _:/#-".contains(c))
        && !value.contains(' ')
}

fn is_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Every IRI the request's axioms name, which fresh check terms must avoid.
type UsedIris<'a> = BTreeSet<&'a str>;

/// The profile checks every request passes before reasoning; on success, every IRI its axioms
/// name, collected on the way so nothing scans the axioms for them again.
fn preflight(request: &Request) -> Result<UsedIris<'_>, Refusal> {
    // These closed reason labels and validated V1 identifiers are ASCII, so their map/set
    // ordering cannot diverge from the protocol's UTF-16 ordering.
    let mut diagnostics = Vec::new();
    let mut reason_flags = BTreeSet::new();
    let mut seen_sources = BTreeMap::new();
    let mut used = UsedIris::new();
    for source in &request.ontology.sources {
        let id = string(source, "id").map_err(malformed_refusal)?;
        let kind = string(source, "kind").map_err(malformed_refusal)?;
        let iri = string(source, "ontologyIri").map_err(malformed_refusal)?;
        let digest = string(source, "contentDigest").map_err(malformed_refusal)?;
        if !is_identifier(id)
            || !matches!(kind, "root" | "dependency")
            || !is_absolute_iri(iri)
            || !is_digest(digest)
        {
            return Err(malformed_refusal("invalid ontology source"));
        }
        if !exact_keys(source, &["contentDigest", "id", "kind", "ontologyIri"]) {
            return Err(malformed_refusal("ontology source has unknown fields"));
        }
        if is_reserved_iri(iri) && !allowed_reserved_iri(iri) {
            reason_flags.insert("unknown-reserved-term");
            diagnostics.push(Diagnostic {
                code: "unknown-reserved-term",
                message: format!("Reserved source ontology IRI is not in the V1 allowlist: {iri}"),
                axiom_ids: vec![],
            });
        }
        seen_sources.insert(id.to_owned(), digest.to_owned());
    }
    if request.ontology.axioms.len() as u64 > request.limits.max_input_axioms {
        return Err(Refusal {
            reason: "budget-exhausted",
            diagnostics: vec![Diagnostic {
                code: "max-input-axioms",
                message: "Input axiom limit exceeded before engine invocation".into(),
                axiom_ids: vec![],
            }],
        });
    }

    for axiom in &request.ontology.axioms {
        let id = match string(axiom, "id") {
            Ok(id) if is_identifier(id) => id.to_owned(),
            _ => return Err(malformed_refusal("invalid axiom id")),
        };
        string(axiom, "kind").map_err(malformed_refusal)?;
        let graph = field(axiom, "graph").map_err(malformed_refusal)?;
        match string(graph, "kind") {
            Ok("DefaultGraph") if exact_keys(graph, &["kind"]) => {}
            Ok("NamedGraph")
                if exact_keys(graph, &["iri", "kind"])
                    && graph
                        .get("iri")
                        .and_then(Value::as_str)
                        .is_some_and(is_absolute_iri) =>
            {
                reason_flags.insert("named-graph");
                diagnostics.push(Diagnostic {
                    code: "named-graph",
                    message: "V1 accepts the default graph only".into(),
                    axiom_ids: vec![id.clone()],
                });
            }
            _ => return Err(malformed_refusal("invalid graph name")),
        }

        let provenance = field(axiom, "provenance").map_err(malformed_refusal)?;
        match string(provenance, "status") {
            Ok("available") => {
                let source_id = string(provenance, "sourceId").map_err(malformed_refusal)?;
                let source_digest =
                    string(provenance, "sourceDigest").map_err(malformed_refusal)?;
                let locator = string(provenance, "locator").map_err(malformed_refusal)?;
                if locator.is_empty()
                    || !is_identifier(source_id)
                    || !is_digest(source_digest)
                    || seen_sources.get(source_id).map(String::as_str) != Some(source_digest)
                {
                    return Err(malformed_refusal(
                        "axiom provenance does not bind a declared source",
                    ));
                }
                if !exact_keys(
                    provenance,
                    &["locator", "sourceDigest", "sourceId", "status"],
                ) {
                    return Err(malformed_refusal("available provenance has unknown fields"));
                }
            }
            Ok("missing") if exact_keys(provenance, &["status"]) => {
                reason_flags.insert("missing-provenance");
                diagnostics.push(Diagnostic {
                    code: "missing-provenance",
                    message: "Every asserted axiom requires source provenance".into(),
                    axiom_ids: vec![id.clone()],
                });
            }
            _ => return Err(malformed_refusal("invalid axiom provenance")),
        }

        let typed_iris = axiom_iris(axiom);
        used.extend(typed_iris.iter().copied());
        if typed_iris.contains(&OWL_BOTTOM_OBJECT) || typed_iris.contains(&OWL_BOTTOM_DATA) {
            reason_flags.insert("bottom-property");
            let (code, message) = if typed_iris.contains(&OWL_BOTTOM_OBJECT) {
                (
                    "bottom-object-property-known-divergence",
                    "PurRDF missed this bottom object property inconsistency",
                )
            } else {
                (
                    "bottom-data-property-known-divergence",
                    "PurRDF missed this bottom data property inconsistency",
                )
            };
            diagnostics.push(Diagnostic {
                code,
                message: message.into(),
                axiom_ids: vec![id.clone()],
            });
        }
        let cyclic = value_has_expression_kind(axiom, "CyclicClassExpression");
        if cyclic {
            reason_flags.insert("cyclic-expression");
            diagnostics.push(Diagnostic {
                code: "cyclic-expression-known-divergence",
                message: "PurRDF withheld a decided result for this cyclic expression".into(),
                axiom_ids: vec![id.clone()],
            });
        }
        if thing_nothing_equivalence(axiom) {
            reason_flags.insert("known-divergence");
            diagnostics.push(Diagnostic {
                code: "thing-nothing-empty-domain-known-divergence",
                message: "PurRDF wrongly reported this empty-domain ontology satisfiable".into(),
                axiom_ids: vec![id.clone()],
            });
        }
        for iri in typed_iris {
            if is_reserved_iri(iri) && !allowed_reserved_iri(iri) {
                reason_flags.insert("unknown-reserved-term");
                diagnostics.push(Diagnostic {
                    code: "unknown-reserved-term",
                    message: format!("Reserved term is not in the V1 allowlist: {iri}"),
                    axiom_ids: vec![id.clone()],
                });
            }
        }

        match validate_axiom_shape(axiom) {
            Ok(()) => {}
            Err("unsupported-expression-context") if cyclic => {}
            Err(code) => {
                let reason = if code == "unsupported-import"
                    || code == "unsupported-opaque-axiom"
                    || code == "unsupported-expression-context"
                {
                    "unsupported-construct"
                } else {
                    return Err(malformed_refusal(code));
                };
                reason_flags.insert(reason);
                diagnostics.push(Diagnostic {
                    code: Box::leak(code.to_owned().into_boxed_str()),
                    message: unsupported_message(code).into(),
                    axiom_ids: vec![id],
                });
            }
        }
    }
    if diagnostics.is_empty() {
        return Ok(used);
    }
    diagnostics.sort_by(cmp_diagnostic);
    let reason = [
        "bottom-property",
        "cyclic-expression",
        "known-divergence",
        "unsupported-construct",
        "named-graph",
        "unknown-reserved-term",
        "missing-provenance",
    ]
    .into_iter()
    .find(|candidate| reason_flags.contains(candidate))
    .unwrap_or("unsupported-construct");
    Err(Refusal {
        reason,
        diagnostics,
    })
}

fn validate_axiom_shape(axiom: &Value) -> Result<(), &'static str> {
    let kind = axiom
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("axiom kind missing")?;
    match kind {
        "Declaration" => {
            require_keys(
                axiom,
                &["entityKind", "graph", "id", "iri", "kind", "provenance"],
            )?;
            if !matches!(
                axiom.get("entityKind").and_then(Value::as_str),
                Some(
                    "Ontology"
                        | "Class"
                        | "ObjectProperty"
                        | "DataProperty"
                        | "AnnotationProperty"
                        | "NamedIndividual"
                        | "Datatype"
                )
            ) {
                return Err("invalid declaration kind");
            }
            require_iri(axiom, "iri")
        }
        "SubClassOf" => {
            require_keys(
                axiom,
                &[
                    "graph",
                    "id",
                    "kind",
                    "provenance",
                    "subClass",
                    "superClass",
                ],
            )?;
            let sub = field_static(axiom, "subClass")?;
            let sup = field_static(axiom, "superClass")?;
            validate_expression_schema(sub)?;
            validate_expression_schema(sup)?;
            admitted_context(admitted_at(sub, false) && admitted_at(sup, true))
        }
        "ClassAssertion" => {
            require_keys(
                axiom,
                &[
                    "classExpression",
                    "graph",
                    "id",
                    "individual",
                    "kind",
                    "provenance",
                ],
            )?;
            require_iri(axiom, "individual")?;
            let expression = field_static(axiom, "classExpression")?;
            validate_expression_schema(expression)?;
            admitted_context(admitted_at(expression, true))
        }
        "PropertyDomain" => {
            require_keys(
                axiom,
                &[
                    "domain",
                    "graph",
                    "id",
                    "kind",
                    "property",
                    "propertyKind",
                    "provenance",
                ],
            )?;
            require_property_kind(axiom)?;
            require_iri(axiom, "property")?;
            let domain = field_static(axiom, "domain")?;
            validate_expression_schema(domain)?;
            let kind = domain.get("kind").and_then(Value::as_str);
            if axiom.get("propertyKind").and_then(Value::as_str) == Some("AnnotationProperty") {
                return admitted_context(kind == Some("NamedClass"));
            }
            // A union of named classes is admitted as a domain at the top level only.
            admitted_context(kind == Some("ObjectUnionOf") || admitted_at(domain, true))
        }
        "PropertyRange" => {
            require_keys(
                axiom,
                &[
                    "graph",
                    "id",
                    "kind",
                    "property",
                    "propertyKind",
                    "provenance",
                    "range",
                ],
            )?;
            require_property_kind(axiom)?;
            require_iri(axiom, "property")?;
            let range = field_static(axiom, "range")?;
            if range.is_string() {
                return require_iri(axiom, "range");
            }
            validate_expression_schema(range)?;
            // A named range is an IRI; an expression is an object property's range only.
            admitted_context(
                axiom.get("propertyKind").and_then(Value::as_str) == Some("ObjectProperty")
                    && range.get("kind").and_then(Value::as_str) != Some("NamedClass")
                    && admitted_at(range, true),
            )
        }
        "EquivalentClasses" | "DisjointClasses" => {
            require_keys(axiom, &["classes", "graph", "id", "kind", "provenance"])?;
            let classes = axiom
                .get("classes")
                .and_then(Value::as_array)
                .ok_or("classes must be an array")?;
            if classes.len() < 2 {
                return Err("classes must contain at least two expressions");
            }
            for class in classes {
                validate_expression_schema(class)?;
            }
            let equivalent = kind == "EquivalentClasses";
            admitted_context(classes.iter().all(|class| {
                admitted_at(class, false) && (!equivalent || admitted_at(class, true))
            }))
        }
        "InverseObjectProperties" => {
            require_keys(
                axiom,
                &["graph", "id", "kind", "left", "provenance", "right"],
            )?;
            require_iri(axiom, "left")?;
            require_iri(axiom, "right")
        }
        "TransitiveObjectProperty" | "SymmetricObjectProperty" | "FunctionalDataProperty" => {
            require_keys(axiom, &["graph", "id", "kind", "property", "provenance"])?;
            require_iri(axiom, "property")
        }
        "FunctionalObjectProperty" | "InverseFunctionalObjectProperty" => {
            require_keys(axiom, &["graph", "id", "kind", "property", "provenance"])?;
            require_property_expression(field_static(axiom, "property")?)
        }
        "SubObjectPropertyOf" => {
            require_keys(
                axiom,
                &[
                    "graph",
                    "id",
                    "kind",
                    "provenance",
                    "subProperty",
                    "superProperty",
                ],
            )?;
            let sub = field_static(axiom, "subProperty")?;
            if sub.get("kind").and_then(Value::as_str) == Some("ObjectPropertyChain") {
                if !exact_keys(sub, &["kind", "properties"]) {
                    return Err("property chain has missing or unknown fields");
                }
                let properties = sub
                    .get("properties")
                    .and_then(Value::as_array)
                    .ok_or("property chain must be an array")?;
                if properties.len() < 2 {
                    return Err("property chain needs two properties");
                }
                for property in properties {
                    require_property_expression(property)?;
                }
            } else {
                require_property_expression(sub)?;
            }
            require_property_expression(field_static(axiom, "superProperty")?)
        }
        "EquivalentObjectProperties" | "EquivalentDataProperties" => {
            require_keys(axiom, &["graph", "id", "kind", "properties", "provenance"])?;
            let properties = axiom
                .get("properties")
                .and_then(Value::as_array)
                .ok_or("properties must be an array")?;
            if properties.len() < 2 {
                return Err("properties must contain at least two properties");
            }
            for property in properties {
                if kind == "EquivalentDataProperties" {
                    match property.as_str() {
                        Some(iri) if is_absolute_iri(iri) => {}
                        _ => return Err("invalid absolute IRI"),
                    }
                } else {
                    require_property_expression(property)?;
                }
            }
            Ok(())
        }
        "SubDataPropertyOf" => {
            require_keys(
                axiom,
                &[
                    "graph",
                    "id",
                    "kind",
                    "provenance",
                    "subProperty",
                    "superProperty",
                ],
            )?;
            require_iri(axiom, "subProperty")?;
            require_iri(axiom, "superProperty")
        }
        "ObjectPropertyAssertion" => {
            require_keys(
                axiom,
                &[
                    "graph",
                    "id",
                    "kind",
                    "object",
                    "property",
                    "provenance",
                    "subject",
                ],
            )?;
            require_iri(axiom, "subject")?;
            require_iri(axiom, "property")?;
            require_iri(axiom, "object")
        }
        "DataPropertyAssertion" => {
            require_keys(
                axiom,
                &[
                    "graph",
                    "id",
                    "kind",
                    "property",
                    "provenance",
                    "subject",
                    "value",
                ],
            )?;
            require_iri(axiom, "subject")?;
            require_iri(axiom, "property")?;
            require_literal(field_static(axiom, "value")?)
        }
        "AnnotationAssertion" => {
            require_keys(
                axiom,
                &[
                    "graph",
                    "id",
                    "kind",
                    "property",
                    "provenance",
                    "subject",
                    "value",
                ],
            )?;
            require_iri(axiom, "subject")?;
            require_iri(axiom, "property")?;
            let value = field_static(axiom, "value")?;
            if let Some(iri) = value.as_str() {
                if is_absolute_iri(iri) {
                    Ok(())
                } else {
                    Err("annotation IRI is invalid")
                }
            } else {
                require_literal(value)
            }
        }
        "Import" => {
            require_keys(axiom, &["graph", "id", "kind", "ontology", "provenance"])?;
            require_iri(axiom, "ontology")?;
            Err("unsupported-import")
        }
        "OpaqueAxiom" => {
            require_keys(
                axiom,
                &[
                    "canonicalForm",
                    "constructIri",
                    "graph",
                    "id",
                    "kind",
                    "provenance",
                ],
            )?;
            require_iri(axiom, "constructIri")?;
            if axiom
                .get("canonicalForm")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err("opaque canonical form is invalid");
            }
            Err("unsupported-opaque-axiom")
        }
        _ => Err("unsupported-opaque-axiom"),
    }
}

fn require_keys(value: &Value, keys: &[&str]) -> Result<(), &'static str> {
    if exact_keys(value, keys) {
        Ok(())
    } else {
        Err("axiom has missing or unknown fields")
    }
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

fn field_static<'a>(value: &'a Value, name: &str) -> Result<&'a Value, &'static str> {
    value.get(name).ok_or("required field missing")
}

fn require_iri(value: &Value, name: &str) -> Result<(), &'static str> {
    match value.get(name).and_then(Value::as_str) {
        Some(iri) if is_absolute_iri(iri) => Ok(()),
        _ => Err("invalid absolute IRI"),
    }
}

fn require_property_kind(value: &Value) -> Result<(), &'static str> {
    if matches!(
        value.get("propertyKind").and_then(Value::as_str),
        Some("ObjectProperty" | "DataProperty" | "AnnotationProperty")
    ) {
        Ok(())
    } else {
        Err("invalid property kind")
    }
}

fn require_named(value: &Value) -> Result<(), &'static str> {
    if !exact_keys(value, &["iri", "kind"])
        || value.get("kind").and_then(Value::as_str) != Some("NamedClass")
    {
        return Err("not a named class");
    }
    require_iri(value, "iri")
}

/// An object property expression: an IRI, or `ObjectInverseOf` of one.
fn require_property_expression(value: &Value) -> Result<(), &'static str> {
    if let Some(iri) = value.as_str() {
        return if is_absolute_iri(iri) {
            Ok(())
        } else {
            Err("invalid absolute IRI")
        };
    }
    if !exact_keys(value, &["kind", "property"])
        || value.get("kind").and_then(Value::as_str) != Some("ObjectInverseOf")
    {
        return Err("invalid property expression");
    }
    require_iri(value, "property")
}

fn admitted_context(admitted: bool) -> Result<(), &'static str> {
    if admitted {
        Ok(())
    } else {
        Err("unsupported-expression-context")
    }
}

/// Whether the Horn calculus admits a (schema-valid) expression where something is asserted to be
/// in it (`positive`) or tested against it: `admittedAt` in reasoner/protocol/src/expressions.ts.
fn admitted_at(value: &Value, positive: bool) -> bool {
    let filler = |name: &str, polarity: bool| {
        value
            .get(name)
            .is_some_and(|item| admitted_at(item, polarity))
    };
    match value.get("kind").and_then(Value::as_str) {
        Some("NamedClass") => true,
        Some("ObjectIntersectionOf") => value
            .get("operands")
            .and_then(Value::as_array)
            .is_some_and(|operands| operands.iter().all(|item| admitted_at(item, positive))),
        Some("ObjectSomeValuesFrom") => filler("filler", positive),
        Some("ObjectUnionOf") => !positive,
        Some("ObjectAllValuesFrom") => positive && filler("filler", true),
        Some("ObjectMaxCardinality") => positive && filler("filler", false),
        Some("ObjectComplementOf") => positive && filler("operand", false),
        _ => false,
    }
}

fn validate_expression_schema(value: &Value) -> Result<(), &'static str> {
    match value.get("kind").and_then(Value::as_str) {
        Some("NamedClass") => require_named(value),
        Some("ObjectUnionOf") => require_union(value),
        Some("ObjectIntersectionOf") => {
            if !exact_keys(value, &["kind", "operands"]) {
                return Err("class expression has missing or unknown fields");
            }
            let operands = value
                .get("operands")
                .and_then(Value::as_array)
                .ok_or("invalid intersection operands")?;
            if operands.len() < 2 {
                return Err("invalid intersection operands");
            }
            operands.iter().try_for_each(validate_expression_schema)
        }
        Some("ObjectSomeValuesFrom" | "ObjectAllValuesFrom") => {
            if !exact_keys(value, &["filler", "kind", "property"]) {
                return Err("class expression has missing or unknown fields");
            }
            require_property_expression(field_static(value, "property")?)?;
            validate_expression_schema(field_static(value, "filler")?)
        }
        Some("ObjectMaxCardinality") => {
            if !exact_keys(value, &["cardinality", "filler", "kind", "property"]) {
                return Err("class expression has missing or unknown fields");
            }
            if !matches!(
                value.get("cardinality").and_then(Value::as_u64),
                Some(0 | 1)
            ) || !value.get("cardinality").is_some_and(Value::is_u64)
            {
                return Err("maximum cardinality must be 0 or 1");
            }
            require_property_expression(field_static(value, "property")?)?;
            validate_expression_schema(field_static(value, "filler")?)
        }
        Some("ObjectComplementOf") => {
            if !exact_keys(value, &["kind", "operand"]) {
                return Err("class expression has missing or unknown fields");
            }
            validate_expression_schema(field_static(value, "operand")?)
        }
        Some("OpaqueClassExpression") => {
            if !exact_keys(value, &["canonicalForm", "constructIri", "kind"]) {
                return Err("class expression has missing or unknown fields");
            }
            require_iri(value, "constructIri")?;
            if value
                .get("canonicalForm")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err("opaque expression canonical form is invalid");
            }
            Ok(())
        }
        Some("CyclicClassExpression") => {
            if !exact_keys(value, &["expressionId", "kind"]) {
                return Err("class expression has missing or unknown fields");
            }
            if value
                .get("expressionId")
                .and_then(Value::as_str)
                .is_some_and(is_identifier)
            {
                Ok(())
            } else {
                Err("cyclic expression id is invalid")
            }
        }
        _ => Err("unknown class expression"),
    }
}

fn require_union(value: &Value) -> Result<(), &'static str> {
    if !exact_keys(value, &["kind", "operands"])
        || value.get("kind").and_then(Value::as_str) != Some("ObjectUnionOf")
    {
        return Err("invalid union");
    }
    let operands = value
        .get("operands")
        .and_then(Value::as_array)
        .ok_or("invalid union operands")?;
    if operands.len() < 2
        || operands
            .iter()
            .any(|item| item.as_str().is_none_or(|iri| !is_absolute_iri(iri)))
    {
        return Err("invalid union operands");
    }
    Ok(())
}

fn require_literal(value: &Value) -> Result<(), &'static str> {
    if !exact_keys(value, &["datatype", "kind", "language", "lexicalForm"])
        || value.get("kind").and_then(Value::as_str) != Some("Literal")
    {
        return Err("invalid literal");
    }
    require_iri(value, "datatype")?;
    if !value.get("lexicalForm").is_some_and(Value::is_string) {
        return Err("invalid literal lexical form");
    }
    if let Some(language) = value.get("language").and_then(Value::as_str) {
        let mut parts = language.split('-');
        let first = parts.next().unwrap_or_default();
        if first.is_empty()
            || !first.bytes().all(|byte| byte.is_ascii_alphabetic())
            || parts.any(|part| {
                part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
        {
            return Err("invalid language tag");
        }
    } else if !value.get("language").is_some_and(Value::is_null) {
        return Err("invalid language tag");
    }
    Ok(())
}

fn is_absolute_iri(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    colon > 0
        && value[..colon].bytes().enumerate().all(|(index, b)| {
            if index == 0 {
                b.is_ascii_alphabetic()
            } else {
                b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-')
            }
        })
        && value[colon + 1..].chars().next().is_some()
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn malformed_refusal(message: impl Into<String>) -> Refusal {
    Refusal {
        reason: "unsupported-construct",
        diagnostics: vec![Diagnostic {
            code: "malformed-normalized-axiom",
            message: message.into(),
            axiom_ids: vec![],
        }],
    }
}

fn unsupported_message(code: &str) -> &'static str {
    match code {
        "unsupported-import" => "Imports must be resolved before invocation",
        "unsupported-opaque-axiom" => "Opaque axioms are outside the V1 allowlist",
        "unsupported-expression-context" => "Class expression is outside its V1 context",
        _ => "Normalized axiom is invalid",
    }
}

fn value_has_expression_kind(value: &Value, kind: &str) -> bool {
    match value {
        Value::Array(items) => items
            .iter()
            .any(|item| value_has_expression_kind(item, kind)),
        Value::Object(object) => {
            object.get("kind").and_then(Value::as_str) == Some(kind)
                || object
                    .values()
                    .any(|item| value_has_expression_kind(item, kind))
        }
        _ => false,
    }
}

fn thing_nothing_equivalence(axiom: &Value) -> bool {
    axiom.get("kind").and_then(Value::as_str) == Some("EquivalentClasses")
        && axiom
            .get("classes")
            .and_then(Value::as_array)
            .is_some_and(|classes| {
                // Membership only: this set's iteration order is not observable.
                let iris: BTreeSet<_> = classes
                    .iter()
                    .filter_map(|class| class.get("iri").and_then(Value::as_str))
                    .collect();
                iris.contains(OWL_THING) && iris.contains(OWL_NOTHING)
            })
}

fn axiom_iris(axiom: &Value) -> Vec<&str> {
    let mut iris = Vec::new();
    if axiom
        .get("graph")
        .and_then(|graph| graph.get("kind"))
        .and_then(Value::as_str)
        == Some("NamedGraph")
        && let Some(iri) = axiom
            .get("graph")
            .and_then(|graph| graph.get("iri"))
            .and_then(Value::as_str)
    {
        iris.push(iri);
    }
    match axiom.get("kind").and_then(Value::as_str) {
        Some("Declaration") => collect_iri(&mut iris, axiom, "iri"),
        Some("SubClassOf") => {
            expression_iris(axiom.get("subClass"), &mut iris);
            expression_iris(axiom.get("superClass"), &mut iris);
        }
        Some("ClassAssertion") => {
            collect_iri(&mut iris, axiom, "individual");
            expression_iris(axiom.get("classExpression"), &mut iris);
        }
        Some("PropertyDomain") => {
            collect_iri(&mut iris, axiom, "property");
            expression_iris(axiom.get("domain"), &mut iris);
        }
        Some("PropertyRange") => {
            collect_iri(&mut iris, axiom, "property");
            match axiom.get("range") {
                Some(range) if range.is_object() => expression_iris(Some(range), &mut iris),
                _ => collect_iri(&mut iris, axiom, "range"),
            }
        }
        Some("EquivalentClasses" | "DisjointClasses") => {
            if let Some(classes) = axiom.get("classes").and_then(Value::as_array) {
                for expression in classes {
                    expression_iris(Some(expression), &mut iris);
                }
            }
        }
        Some("InverseObjectProperties") => {
            collect_iri(&mut iris, axiom, "left");
            collect_iri(&mut iris, axiom, "right");
        }
        Some("TransitiveObjectProperty" | "SymmetricObjectProperty" | "FunctionalDataProperty") => {
            collect_iri(&mut iris, axiom, "property");
        }
        Some("FunctionalObjectProperty" | "InverseFunctionalObjectProperty") => {
            property_iris(axiom.get("property"), &mut iris);
        }
        Some("SubObjectPropertyOf") => {
            let sub = axiom.get("subProperty");
            match sub
                .and_then(|value| value.get("properties"))
                .and_then(Value::as_array)
            {
                Some(chain) => chain
                    .iter()
                    .for_each(|item| property_iris(Some(item), &mut iris)),
                None => property_iris(sub, &mut iris),
            }
            property_iris(axiom.get("superProperty"), &mut iris);
        }
        Some("EquivalentObjectProperties" | "EquivalentDataProperties") => {
            if let Some(properties) = axiom.get("properties").and_then(Value::as_array) {
                for property in properties {
                    property_iris(Some(property), &mut iris);
                }
            }
        }
        Some("SubDataPropertyOf") => {
            collect_iri(&mut iris, axiom, "subProperty");
            collect_iri(&mut iris, axiom, "superProperty");
        }
        Some("ObjectPropertyAssertion") => {
            collect_iri(&mut iris, axiom, "property");
            collect_iri(&mut iris, axiom, "subject");
            collect_iri(&mut iris, axiom, "object");
        }
        Some("DataPropertyAssertion") => {
            collect_iri(&mut iris, axiom, "property");
            collect_iri(&mut iris, axiom, "subject");
            literal_iris(axiom.get("value"), &mut iris);
        }
        Some("AnnotationAssertion") => {
            collect_iri(&mut iris, axiom, "property");
            collect_iri(&mut iris, axiom, "subject");
            if let Some(value) = axiom.get("value") {
                if let Some(iri) = value.as_str() {
                    iris.push(iri);
                } else {
                    literal_iris(Some(value), &mut iris);
                }
            }
        }
        Some("Import") => collect_iri(&mut iris, axiom, "ontology"),
        Some("OpaqueAxiom") => collect_iri(&mut iris, axiom, "constructIri"),
        _ => {}
    }
    sort_utf16(&mut iris);
    iris.dedup();
    iris
}

fn collect_iri<'a>(iris: &mut Vec<&'a str>, value: &'a Value, field: &str) {
    if let Some(iri) = value.get(field).and_then(Value::as_str) {
        iris.push(iri);
    }
}

fn expression_iris<'a>(expression: Option<&'a Value>, iris: &mut Vec<&'a str>) {
    let Some(expression) = expression else {
        return;
    };
    match expression.get("kind").and_then(Value::as_str) {
        Some("NamedClass") => {
            if let Some(iri) = expression.get("iri").and_then(Value::as_str) {
                iris.push(iri);
            }
        }
        Some("ObjectUnionOf") => {
            if let Some(operands) = expression.get("operands").and_then(Value::as_array) {
                iris.extend(operands.iter().filter_map(Value::as_str));
            }
        }
        Some("OpaqueClassExpression") => {
            if let Some(iri) = expression.get("constructIri").and_then(Value::as_str) {
                iris.push(iri);
            }
        }
        Some("ObjectIntersectionOf") => {
            if let Some(operands) = expression.get("operands").and_then(Value::as_array) {
                for operand in operands {
                    expression_iris(Some(operand), iris);
                }
            }
        }
        Some("ObjectSomeValuesFrom" | "ObjectAllValuesFrom" | "ObjectMaxCardinality") => {
            property_iris(expression.get("property"), iris);
            expression_iris(expression.get("filler"), iris);
        }
        Some("ObjectComplementOf") => expression_iris(expression.get("operand"), iris),
        _ => {}
    }
}

/// The named property of a property expression (an IRI, or the property `ObjectInverseOf` names).
fn property_iris<'a>(property: Option<&'a Value>, iris: &mut Vec<&'a str>) {
    let Some(property) = property else {
        return;
    };
    if let Some(iri) = property
        .as_str()
        .or_else(|| property.get("property").and_then(Value::as_str))
    {
        iris.push(iri);
    }
}

fn literal_iris<'a>(literal: Option<&'a Value>, iris: &mut Vec<&'a str>) {
    if let Some(iri) = literal
        .and_then(|value| value.get("datatype"))
        .and_then(Value::as_str)
    {
        iris.push(iri);
    }
}

fn is_reserved_iri(iri: &str) -> bool {
    [
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "http://www.w3.org/2000/01/rdf-schema#",
        "http://www.w3.org/2002/07/owl#",
    ]
    .iter()
    .any(|namespace| iri.starts_with(namespace))
}

fn allowed_reserved_iri(iri: &str) -> bool {
    matches!(
        iri,
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#HTML"
            | "http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON"
            | "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property"
            | "http://www.w3.org/1999/02/22-rdf-syntax-ns#XMLLiteral"
            | "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString"
            | RDF_TYPE
            | "http://www.w3.org/2000/01/rdf-schema#Class"
            | "http://www.w3.org/2000/01/rdf-schema#Datatype"
            | "http://www.w3.org/2000/01/rdf-schema#Literal"
            | "http://www.w3.org/2000/01/rdf-schema#comment"
            | RDFS_DOMAIN
            | "http://www.w3.org/2000/01/rdf-schema#label"
            | RDFS_RANGE
            | RDFS_SUBCLASS
            | "http://www.w3.org/2002/07/owl#AnnotationProperty"
            | "http://www.w3.org/2002/07/owl#Class"
            | "http://www.w3.org/2002/07/owl#DatatypeProperty"
            | "http://www.w3.org/2002/07/owl#NamedIndividual"
            | OWL_NOTHING
            | "http://www.w3.org/2002/07/owl#ObjectProperty"
            | "http://www.w3.org/2002/07/owl#Ontology"
            | OWL_THING
            | OWL_TRANSITIVE
            | OWL_BOTTOM_DATA
            | OWL_BOTTOM_OBJECT
            | OWL_DISJOINT
            | OWL_EQUIVALENT
            | "http://www.w3.org/2002/07/owl#imports"
            | OWL_INVERSE
            | OWL_UNION
    )
}

fn refused_value(mut refusal: Refusal) -> Value {
    for diagnostic in &mut refusal.diagnostics {
        sort_dedup_utf16(&mut diagnostic.axiom_ids);
    }
    refusal.diagnostics.sort_by(cmp_diagnostic);
    let diagnostics: Vec<Value> = refusal
        .diagnostics
        .into_iter()
        .map(|item| {
            json!({"axiomIds": item.axiom_ids, "code": item.code, "message": item.message, "severity": "error"})
        })
        .collect();
    json!({"completeness": "incomplete", "diagnostics": diagnostics, "outcome": "refused", "reason": refusal.reason})
}

/// The result value a request decides to, with its certificate bound: the tests' view of
/// [`run_request`], which encodes the same evidence straight to bytes instead.
#[cfg(test)]
fn reason(request: &Request, started: Instant) -> Value {
    let used: UsedIris<'_> = request
        .ontology
        .axioms
        .iter()
        .flat_map(axiom_iris)
        .collect();
    match decide(request, started, &used) {
        Ok(mut evidence) => {
            let encoded = EncodedEvidence::new(&mut evidence);
            let certificate = certificate(request, &evidence, &encoded);
            serde_json::from_slice(&encoded.with_certificate(&certificate))
                .expect("encoded evidence decodes")
        }
        Err(refusal) => refused_value(refusal),
    }
}

fn within_budget(request: &Request, started: Instant, stage: &str) -> Result<(), Refusal> {
    if elapsed(request, started) {
        return Err(engine_refusal(
            "budget-exhausted",
            "wall-time-budget",
            format!("Wall-time budget elapsed {stage}"),
        ));
    }
    Ok(())
}

fn uncheckable_inconsistency() -> Refusal {
    engine_refusal(
        "incomplete-certificate",
        "uncheckable-inconsistency",
        "PurRDF found inconsistency but the V1 structural checker cannot certify its cause",
    )
}

/// The V1 decision procedure (see `engine`): the hierarchy once, the closure, each individual
/// signature and each data range against the hierarchy, then the types the closure's rules
/// cannot reach. Returns the decided evidence, not yet bound to a certificate.
fn decide(request: &Request, started: Instant, used: &UsedIris<'_>) -> Result<Value, Refusal> {
    let axioms = &request.ontology.axioms;
    let (mut asserted, mut facts) = initial_facts(axioms);
    sort_statements(&mut asserted);
    phase!("initial-facts");
    // An individual asserted in two classes of one `DisjointClasses` axiom is its own proof of
    // inconsistency, which the TypeScript proof checker verifies; no PurRDF question would add to
    // it, and nothing else is needed for the inconsistent answer.
    let witness = direct_inconsistency(axioms);
    phase!("direct-inconsistency");
    if let Some(diagnostic) = witness {
        within_budget(request, started, "before inconsistent certificate binding")?;
        return Ok(decided_evidence(
            asserted,
            "inconsistent",
            vec![diagnostic],
            Vec::new(),
            Vec::new(),
        ));
    }

    // Anything beyond the V1 allow-list is decided by the Horn saturation; V1 content by the 0.2
    // procedure below, unchanged, so its answers keep their statements, identifiers and proofs.
    if cfg!(feature = "force-horn") || !axioms.iter().all(horn::is_v1_axiom) {
        return horn::decide(request, started, used, asserted);
    }

    let hierarchy = engine::hierarchy_axioms(axioms);
    let dataset = engine::hierarchy_dataset(&hierarchy)
        .map_err(|message| engine_refusal("incomplete-certificate", "dataset-build", message))?;
    phase!("build-dataset");
    within_budget(request, started, "before PurRDF invocation")?;
    let reasoner = engine::open_reasoner(&dataset)?;
    phase!("purrdf-open");
    // One PurRDF session decides the hierarchy's consistency and, if it has a model, classifies it.
    let Some(classification) = engine::classify_hierarchy(&reasoner)? else {
        return Err(uncheckable_inconsistency());
    };
    // OWL 2 Direct Semantics needs a non-empty domain, so an unsatisfiable `owl:Thing` leaves the
    // ontology without a model. PurRDF accepts such a hierarchy on an empty domain, and with no
    // individual no signature check would reach `owl:Thing`; the classification answers it here.
    if classification
        .answer()
        .unsatisfiable()
        .iter()
        .any(|class| class.as_iri() == Some(OWL_THING))
    {
        return Err(uncheckable_inconsistency());
    }
    phase!("purrdf-classification");
    within_budget(request, started, "after consistency")?;

    let mut inferred = engine::close_facts(axioms, &mut facts, request.limits.max_inferences)?;
    phase!("closure");
    within_budget(request, started, "after the closure")?;
    let individuals = engine::Individuals::collect(axioms, &facts);
    let closed = engine::Hierarchy::collect(axioms, &facts);
    let thing_has_superclass = engine::thing_has_superclass(classification.answer());
    let classified = engine::Classified::new(axioms, &closed, classification.answer());
    let witnesses = engine::fresh_prefix(used, "urn:erden-reasoner:check:signature:");
    let consistent = engine::check_signatures(
        &hierarchy,
        individuals.signatures().into_keys(),
        thing_has_superclass,
        |signature| classified.satisfiable(signature),
        &witnesses,
        || within_budget(request, started, "while checking individual signatures"),
    )?;
    if !consistent {
        return Err(uncheckable_inconsistency());
    }
    phase!("purrdf-signatures");
    let individual = engine::fresh_iri(used, "urn:erden-reasoner:check:individual");
    let property = engine::fresh_iri(used, "urn:erden-reasoner:check:property");
    let clashes = engine::check_literals(axioms, &property, &individual)?;
    if !clashes.is_empty() {
        return Err(engine::literal_clash_refusal(
            axioms,
            &clashes,
            asserted_literal_uses(axioms),
        ));
    }
    phase!("purrdf-literals");
    let typed = engine::type_individuals(
        &closed,
        &individuals,
        thing_has_superclass,
        inferred.len(),
        request.limits.max_inferences,
    )?;
    inferred.extend(typed);
    sort_statements(&mut inferred);
    phase!("typing");
    let unsatisfiable =
        bind_unsatisfiable(axioms, &facts, classification.answer().unsatisfiable())?;
    within_budget(request, started, "before certificate binding")?;
    Ok(decided_evidence(
        asserted,
        "consistent",
        Vec::new(),
        inferred,
        unsatisfiable,
    ))
}

/// The literal values the request asserts, each given by its own assertion.
fn asserted_literal_uses(axioms: &[Value]) -> impl Iterator<Item = engine::LiteralUse<'_>> {
    axioms
        .iter()
        .filter(|axiom| axiom["kind"] == "DataPropertyAssertion")
        .filter_map(|axiom| {
            let property = axiom["property"].as_str()?;
            Some(engine::LiteralUse {
                subject: axiom["subject"].as_str()?.to_owned(),
                property,
                asserted: property,
                value: &axiom["value"],
                axiom_ids: vec![axiom["id"].as_str()?.to_owned()],
            })
        })
}

/// A decided evidence object, built by moving its statement lists in (`json!` would copy them).
fn decided_evidence(
    asserted: Vec<Value>,
    consistency: &str,
    diagnostics: Vec<Value>,
    inferred: Vec<Value>,
    unsatisfiable: Vec<Value>,
) -> Value {
    let mut evidence = serde_json::Map::new();
    evidence.insert("asserted".into(), Value::Array(asserted));
    evidence.insert("completeness".into(), Value::from("complete"));
    evidence.insert("consistency".into(), Value::from(consistency));
    evidence.insert("diagnostics".into(), Value::Array(diagnostics));
    evidence.insert("inferred".into(), Value::Array(inferred));
    evidence.insert("outcome".into(), Value::from("decided"));
    evidence.insert("unsatisfiableClasses".into(), Value::Array(unsatisfiable));
    Value::Object(evidence)
}

fn elapsed(request: &Request, started: Instant) -> bool {
    started.elapsed().as_millis() >= u128::from(request.limits.max_wall_time_ms)
}

fn check_dl_certificate(
    certificate: &purrdf_entail::DlCertificate,
    phase: &str,
) -> Result<(), Refusal> {
    match certificate.completeness() {
        DlCompleteness::Decided if certificate.boundaries().is_empty() => Ok(()),
        DlCompleteness::BudgetExhausted => Err(engine_refusal(
            "budget-exhausted",
            "purrdf-budget-exhausted",
            format!("PurRDF {phase} exhausted its deterministic step budget"),
        )),
        _ => Err(engine_refusal(
            "boundary-exhausted",
            "purrdf-boundary",
            format!(
                "PurRDF {phase} reported {} semantic boundaries",
                certificate.boundaries().len()
            ),
        )),
    }
}

fn engine_refusal(reason: &'static str, code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal {
        reason,
        diagnostics: vec![Diagnostic {
            code,
            message: message.into(),
            axiom_ids: vec![],
        }],
    }
}

fn push_iri(builder: &mut RdfDatasetBuilder, subject: &str, predicate: &str, object: &str) {
    let subject = builder.intern_iri(subject);
    let predicate = builder.intern_iri(predicate);
    let object = builder.intern_iri(object);
    builder.push_quad(subject, predicate, object, None);
}

fn push_literal(
    builder: &mut RdfDatasetBuilder,
    subject: &str,
    predicate: &str,
    value: &Value,
) -> Result<(), String> {
    let literal = RdfLiteral {
        lexical_form: string(value, "lexicalForm")?.to_owned(),
        datatype: Some(string(value, "datatype")?.to_owned()),
        language: value
            .get("language")
            .and_then(Value::as_str)
            .map(str::to_owned),
        direction: None,
    };
    let subject = builder.intern_iri(subject);
    let predicate = builder.intern_iri(predicate);
    let object = builder.intern_literal(literal);
    builder.push_quad(subject, predicate, object, None);
    Ok(())
}

fn named_iri(expression: &Value) -> Result<&str, String> {
    if expression.get("kind").and_then(Value::as_str) != Some("NamedClass") {
        return Err("expression is not a named class".into());
    }
    string(expression, "iri")
}

fn initial_facts(axioms: &[Value]) -> (Vec<Value>, BTreeMap<String, Fact>) {
    let mut asserted = Vec::new();
    // The map provides exact-key lookup. The closure orders every choice with cmp_candidate.
    let mut facts = BTreeMap::new();
    for axiom in axioms {
        let id = axiom["id"].as_str().expect("preflight id");
        let Some((subject, predicate, object)) = atomic_axiom(axiom) else {
            continue;
        };
        let fact = Fact {
            subject: subject.clone(),
            predicate: predicate.clone(),
            object: object.clone(),
            premise_id: id.to_owned(),
        };
        facts
            .entry(fact_key(&subject, &predicate, &object))
            .or_insert(fact);
        if axiom["kind"] == "ClassAssertion" {
            let provenance = &axiom["provenance"];
            asserted.push(json!({
                "graph": {"kind": "DefaultGraph"},
                "id": format!("stmt:{id}"),
                "object": object,
                "predicate": predicate,
                "provenance": {"axiomId": id, "kind": "asserted", "sourceDigest": provenance["sourceDigest"], "sourceId": provenance["sourceId"]},
                "subject": subject
            }));
        }
    }
    (asserted, facts)
}

fn atomic_axiom(axiom: &Value) -> Option<(String, String, Value)> {
    match axiom.get("kind")?.as_str()? {
        "SubClassOf" => Some((
            named_iri(axiom.get("subClass")?).ok()?.to_owned(),
            RDFS_SUBCLASS.into(),
            Value::String(named_iri(axiom.get("superClass")?).ok()?.to_owned()),
        )),
        "ClassAssertion" => Some((
            axiom.get("individual")?.as_str()?.to_owned(),
            RDF_TYPE.into(),
            Value::String(named_iri(axiom.get("classExpression")?).ok()?.to_owned()),
        )),
        "ObjectPropertyAssertion" => Some((
            axiom.get("subject")?.as_str()?.to_owned(),
            axiom.get("property")?.as_str()?.to_owned(),
            axiom.get("object")?.clone(),
        )),
        "DataPropertyAssertion" | "AnnotationAssertion" => Some((
            axiom.get("subject")?.as_str()?.to_owned(),
            axiom.get("property")?.as_str()?.to_owned(),
            axiom.get("value")?.clone(),
        )),
        _ => None,
    }
}

fn fact_key(subject: &str, predicate: &str, object: &Value) -> String {
    format!("{subject}\0{predicate}\0{}", canonical_text(object))
}

fn statement_object_key_parts(object: &Value) -> Vec<&str> {
    if let Some(iri) = object.as_str() {
        return vec!["I:", iri];
    }
    vec![
        "L:",
        object
            .get("lexicalForm")
            .and_then(Value::as_str)
            .unwrap_or(""),
        ":",
        object.get("datatype").and_then(Value::as_str).unwrap_or(""),
        ":",
        object.get("language").and_then(Value::as_str).unwrap_or(""),
    ]
}

fn spo_key_parts<'a>(subject: &'a str, predicate: &'a str, object: &'a Value) -> Vec<&'a str> {
    let mut parts = vec![subject, "\0", predicate, "\0"];
    parts.extend(statement_object_key_parts(object));
    parts
}

fn statement_key_parts(statement: &Value) -> Vec<&str> {
    let mut parts = spo_key_parts(
        statement
            .get("subject")
            .and_then(Value::as_str)
            .unwrap_or(""),
        statement
            .get("predicate")
            .and_then(Value::as_str)
            .unwrap_or(""),
        statement.get("object").unwrap_or(&Value::Null),
    );
    parts.extend([
        "\0",
        statement.get("id").and_then(Value::as_str).unwrap_or(""),
    ]);
    parts
}

#[cfg(test)]
fn cmp_statement(left: &Value, right: &Value) -> Ordering {
    // This is exactly canonical.ts statementKey: graph and provenance are deliberately absent,
    // and object values are raw typed fields rather than serialized JSON.
    cmp_utf16_parts(&statement_key_parts(left), &statement_key_parts(right))
}

/// The UTF-16 code units of `parts` joined, whose slice order is `cmp_utf16_parts` order.
fn utf16_key(parts: &[&str]) -> Box<[u16]> {
    parts.iter().flat_map(|part| part.encode_utf16()).collect()
}

/// Sorts statements in `cmp_statement` order, building each statement's key once.
fn sort_statements(statements: &mut [Value]) {
    statements.sort_by_cached_key(|statement| utf16_key(&statement_key_parts(statement)));
}

fn cmp_statement_object_identity(left: &Value, right: &Value) -> Ordering {
    match (left.as_str(), right.as_str()) {
        (Some(left), Some(right)) => cmp_utf16(left, right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => cmp_utf16(
            left.get("lexicalForm")
                .and_then(Value::as_str)
                .unwrap_or(""),
            right
                .get("lexicalForm")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
        .then_with(|| {
            cmp_utf16(
                left.get("datatype").and_then(Value::as_str).unwrap_or(""),
                right.get("datatype").and_then(Value::as_str).unwrap_or(""),
            )
        })
        .then_with(|| {
            cmp_utf16(
                left.get("language").and_then(Value::as_str).unwrap_or(""),
                right.get("language").and_then(Value::as_str).unwrap_or(""),
            )
        }),
    }
}

fn candidate_key_parts(candidate: &Candidate) -> Vec<&str> {
    let mut parts = spo_key_parts(&candidate.subject, &candidate.predicate, &candidate.object);
    parts.extend(["\0", candidate.rule]);
    for premise in &candidate.premises {
        parts.extend(["\0", premise]);
    }
    parts
}

fn cmp_candidate(left: &Candidate, right: &Candidate) -> Ordering {
    // `order` holds `candidate_key_parts` as UTF-16, built once when the candidate is made.
    left.order.cmp(&right.order).then_with(|| {
        // The TypeScript raw object key is not injective because ':' is a field separator.
        // Distinguish such collisions structurally so BTreeSet never drops a different fact.
        cmp_statement_object_identity(&left.object, &right.object)
    })
}

fn add_candidate(
    candidates: &mut BTreeSet<Candidate>,
    subject: &str,
    predicate: &str,
    object: Value,
    rule: &'static str,
    premises: Vec<String>,
) {
    let key = fact_key(subject, predicate, &object);
    insert_candidate(candidates, key, subject, predicate, object, rule, premises);
}

fn insert_candidate(
    candidates: &mut BTreeSet<Candidate>,
    key: String,
    subject: &str,
    predicate: &str,
    object: Value,
    rule: &'static str,
    mut premises: Vec<String>,
) {
    sort_dedup_utf16(&mut premises);
    let mut candidate = Candidate {
        key,
        order: Box::default(),
        subject: subject.to_owned(),
        predicate: predicate.to_owned(),
        object,
        rule,
        premises,
    };
    candidate.order = utf16_key(&candidate_key_parts(&candidate));
    candidates.insert(candidate);
}

/// An individual asserted in two classes of one `DisjointClasses` axiom: the V1 certificate of
/// inconsistency, complete on its own.
fn direct_inconsistency(axioms: &[Value]) -> Option<Value> {
    // Class assertions in input order, and their positions per individual in the same order, so
    // the first witness found is the one the pairwise scan over all assertions would find.
    let mut assertions = Vec::new();
    for axiom in axioms
        .iter()
        .filter(|axiom| axiom["kind"] == "ClassAssertion")
    {
        assertions.push((
            axiom["id"].as_str()?,
            axiom["individual"].as_str()?,
            axiom["classExpression"]["iri"].as_str()?,
        ));
    }
    let mut by_individual: HashMap<&str, Vec<usize>> = HashMap::new();
    for (position, (_, individual, _)) in assertions.iter().enumerate() {
        by_individual.entry(individual).or_default().push(position);
    }
    for disjoint in axioms
        .iter()
        .filter(|axiom| axiom["kind"] == "DisjointClasses")
    {
        // Membership only: this set's iteration order is not observable.
        let classes: BTreeSet<_> = disjoint["classes"]
            .as_array()?
            .iter()
            .filter_map(|class| class["iri"].as_str())
            .collect();
        for &(left_id, individual, left_class) in &assertions {
            if !classes.contains(left_class) {
                continue;
            }
            for &position in &by_individual[individual] {
                let (right_id, _, right_class) = assertions[position];
                if right_id == left_id
                    || !classes.contains(right_class)
                    || right_class == left_class
                {
                    continue;
                }
                let mut ids = vec![
                    disjoint["id"].as_str()?.to_owned(),
                    left_id.to_owned(),
                    right_id.to_owned(),
                ];
                sort_dedup_utf16(&mut ids);
                return Some(
                    json!({"axiomIds": ids, "code": "disjoint-class-assertions", "message": "An individual is asserted in two disjoint classes", "severity": "error"}),
                );
            }
        }
    }
    None
}

fn bind_unsatisfiable(
    axioms: &[Value],
    facts: &BTreeMap<String, Fact>,
    purrdf_unsat: &[TermValue],
) -> Result<Vec<Value>, Refusal> {
    let mut expected: Vec<String> = purrdf_unsat
        .iter()
        .filter_map(TermValue::as_iri)
        .filter(|iri| *iri != OWL_NOTHING)
        .map(str::to_owned)
        .collect();
    sort_dedup_utf16(&mut expected);
    let mut items = Vec::new();
    for class in &expected {
        let mut proof = None;
        for disjoint in axioms
            .iter()
            .filter(|axiom| axiom["kind"] == "DisjointClasses")
        {
            let classes: Vec<&str> = disjoint["classes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["iri"].as_str().unwrap())
                .collect();
            for (left_index, left) in classes.iter().enumerate() {
                for right in classes.iter().skip(left_index + 1) {
                    let left_fact = facts.get(&fact_key(
                        class,
                        RDFS_SUBCLASS,
                        &Value::String((*left).to_owned()),
                    ));
                    let right_fact = facts.get(&fact_key(
                        class,
                        RDFS_SUBCLASS,
                        &Value::String((*right).to_owned()),
                    ));
                    if let (Some(left_fact), Some(right_fact)) = (left_fact, right_fact) {
                        let mut premises = vec![
                            disjoint["id"].as_str().unwrap().to_owned(),
                            left_fact.premise_id.clone(),
                            right_fact.premise_id.clone(),
                        ];
                        sort_dedup_utf16(&mut premises);
                        proof = Some(premises);
                        break;
                    }
                }
            }
        }
        let Some(premise_ids) = proof else {
            return Err(engine_refusal(
                "incomplete-certificate",
                "uncheckable-unsatisfiable-class",
                format!("PurRDF found {class} unsatisfiable without a V1 structural proof"),
            ));
        };
        items.push(json!({"classIri": class, "justificationDigest": format!("sha256:{}", "0".repeat(64)), "premiseIds": premise_ids}));
    }
    sort_unsatisfiable_classes(&mut items);
    Ok(items)
}

fn sort_unsatisfiable_classes(items: &mut [Value]) {
    items.sort_by(|left, right| {
        cmp_utf16(
            left["classIri"].as_str().unwrap_or(""),
            right["classIri"].as_str().unwrap_or(""),
        )
    });
}

/// The canonical justification document of one inferred statement (keys in sorted order).
#[derive(Serialize)]
struct JustificationInput<'a> {
    graph: &'a Value,
    id: &'a Value,
    object: &'a Value,
    predicate: &'a Value,
    #[serde(rename = "premiseIds")]
    premise_ids: &'a Value,
    rule: &'a Value,
    subject: &'a Value,
}

#[derive(Serialize)]
struct UnsatisfiableInput<'a> {
    #[serde(rename = "classIri")]
    class_iri: &'a Value,
    #[serde(rename = "premiseIds")]
    premise_ids: &'a Value,
}

#[derive(Serialize)]
struct InferredDigest<'a> {
    id: &'a Value,
    #[serde(rename = "justificationDigest")]
    justification_digest: &'a Value,
}

#[derive(Serialize)]
struct UnsatisfiableDigest<'a> {
    #[serde(rename = "classIri")]
    class_iri: &'a Value,
    #[serde(rename = "justificationDigest")]
    justification_digest: &'a Value,
}

/// The canonical justification document of one lemma (keys in sorted order).
#[derive(Serialize)]
struct LemmaInput<'a> {
    conclusion: &'a Value,
    id: &'a Value,
    #[serde(rename = "premiseIds")]
    premise_ids: &'a Value,
    rule: &'a Value,
}

#[derive(Serialize)]
struct AggregateJustification<'a> {
    inferred: Vec<InferredDigest<'a>>,
    /// Absent without lemmas, so a V1 answer's aggregate is the one proof checker v2 computed.
    #[serde(skip_serializing_if = "Option::is_none")]
    lemmas: Option<Vec<InferredDigest<'a>>>,
    #[serde(rename = "unsatisfiableClasses")]
    unsatisfiable_classes: Vec<UnsatisfiableDigest<'a>>,
}

/// Sets the justification digest of every inferred statement and unsatisfiable class.
fn bind_justifications(evidence: &mut Value) {
    if let Some(inferred) = evidence.get_mut("inferred").and_then(Value::as_array_mut) {
        for statement in inferred {
            let digest = sha256_json(&JustificationInput {
                graph: &statement["graph"],
                id: &statement["id"],
                object: &statement["object"],
                predicate: &statement["predicate"],
                premise_ids: &statement["provenance"]["premiseIds"],
                rule: &statement["provenance"]["rule"],
                subject: &statement["subject"],
            });
            statement["provenance"]["justificationDigest"] = Value::String(digest);
        }
    }
    if let Some(lemmas) = evidence.get_mut("lemmas").and_then(Value::as_array_mut) {
        for lemma in lemmas {
            let digest = sha256_json(&LemmaInput {
                conclusion: &lemma["conclusion"],
                id: &lemma["id"],
                premise_ids: &lemma["premiseIds"],
                rule: &lemma["rule"],
            });
            lemma["justificationDigest"] = Value::String(digest);
        }
    }
    if let Some(unsatisfiable) = evidence
        .get_mut("unsatisfiableClasses")
        .and_then(Value::as_array_mut)
    {
        for item in unsatisfiable {
            let digest = sha256_json(&UnsatisfiableInput {
                class_iri: &item["classIri"],
                premise_ids: &item["premiseIds"],
            });
            item["justificationDigest"] = Value::String(digest);
        }
    }
}

/// A decided evidence object encoded once. Its digest and the response are both assembled from
/// these bytes: the certificate's key sorts right after `asserted`, so the response is the
/// `asserted` array, then the certificate, then the members after it.
struct EncodedEvidence {
    /// The canonical `asserted` array.
    asserted: Vec<u8>,
    /// The canonical members after `asserted` (`"completeness":…` to the last), without braces.
    rest: Vec<u8>,
}

impl EncodedEvidence {
    /// Binds the justification digests, then encodes the evidence.
    fn new(evidence: &mut Value) -> Self {
        bind_justifications(evidence);
        let object = evidence.as_object().expect("decided evidence is an object");
        let asserted = serde_json::to_vec(&object["asserted"]).expect("JSON values serialize");
        let members: BTreeMap<&str, &Value> = object
            .iter()
            .filter(|(key, _)| key.as_str() != "asserted")
            .map(|(key, value)| (key.as_str(), value))
            .collect();
        let mut rest = serde_json::to_vec(&members).expect("JSON values serialize");
        rest.pop();
        rest.remove(0);
        Self { asserted, rest }
    }

    /// `sha256` of the canonical evidence and its LF: the certificate's output digest.
    fn digest(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"{\"asserted\":");
        hasher.update(&self.asserted);
        hasher.update(b",");
        hasher.update(&self.rest);
        hasher.update(b"}\n");
        format!("sha256:{:x}", hasher.finalize())
    }

    /// Appends the canonical result: the evidence with `certificate` in its sorted place.
    fn write_with_certificate(&self, certificate: &Value, out: &mut Vec<u8>) {
        out.extend_from_slice(b"{\"asserted\":");
        out.extend_from_slice(&self.asserted);
        out.extend_from_slice(b",\"certificate\":");
        serde_json::to_writer(&mut *out, certificate).expect("JSON values serialize");
        out.extend_from_slice(b",");
        out.extend_from_slice(&self.rest);
        out.extend_from_slice(b"}");
    }

    #[cfg(test)]
    fn with_certificate(&self, certificate: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        self.write_with_certificate(certificate, &mut out);
        out
    }
}

/// The certificate binding decided evidence to its request, calculus and proof checker.
fn certificate(request: &Request, evidence: &Value, encoded: &EncodedEvidence) -> Value {
    let items = |key: &str| evidence[key].as_array().expect("decided evidence arrays");
    let aggregate = AggregateJustification {
        inferred: items("inferred")
            .iter()
            .map(|statement| InferredDigest {
                id: &statement["id"],
                justification_digest: &statement["provenance"]["justificationDigest"],
            })
            .collect(),
        lemmas: evidence
            .get("lemmas")
            .and_then(Value::as_array)
            .filter(|lemmas| !lemmas.is_empty())
            .map(|lemmas| {
                lemmas
                    .iter()
                    .map(|lemma| InferredDigest {
                        id: &lemma["id"],
                        justification_digest: &lemma["justificationDigest"],
                    })
                    .collect()
            }),
        unsatisfiable_classes: items("unsatisfiableClasses")
            .iter()
            .map(|item| UnsatisfiableDigest {
                class_iri: &item["classIri"],
                justification_digest: &item["justificationDigest"],
            })
            .collect(),
    };
    let mut certificate = json!({
        "calculusDigest": request.required_tool.calculus_digest,
        "checked": true,
        "checkerName": "erden-reasoner-proof-binder",
        "checkerVersion": "1",
        "decision": "Decided",
        "inputDigest": request.ontology.digest,
        "justificationDigest": sha256_json(&aggregate),
        "outputDigest": encoded.digest(),
        "proofCheckerDigest": PROOF_CHECKER_DIGEST,
        "proofCheckerId": PROOF_CHECKER_ID
    });
    certificate["certificateDigest"] = Value::String(sha256_json(&certificate));
    certificate
}

/// The canonical response to a decided request, encoded once, with its LF.
///
/// Equal byte for byte to `canonical_bytes(&response_value(…))` of the result with its
/// certificate (a test pins it); the response's keys are written in their sorted order.
fn encode_decided(request: &Request, tool: &Tool, mut evidence: Value) -> Vec<u8> {
    let encoded = EncodedEvidence::new(&mut evidence);
    let certificate = certificate(request, &evidence, &encoded);
    // Like the request in `run`, the evidence is left for the process exit to reclaim.
    std::mem::forget(evidence);
    phase!("binding");
    let mut out = Vec::with_capacity(encoded.asserted.len() + encoded.rest.len() + 4_096);
    out.extend_from_slice(b"{\"inputDigest\":");
    serde_json::to_writer(&mut out, &request.ontology.digest).expect("strings serialize");
    out.extend_from_slice(b",\"kind\":\"ReasonerResponse\",\"profile\":");
    serde_json::to_writer(
        &mut out,
        &json!({"digest": PROFILE_DIGEST, "id": PROFILE_ID}),
    )
    .expect("JSON values serialize");
    out.extend_from_slice(
        format!(",\"protocolVersion\":{PROTOCOL_VERSION},\"requestId\":").as_bytes(),
    );
    serde_json::to_writer(&mut out, &request.request_id).expect("strings serialize");
    out.extend_from_slice(b",\"result\":");
    encoded.write_with_certificate(&certificate, &mut out);
    out.extend_from_slice(b",\"tool\":");
    serde_json::to_writer(&mut out, &tool_value(tool)).expect("JSON values serialize");
    out.extend_from_slice(b"}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_fixture(name: &str) -> Request {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("protocol")
            .join("fixtures")
            .join("known-answer")
            .join(format!("{name}.request.json"));
        serde_json::from_slice(&fs::read(root).expect("fixture bytes")).expect("fixture request")
    }

    #[test]
    fn utf16_comparator_matches_javascript_code_unit_order_table() {
        let cases = [
            ("", "", Ordering::Equal),
            ("a", "aa", Ordering::Less),
            ("aa", "a", Ordering::Greater),
            (
                "https://x.test/😀",
                "https://x.test/\u{e000}",
                Ordering::Less,
            ),
            ("prefix😀z", "prefix\u{e000}a", Ordering::Less),
            ("prefix\u{e000}a", "prefix😀z", Ordering::Greater),
            ("same😀", "same😀", Ordering::Equal),
        ];
        for (left, right, expected) in cases {
            assert_eq!(
                cmp_utf16(left, right),
                expected,
                "{left:?} versus {right:?}"
            );
        }
    }

    #[test]
    fn utf16_comparator_is_antisymmetric_and_transitive_for_protocol_samples() {
        let samples = [
            "",
            "a",
            "a😀",
            "a\u{e000}",
            "https://x.test/😀",
            "https://x.test/\u{e000}",
            "\u{10000}",
            "\u{10ffff}",
        ];
        for left in samples {
            for right in samples {
                assert_eq!(cmp_utf16(left, right), cmp_utf16(right, left).reverse());
                for third in samples {
                    if cmp_utf16(left, right) != Ordering::Greater
                        && cmp_utf16(right, third) != Ordering::Greater
                    {
                        assert_ne!(cmp_utf16(left, third), Ordering::Greater);
                    }
                }
            }
        }
    }

    #[test]
    fn strict_order_uses_utf16_and_still_rejects_duplicates() {
        let canonical = ["https://x.test/😀", "https://x.test/\u{e000}"];
        strictly_sorted_unique(&canonical, "counterexample").expect("JavaScript order");
        assert!(strictly_sorted_unique(&[canonical[1], canonical[0]], "counterexample").is_err());
        assert!(strictly_sorted_unique(&[canonical[0], canonical[0]], "duplicate").is_err());

        let mut values = vec![canonical[1].to_owned(), canonical[0].to_owned()];
        sort_utf16(&mut values);
        assert_eq!(values, canonical);
    }

    fn test_statement(id: &str, object: Value) -> Value {
        json!({
            "graph": {"kind": "DefaultGraph"},
            "id": id,
            "object": object,
            "predicate": "https://p.test/value",
            "subject": "https://s.test/item"
        })
    }

    fn test_literal(lexical_form: &str, datatype: &str, language: Option<&str>) -> Value {
        json!({
            "datatype": datatype,
            "kind": "Literal",
            "language": language,
            "lexicalForm": lexical_form
        })
    }

    #[test]
    fn statement_order_matches_raw_typescript_key_for_hostile_valid_strings() {
        let mut iri_statements = [
            test_statement("stmt:hash", json!("https://o.test/a#")),
            test_statement("stmt:backslash", json!("https://o.test/a\\")),
            test_statement("stmt:quote", json!("https://o.test/a\"")),
        ];
        iri_statements.sort_by(cmp_statement);
        assert_eq!(
            iri_statements
                .iter()
                .map(|statement| statement["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["stmt:quote", "stmt:hash", "stmt:backslash"]
        );

        let datatype = "https://types.test/string";
        let mut literal_statements = [
            test_statement("stmt:private", test_literal("\u{e000}", datatype, None)),
            test_statement("stmt:astral", test_literal("😀", datatype, None)),
            test_statement("stmt:backslash", test_literal("\\", datatype, None)),
            test_statement("stmt:quote", test_literal("\"", datatype, None)),
            test_statement("stmt:control", test_literal("\u{1}", datatype, None)),
        ];
        literal_statements.sort_by(cmp_statement);
        assert_eq!(
            literal_statements
                .iter()
                .map(|statement| statement["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "stmt:control",
                "stmt:quote",
                "stmt:backslash",
                "stmt:astral",
                "stmt:private"
            ]
        );

        let mut typed = [
            test_statement("stmt:literal", test_literal("", datatype, None)),
            test_statement("stmt:iri", json!("https://o.test/value")),
        ];
        typed.sort_by(cmp_statement);
        assert_eq!(typed[0]["id"], "stmt:iri");
    }

    #[test]
    fn statement_order_honors_composite_boundaries_and_ties_exactly() {
        let datatype = "https://types.test/string";

        // lexicalForm permits controls. The embedded NUL is part of TypeScript's raw key,
        // so comparing lexicalForm as an isolated tuple field would produce the wrong order.
        let plain = test_statement("z", test_literal("a", datatype, None));
        let nul = test_statement("a", test_literal("a\0", datatype, None));
        assert_eq!(cmp_statement(&nul, &plain), Ordering::Less);

        let null_language = test_statement("same", test_literal("x", datatype, None));
        let english = test_statement("same", test_literal("x", datatype, Some("en")));
        assert_eq!(cmp_statement(&null_language, &english), Ordering::Less);

        let quote_datatype =
            test_statement("same", test_literal("x", "https://types.test/a\"", None));
        let hash_datatype =
            test_statement("same", test_literal("x", "https://types.test/a#", None));
        assert_eq!(
            cmp_statement(&quote_datatype, &hash_datatype),
            Ordering::Less
        );

        let first_id = test_statement("stmt:1", test_literal("same", datatype, None));
        let second_id = test_statement("stmt:2", test_literal("same", datatype, None));
        assert_eq!(cmp_statement(&first_id, &second_id), Ordering::Less);

        // These distinct literals intentionally collide in canonical.ts's colon-delimited
        // object key. With the same id, the protocol comparator must report equality.
        let collision_left = test_statement("same", test_literal("a:b", "c:x", None));
        let collision_right = test_statement("same", test_literal("a", "b:c:x", None));
        assert_eq!(
            cmp_statement(&collision_left, &collision_right),
            Ordering::Equal
        );

        let mut other_graph = first_id.clone();
        other_graph["graph"] = json!({"iri": "https://g.test/ignored", "kind": "NamedGraph"});
        assert_eq!(cmp_statement(&first_id, &other_graph), Ordering::Equal);
    }

    #[test]
    fn internal_fact_and_candidate_order_never_uses_json_escaping() {
        let quote = Value::String("https://o.test/a\"".into());
        let hash = Value::String("https://o.test/a#".into());
        let left = Fact {
            subject: "https://s.test/item".into(),
            predicate: "https://p.test/value".into(),
            object: quote.clone(),
            premise_id: "a1".into(),
        };

        let mut candidates = BTreeSet::new();
        add_candidate(
            &mut candidates,
            &left.subject,
            &left.predicate,
            hash,
            "rule",
            vec!["a1".into()],
        );
        add_candidate(
            &mut candidates,
            &left.subject,
            &left.predicate,
            quote,
            "rule",
            vec!["a1".into()],
        );
        let ordered: Vec<_> = candidates.into_iter().collect();
        assert_eq!(ordered[0].object, "https://o.test/a\"");

        let mut collisions = BTreeSet::new();
        add_candidate(
            &mut collisions,
            &left.subject,
            &left.predicate,
            test_literal("a:b", "c:x", None),
            "rule",
            vec!["a1".into()],
        );
        add_candidate(
            &mut collisions,
            &left.subject,
            &left.predicate,
            test_literal("a", "b:c:x", None),
            "rule",
            vec!["a1".into()],
        );
        assert_eq!(
            collisions.len(),
            2,
            "raw-key collisions must not drop facts"
        );
    }

    #[test]
    fn diagnostic_order_matches_the_full_typescript_key_with_controls() {
        let plain = Diagnostic {
            code: "hostile",
            message: "a".into(),
            axiom_ids: vec!["z".into()],
        };
        let nul = Diagnostic {
            code: "hostile",
            message: "a\0".into(),
            axiom_ids: vec!["a".into()],
        };
        assert_eq!(cmp_diagnostic(&nul, &plain), Ordering::Less);

        let quote = Diagnostic {
            code: "hostile",
            message: "\"".into(),
            axiom_ids: vec![],
        };
        let hash = Diagnostic {
            code: "hostile",
            message: "#".into(),
            axiom_ids: vec![],
        };
        assert_eq!(cmp_diagnostic(&quote, &hash), Ordering::Less);
    }

    #[test]
    fn class_expression_keys_match_typescript_json_stringify_order() {
        let expressions = [
            json!({"canonicalForm":"opaque\u{1}\n\"\\😀\u{e000}","constructIri":"https://c.test/value","kind":"OpaqueClassExpression"}),
            json!({"iri":"https://n.test/value","kind":"NamedClass"}),
            json!({"kind":"ObjectUnionOf","operands":["https://u.test/😀","https://u.test/\u{e000}"]}),
            json!({"expressionId":"expr:1","kind":"CyclicClassExpression"}),
        ];
        let mut keyed: Vec<_> = expressions
            .iter()
            .map(|expression| {
                (
                    expression["kind"].as_str().unwrap(),
                    class_expression_key(expression).unwrap(),
                )
            })
            .collect();
        keyed.sort_by(|left, right| cmp_utf16(&left.1, &right.1));
        assert_eq!(
            keyed.iter().map(|item| item.0).collect::<Vec<_>>(),
            [
                "CyclicClassExpression",
                "NamedClass",
                "ObjectUnionOf",
                "OpaqueClassExpression"
            ]
        );
        assert_eq!(
            class_expression_key(&expressions[0]).unwrap(),
            "{\"kind\":\"OpaqueClassExpression\",\"constructIri\":\"https://c.test/value\",\"canonicalForm\":\"opaque\\u0001\\n\\\"\\\\😀\u{e000}\"}"
        );

        let quote = json!({"iri":"https://n.test/a\"","kind":"NamedClass"});
        let hash = json!({"iri":"https://n.test/a#","kind":"NamedClass"});
        // JSON.stringify deliberately escapes the quote, so hash precedes quote for expression
        // keys (unlike the raw statement object key tested above).
        assert_eq!(
            cmp_utf16(
                &class_expression_key(&hash).unwrap(),
                &class_expression_key(&quote).unwrap()
            ),
            Ordering::Less
        );
    }

    #[test]
    fn every_semantic_response_array_uses_utf16_order() {
        let emoji = "https://x.test/😀";
        let private = "https://x.test/\u{e000}";

        let mut statements = [
            json!({"id":"stmt:2","object":private,"predicate":"https://x.test/p","subject":emoji}),
            json!({"id":"stmt:1","object":emoji,"predicate":"https://x.test/p","subject":emoji}),
            json!({"id":"stmt:3","object":emoji,"predicate":"https://x.test/p","subject":private}),
        ];
        statements.sort_by(cmp_statement);
        assert_eq!(
            statements
                .iter()
                .map(|item| (
                    item["subject"].as_str().unwrap(),
                    item["object"].as_str().unwrap()
                ))
                .collect::<Vec<_>>(),
            vec![(emoji, emoji), (emoji, private), (private, emoji)]
        );

        let mut unsatisfiable = vec![
            json!({"classIri":private,"premiseIds":[]}),
            json!({"classIri":emoji,"premiseIds":[]}),
        ];
        sort_unsatisfiable_classes(&mut unsatisfiable);
        assert_eq!(unsatisfiable[0]["classIri"], emoji);

        let refusal = refused_value(Refusal {
            reason: "unsupported-construct",
            diagnostics: vec![
                Diagnostic {
                    code: "unicode",
                    message: private.into(),
                    axiom_ids: vec![private.into(), emoji.into(), emoji.into()],
                },
                Diagnostic {
                    code: "unicode",
                    message: emoji.into(),
                    axiom_ids: vec![],
                },
            ],
        });
        let diagnostics = refusal["diagnostics"].as_array().unwrap();
        assert_eq!(diagnostics[0]["message"], emoji);
        assert_eq!(diagnostics[1]["axiomIds"], json!([emoji, private]));

        let mut candidates = BTreeSet::new();
        add_candidate(
            &mut candidates,
            private,
            "https://x.test/p",
            Value::String(emoji.into()),
            "rule",
            vec![private.into(), emoji.into(), emoji.into()],
        );
        add_candidate(
            &mut candidates,
            emoji,
            "https://x.test/p",
            Value::String(private.into()),
            "rule",
            vec![],
        );
        let ordered: Vec<_> = candidates.into_iter().collect();
        assert_eq!(ordered[0].subject, emoji);
        assert_eq!(ordered[1].premises, vec![emoji, private]);
    }

    #[test]
    fn semantic_input_arrays_accept_javascript_utf16_order() {
        let emoji = "https://x.test/😀";
        let private = "https://x.test/\u{e000}";
        let mut union = request_fixture("current-demo-constructs");
        union.ontology.axioms[2]["domain"]["operands"] = json!([emoji, private]);
        validate_semantic_order(&union).expect("canonical union operand order");
        union.ontology.axioms[2]["domain"]["operands"] = json!([private, emoji]);
        assert!(validate_semantic_order(&union).is_err());

        let mut equivalence = request_fixture("equivalence");
        equivalence.ontology.axioms[0]["classes"] = json!([
            {"iri":emoji,"kind":"NamedClass"},
            {"iri":private,"kind":"NamedClass"}
        ]);
        validate_semantic_order(&equivalence).expect("canonical expression order");
        equivalence.ontology.axioms[0]["classes"] = json!([
            {"iri":private,"kind":"NamedClass"},
            {"iri":emoji,"kind":"NamedClass"}
        ]);
        assert!(validate_semantic_order(&equivalence).is_err());

        let quote = "https://x.test/a\"";
        let hash = "https://x.test/a#";
        equivalence.ontology.axioms[0]["classes"] = json!([
            {"iri":hash,"kind":"NamedClass"},
            {"iri":quote,"kind":"NamedClass"}
        ]);
        validate_semantic_order(&equivalence).expect("JSON.stringify expression order");
        equivalence.ontology.axioms[0]["classes"]
            .as_array_mut()
            .unwrap()
            .reverse();
        assert!(validate_semantic_order(&equivalence).is_err());
    }

    /// The PurRDF version and commit the identity names are the ones Cargo resolved: every
    /// `purrdf-*` package in the committed lock file is that version from that commit, and the
    /// calculus contract and tool version name the same pair.
    #[test]
    fn identity_binds_the_exact_purrdf_source() {
        const PURRDF_VERSION: &str = "0.12.0";
        const PURRDF_SOURCE: &str = "https://github.com/Blackcat-Informatics/purrdf";
        let tool = actual_tool().expect("identity");
        assert_eq!(tool.name, TOOL_NAME);
        assert!(is_digest(&tool.executable_digest));
        assert!(is_digest(&tool.adapter_digest));
        assert!(is_digest(&tool.calculus_digest));

        let lock = include_str!("../../Cargo.lock");
        let expected_source = format!("git+{PURRDF_SOURCE}?rev={PURRDF_COMMIT}#{PURRDF_COMMIT}");
        let mut resolved = Vec::new();
        for package in lock.split("[[package]]").skip(1) {
            let field = |key: &str| {
                package.lines().find_map(|line| {
                    line.strip_prefix(key)
                        .and_then(|rest| rest.strip_prefix(" = \""))
                        .and_then(|rest| rest.strip_suffix('"'))
                })
            };
            let name = field("name").expect("every locked package has a name");
            if !name.starts_with("purrdf") {
                continue;
            }
            assert_eq!(field("version"), Some(PURRDF_VERSION), "{name} version");
            assert_eq!(
                field("source"),
                Some(expected_source.as_str()),
                "{name} source"
            );
            resolved.push(name);
        }
        for crate_name in ["purrdf-core", "purrdf-entail"] {
            assert!(resolved.contains(&crate_name), "{crate_name} is locked");
        }

        assert!(CALCULUS_CONTRACT.starts_with(&format!(
            "purrdf-entail={PURRDF_VERSION}\nsource={PURRDF_SOURCE}\nrev={PURRDF_COMMIT}\n"
        )));
        assert!(
            TOOL_VERSION.ends_with(&format!("+purrdf.{PURRDF_VERSION}.{}", &PURRDF_COMMIT[..7]))
        );
    }

    fn fixture_bytes(name: &str) -> Vec<u8> {
        fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../protocol/fixtures/known-answer")
                .join(format!("{name}.request.json")),
        )
        .expect("fixture bytes")
    }

    const FIXTURES: [&str; 13] = [
        "current-demo-constructs",
        "disjointness",
        "domain-range",
        "equivalence",
        "inconsistency",
        "inverse-transitive-properties",
        "pur-rdf-bottom-data-property",
        "pur-rdf-bottom-object-property",
        "pur-rdf-cyclic-expression",
        "pur-rdf-thing-nothing-empty-domain",
        "subclass-type",
        "unsatisfiable-classes",
        "unsupported-constructs",
    ];

    #[test]
    fn serde_json_objects_serialize_with_sorted_keys() {
        // Canonical encoding relies on serde_json's BTreeMap-backed objects; enabling the
        // `preserve_order` feature anywhere in the build would break it, and this test.
        let mut object = serde_json::Map::new();
        object.insert("zeta".into(), json!(1));
        object.insert("alpha".into(), json!({"y": 2, "b": 3}));
        assert_eq!(
            serde_json::to_string(&Value::Object(object)).unwrap(),
            r#"{"alpha":{"b":3,"y":2},"zeta":1}"#
        );
    }

    #[test]
    fn the_input_digest_hashed_from_the_wire_equals_the_canonical_digest() {
        for name in FIXTURES {
            let bytes = fixture_bytes(name);
            let parsed = parse_request(&bytes).expect("fixture parses");
            assert_eq!(
                parsed.input_digest,
                input_digest(
                    &parsed.request.ontology.sources,
                    &parsed.request.ontology.axioms
                ),
                "{name}"
            );
            assert_eq!(
                parsed.input_digest, parsed.request.ontology.digest,
                "{name}"
            );
            assert_eq!(
                wall_time_limit_ms(&bytes).expect("limit"),
                parsed.request.limits.max_wall_time_ms
            );
            assert_eq!(
                canonical_prefix_wall_time_ms(&bytes),
                Some(parsed.request.limits.max_wall_time_ms),
                "{name}: the budget is read from the canonical prefix"
            );
        }
    }

    #[test]
    fn non_canonical_requests_are_still_refused_as_such() {
        let bytes = fixture_bytes("subclass-type");
        let text = String::from_utf8(bytes.clone()).unwrap();
        // Whitespace in the envelope, outside the arrays the digest covers.
        let spaced = text.replacen("\"kind\":", "\"kind\": ", 1);
        assert_eq!(
            parse_request(spaced.as_bytes()).err().as_deref(),
            Some("request is not canonical JSON")
        );
        // Reordered keys inside an axiom change the bytes the digest covers.
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let axiom = &value["ontology"]["axioms"][0];
        let canonical = serde_json::to_string(axiom).unwrap();
        let reordered = format!(
            "{{\"subClass\":{},{}",
            serde_json::to_string(&axiom["subClass"]).unwrap(),
            canonical[1..].replacen(
                &format!(
                    ",\"subClass\":{}",
                    serde_json::to_string(&axiom["subClass"]).unwrap()
                ),
                "",
                1
            )
        );
        assert_ne!(reordered, canonical);
        let shuffled = text.replacen(&canonical, &reordered, 1);
        assert_eq!(
            parse_request(shuffled.as_bytes()).err().as_deref(),
            Some("request is not canonical JSON")
        );
        // The same arrays under a digest of exactly their bytes are not encoded again: the answer
        // binds that digest, which is not the canonical digest of the ontology, so the consumer's
        // own digest of the request it encoded refuses it (`input-digest`).
        let spaced = shuffled.replacen("\"axioms\":[{", "\"axioms\":[ {", 1);
        let wire: WireRequest<'_> = serde_json::from_str(spaced.trim_end()).unwrap();
        let claimed = spaced.replacen(&wire.ontology.digest, &raw_input_digest(&wire.ontology), 1);
        let parsed = parse_request(claimed.as_bytes()).expect("the digest covers these bytes");
        assert_eq!(parsed.input_digest, parsed.request.ontology.digest);
        assert_ne!(
            parsed.input_digest,
            input_digest(
                &parsed.request.ontology.sources,
                &parsed.request.ontology.axioms
            )
        );
        // Leading zeros and other prefixes fall back to the full parse, which names the error.
        let padded = text.replacen("\"maxWallTimeMs\":", "\"maxWallTimeMs\":0", 1);
        assert!(canonical_prefix_wall_time_ms(padded.as_bytes()).is_none());
        assert!(wall_time_limit_ms(padded.as_bytes()).is_err());
        assert!(wall_time_limit_ms(b"{}\n").is_err());
    }

    #[test]
    fn a_canonical_request_with_a_wrong_digest_is_answered_input_digest_incompatible() {
        let bytes = fixture_bytes("subclass-type");
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value["ontology"]["digest"] = json!(format!("sha256:{}", "1".repeat(64)));
        let parsed = parse_request(&canonical_bytes(&value)).expect("still canonical");
        assert_ne!(parsed.input_digest, parsed.request.ontology.digest);
    }

    #[test]
    fn the_decided_response_is_encoded_once_and_equals_its_canonical_value() {
        for name in FIXTURES {
            let parsed = parse_request(&fixture_bytes(name)).expect("fixture");
            let request = &parsed.request;
            let Ok(used) = preflight(request) else {
                continue;
            };
            let tool = Tool {
                name: TOOL_NAME.into(),
                version: TOOL_VERSION.into(),
                executable_digest: format!("sha256:{}", "e".repeat(64)),
                adapter_digest: sha256_bytes(ADAPTER_CONTRACT.as_bytes()),
                calculus_digest: sha256_bytes(CALCULUS_CONTRACT.as_bytes()),
            };
            let Ok(evidence) = decide(request, Instant::now(), &used) else {
                continue;
            };
            let encoded = encode_decided(request, &tool, evidence);
            let result = reason(request, Instant::now());
            assert_eq!(
                encoded,
                canonical_bytes(&response_value(request, &tool, result.clone())),
                "{name}"
            );
            let mut evidence = result.clone();
            let certificate = evidence
                .as_object_mut()
                .unwrap()
                .remove("certificate")
                .unwrap();
            assert_eq!(
                certificate["outputDigest"],
                json!(sha256_json(&evidence)),
                "{name}"
            );
            let mut unsigned = certificate.clone();
            unsigned
                .as_object_mut()
                .unwrap()
                .remove("certificateDigest");
            assert_eq!(
                certificate["certificateDigest"],
                json!(sha256_json(&unsigned))
            );
        }
    }

    #[test]
    fn canonical_hash_includes_the_wire_lf() {
        assert_eq!(
            sha256_json(&json!({})),
            "sha256:ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356"
        );
    }

    #[test]
    fn request_id_accepts_1024_ascii_bytes_and_rejects_boundary_plus_one() {
        let mut request = request_fixture("subclass-type");
        request.request_id = format!("r{}", "a".repeat(MAX_REASONER_REQUEST_ID_BYTES - 1));
        validate_envelope(&request).expect("1024-byte requestId must be valid");
        request.request_id.push('a');
        assert!(validate_envelope(&request).is_err());
    }

    #[test]
    fn structural_closure_is_multihop_and_not_fixture_bound() {
        let source = json!({"locator":"mutated.ttl", "sourceDigest": format!("sha256:{}", "a".repeat(64)), "sourceId":"source:mutated", "status":"available"});
        let graph = json!({"kind":"DefaultGraph"});
        let axioms = vec![
            json!({"graph":graph,"id":"x1","kind":"SubClassOf","provenance":source,"subClass":{"iri":"https://mutated.test/C1","kind":"NamedClass"},"superClass":{"iri":"https://mutated.test/C2","kind":"NamedClass"}}),
            json!({"graph":{"kind":"DefaultGraph"},"id":"x2","kind":"SubClassOf","provenance":{"locator":"mutated.ttl","sourceDigest":format!("sha256:{}", "a".repeat(64)),"sourceId":"source:mutated","status":"available"},"subClass":{"iri":"https://mutated.test/C2","kind":"NamedClass"},"superClass":{"iri":"https://mutated.test/C3","kind":"NamedClass"}}),
            json!({"classExpression":{"iri":"https://mutated.test/C1","kind":"NamedClass"},"graph":{"kind":"DefaultGraph"},"id":"x3","individual":"https://mutated.test/i","kind":"ClassAssertion","provenance":{"locator":"mutated.ttl","sourceDigest":format!("sha256:{}", "a".repeat(64)),"sourceId":"source:mutated","status":"available"}}),
        ];
        let (_, mut facts) = initial_facts(&axioms);
        let inferred = engine::close_facts(&axioms, &mut facts, 100).expect("closure");
        assert!(
            inferred
                .iter()
                .any(|item| item["subject"] == "https://mutated.test/C1"
                    && item["predicate"] == RDFS_SUBCLASS
                    && item["object"] == "https://mutated.test/C3")
        );
        assert!(
            inferred
                .iter()
                .any(|item| item["subject"] == "https://mutated.test/i"
                    && item["predicate"] == RDF_TYPE
                    && item["object"] == "https://mutated.test/C3")
        );
    }

    #[test]
    fn union_domain_never_invents_a_member_type() {
        let axiom = json!({"domain":{"kind":"ObjectUnionOf","operands":["https://u.test/A","https://u.test/B"]},"graph":{"kind":"DefaultGraph"},"id":"u1","kind":"PropertyDomain","property":"https://u.test/p","propertyKind":"DataProperty","provenance":{"locator":"u.ttl","sourceDigest":format!("sha256:{}", "a".repeat(64)),"sourceId":"source:u","status":"available"}});
        let assertion = json!({"graph":{"kind":"DefaultGraph"},"id":"u2","kind":"DataPropertyAssertion","property":"https://u.test/p","provenance":{"locator":"u.ttl","sourceDigest":format!("sha256:{}", "a".repeat(64)),"sourceId":"source:u","status":"available"},"subject":"https://u.test/i","value":{"datatype":"http://www.w3.org/2001/XMLSchema#string","kind":"Literal","language":null,"lexicalForm":"x"}});
        let axioms = vec![axiom, assertion];
        let (_, mut facts) = initial_facts(&axioms);
        assert!(
            engine::close_facts(&axioms, &mut facts, 100)
                .expect("closure")
                .is_empty()
        );
    }

    #[test]
    fn all_four_purrdf_divergences_stop_in_independent_preflight() {
        let cases = [
            ("pur-rdf-bottom-object-property", "bottom-property"),
            ("pur-rdf-bottom-data-property", "bottom-property"),
            ("pur-rdf-cyclic-expression", "cyclic-expression"),
            ("pur-rdf-thing-nothing-empty-domain", "known-divergence"),
        ];
        for (fixture, expected_reason) in cases {
            let refusal = preflight(&request_fixture(fixture)).expect_err("must refuse");
            assert_eq!(refusal.reason, expected_reason);
        }
    }

    #[test]
    fn every_profile_exclusion_category_is_detected_before_reasoning() {
        let unsupported =
            preflight(&request_fixture("unsupported-constructs")).expect_err("must refuse");
        assert_eq!(unsupported.reason, "unsupported-construct");
        let codes: BTreeSet<_> = unsupported
            .diagnostics
            .iter()
            .map(|item| item.code)
            .collect();
        assert!(codes.contains("unsupported-import"));
        assert!(codes.contains("unsupported-opaque-axiom"));
        assert!(codes.contains("named-graph"));
        assert!(codes.contains("missing-provenance"));

        let mut unknown = request_fixture("current-demo-constructs");
        unknown.ontology.axioms[0]["iri"] =
            Value::String("http://www.w3.org/2002/07/owl#hasKey".into());
        let refusal = preflight(&unknown).expect_err("unknown reserved term must refuse");
        assert_eq!(refusal.reason, "unknown-reserved-term");

        let mut over_budget = request_fixture("subclass-type");
        over_budget.limits.max_input_axioms = 1;
        assert_eq!(
            preflight(&over_budget).expect_err("budget").reason,
            "budget-exhausted"
        );
    }

    #[test]
    fn the_complete_demo_allowlist_passes_preflight() {
        preflight(&request_fixture("current-demo-constructs")).expect("demo profile");
    }

    #[test]
    fn reserved_namespace_checks_are_typed_and_prefix_only() {
        let mut custom = request_fixture("subclass-type");
        let embedded = "https://custom.test/path/http://www.w3.org/2002/07/owl#hasKey";
        custom.ontology.sources[0]["ontologyIri"] = Value::String(embedded.into());
        custom.ontology.axioms[0]["subClass"]["iri"] = Value::String(embedded.into());
        custom.ontology.axioms[0]["provenance"]["locator"] =
            Value::String("http://www.w3.org/2002/07/owl#hasKey is locator text".into());
        preflight(&custom).expect("embedded reserved namespace text is a custom IRI");

        custom.ontology.sources[0]["ontologyIri"] =
            Value::String("http://www.w3.org/2002/07/owl#hasKey".into());
        let refusal = preflight(&custom).expect_err("reserved source IRI must refuse");
        assert_eq!(refusal.reason, "unknown-reserved-term");
    }
}
