//! `erden-shacl`: Erden's pinned SHACL validator, a thin protocol adapter around PurRDF's `purrdf-shapes`.
//!
//! One request is one JSON object on one line: a shapes graph and one or more data graphs, each as N-Triples text with
//! its SHA-256. One answer is one JSON object on one line: per data graph, the engine's verdict and every result with
//! focus node, path, value, constraint component, source shape, severity and messages, or a structured refusal. The
//! wire format is `erden.shacl/v1` (`packages/ontology/src/shacl-engine/protocol.ts` is the TypeScript side, and
//! `docs/projects/shacl-engine/epics/E1-erden-shacl.md` the contract).
//!
//! The adapter adds no SHACL semantics of its own: shapes are parsed by `purrdf_shapes::shapes::from_dataset_with_base`
//! with no import table and every data graph is validated by `purrdf_shapes::engine::validate_dataset` with the
//! engine's default options. It binds every answer to the bytes it read (their SHA-256), to its own identity and to the
//! executable that answered.

use std::collections::{HashMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, OnceLock};

use purrdf_shapes::ShapesImports;
use purrdf_shapes::report::{ValidationReport, ValidationResult};
use purrdf_shapes::shapes::{Path, Shapes};
use purrdf_shapes::term::Term;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const TOOL_NAME: &str = "erden-shacl";
pub const TOOL_VERSION: &str = "0.1.0+purrdf.3.0.1";
pub const PROTOCOL_VERSION: u32 = 1;
/// The largest request or answer line, in bytes, newline included.
pub const MAX_WIRE_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_REQUEST_ID_BYTES: usize = 1_024;
pub const MAX_GRAPHS: usize = 4_096;
pub const MAX_GRAPH_ID_BYTES: usize = 256;
/// Compiled shapes graphs a long-lived session keeps, least recently used first out.
pub const SESSION_SHAPES_CACHE: usize = 8;

/// The SHA-256 of `shacl/Cargo.lock`, the exact dependency closure this engine identity names. A test recomputes it.
pub const CARGO_LOCK_SHA256: &str =
    "sha256:4f85d22854b0747423c286fd019533a6caf08a9dc3d4770ddbb637d307713244";

/// What this engine is, as one canonical document; its SHA-256 is the `engineDigest` every answer carries. It changes
/// exactly when the protocol, the adapter's contract or the engine's dependency closure changes, and is the same on
/// every platform (the executable digest is the per-platform identity).
pub fn engine_identity_document() -> String {
    format!(
        concat!(
            "{{\"format\":\"erden.shacl-engine-identity/v1\",",
            "\"tool\":{{\"name\":\"{name}\",\"version\":\"{version}\"}},",
            "\"protocol\":\"erden.shacl/v{protocol}\",",
            "\"engine\":{{\"crate\":\"purrdf-shapes\",\"version\":\"3.0.1\",\"source\":\"crates.io\",",
            "\"repository\":\"https://github.com/Blackcat-Informatics/purrdf\",",
            "\"commit\":\"dcd24b1cc56cd7ac24cbe0d38dcf5a89022eaccf\",\"licenseElected\":\"MIT OR Apache-2.0\"}},",
            "\"cargoLockSha256\":\"{lock}\",",
            "\"semantics\":{{\"input\":\"n-triples-utf8\",",
            "\"shapes\":\"from_dataset_with_base(no-base,no-prefixes,no-box-roles,request-graph-iri,empty-imports)\",",
            "\"validation\":\"validate_dataset(default-options)\",",
            "\"conformanceDisallows\":\"sh:Violation,sh:Warning,sh:Info\",",
            "\"results\":\"engine-order\"}}}}\n"
        ),
        name = TOOL_NAME,
        version = TOOL_VERSION,
        protocol = PROTOCOL_VERSION,
        lock = CARGO_LOCK_SHA256,
    )
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for byte in digest.iter() {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

pub fn engine_digest() -> &'static str {
    static DIGEST: OnceLock<String> = OnceLock::new();
    DIGEST.get_or_init(|| sha256_hex(engine_identity_document().as_bytes()))
}

// ── Wire types ───────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub version: String,
    pub engine_digest: String,
    pub executable_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    kind: String,
    protocol_version: u32,
    request_id: String,
    required_tool: Tool,
    shapes: ShapesInput,
    graphs: Vec<GraphInput>,
    limits: Limits,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ShapesInput {
    digest: String,
    /// Absent only in a long-lived session that already holds this digest (with this graph IRI).
    #[serde(default)]
    n_triples: Option<String>,
    /// The IRI SHACL-SPARQL sees the shapes graph under (`$shapesGraph`); absent or null for none.
    #[serde(default)]
    graph_iri: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GraphInput {
    id: String,
    digest: String,
    n_triples: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Limits {
    max_results: u64,
}

/// Only the request identity, read when the whole request does not decode, so a refusal can still name it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestIdOnly {
    request_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Answer<'a> {
    kind: &'static str,
    protocol_version: u32,
    request_id: Option<&'a str>,
    tool: &'a Tool,
    #[serde(flatten)]
    body: Body,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
enum Body {
    #[serde(rename_all = "camelCase")]
    Validated {
        shapes_digest: String,
        reports: Vec<GraphReport>,
    },
    #[serde(rename_all = "camelCase")]
    Refused { refusal: Refusal },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Refusal {
    code: &'static str,
    message: String,
    graph: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphReport {
    id: String,
    digest: String,
    conforms: bool,
    results: Vec<WireResult>,
    diagnostics: Vec<WireDiagnostic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireResult {
    focus_node: WireTerm,
    result_path: Option<WirePath>,
    value: Option<WireTerm>,
    source_constraint_component: String,
    source_shape: WireTerm,
    result_severity: String,
    result_messages: Vec<WireTerm>,
    details: Vec<WireResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireDiagnostic {
    rule: &'static str,
    shape: WireTerm,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "termType")]
enum WireTerm {
    NamedNode {
        value: String,
    },
    BlankNode {
        value: String,
    },
    Literal {
        value: String,
        datatype: String,
        language: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum WirePath {
    Predicate(String),
    Inverse(Box<WirePath>),
    Sequence(Vec<WirePath>),
    Alternative(Vec<WirePath>),
    ZeroOrMore(Box<WirePath>),
    OneOrMore(Box<WirePath>),
    ZeroOrOne(Box<WirePath>),
    /// A blank or IRI path node the engine reported without its structure.
    Node(WireTerm),
}

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// Why a request was not answered with reports. The codes are part of `erden.shacl/v1`.
#[derive(Debug)]
pub struct Refused {
    code: &'static str,
    message: String,
    graph: Option<String>,
}

impl Refused {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            graph: None,
        }
    }

    fn graph(code: &'static str, graph: &str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            graph: Some(graph.to_owned()),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

fn shapes_refusal(error: &purrdf_shapes::ShapesError) -> Refused {
    use purrdf_shapes::ShapesError as E;
    let code = match error {
        E::Imports(_) => "shapes-imports",
        E::ShaclJs(_) => "unsupported-shacl-js",
        E::IllFormed(_) => "shapes-ill-formed",
        E::Prebinding(_) => "shapes-prebinding",
        E::UnsupportedTarget(_) => "unsupported-target",
        E::SparqlTargetDisagreement(_) => "sparql-target-disagreement",
        E::Invalid(_) => "shapes-invalid",
    };
    Refused::new(code, error.to_string())
}

fn validation_refusal(graph: &str, error: &purrdf_shapes::ShapesError) -> Refused {
    use purrdf_shapes::ShapesError as E;
    let code = match error {
        E::Imports(_) => "data-imports",
        E::ShaclJs(_) => "unsupported-shacl-js",
        E::IllFormed(_) => "shapes-ill-formed",
        E::Prebinding(_) => "shapes-prebinding",
        E::UnsupportedTarget(_) => "unsupported-target",
        E::SparqlTargetDisagreement(_) => "sparql-target-disagreement",
        E::Invalid(_) => "validation-failed",
    };
    Refused::graph(code, graph, error.to_string())
}

// ── Session ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// One process's state: its identity and, in a long-lived session, the shapes graphs it compiled.
pub struct Session {
    tool: Tool,
    long_lived: bool,
    shapes: HashMap<String, Arc<Shapes>>,
    order: VecDeque<String>,
}

impl Session {
    /// `executable_digest` is the SHA-256 of this process's executable, measured once by the caller.
    pub fn new(executable_digest: String, long_lived: bool) -> Self {
        Self {
            tool: Tool {
                name: TOOL_NAME.to_owned(),
                version: TOOL_VERSION.to_owned(),
                engine_digest: engine_digest().to_owned(),
                executable_digest,
            },
            long_lived,
            shapes: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn tool(&self) -> &Tool {
        &self.tool
    }

    /// Answers one request line (without its newline) with one answer line (with its newline). Never panics: a panic
    /// inside the engine becomes the refusal `engine-panic`.
    pub fn answer(&mut self, line: &[u8]) -> Vec<u8> {
        let request_id = serde_json::from_slice::<RequestIdOnly>(line)
            .ok()
            .and_then(|value| value.request_id)
            .filter(|id| id.len() <= MAX_REQUEST_ID_BYTES);
        let outcome = catch_unwind(AssertUnwindSafe(|| self.validate(line)));
        let body = match outcome {
            Ok(Ok(body)) => body,
            Ok(Err(refused)) => Body::Refused {
                refusal: Refusal {
                    code: refused.code,
                    message: refused.message,
                    graph: refused.graph,
                },
            },
            Err(payload) => {
                // Shapes compiled in this session may be in an unknown state after a panic: forget them.
                self.shapes.clear();
                self.order.clear();
                let detail = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| {
                        payload
                            .downcast_ref::<&str>()
                            .map(|text| (*text).to_owned())
                    })
                    .unwrap_or_else(|| "the engine panicked".to_owned());
                Body::Refused {
                    refusal: Refusal {
                        code: "engine-panic",
                        message: detail,
                        graph: None,
                    },
                }
            }
        };
        let answer = Answer {
            kind: "ShaclAnswer",
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.as_deref(),
            tool: &self.tool,
            body,
        };
        let mut out = serde_json::to_vec(&answer).expect("answers always serialize");
        out.push(b'\n');
        if out.len() > MAX_WIRE_BYTES {
            let refused = Answer {
                kind: "ShaclAnswer",
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.as_deref(),
                tool: &self.tool,
                body: Body::Refused {
                    refusal: Refusal {
                        code: "answer-limit",
                        message: format!("the answer would exceed {MAX_WIRE_BYTES} bytes"),
                        graph: None,
                    },
                },
            };
            out = serde_json::to_vec(&refused).expect("answers always serialize");
            out.push(b'\n');
        }
        out
    }

    fn validate(&mut self, line: &[u8]) -> Result<Body, Refused> {
        let request: Request = serde_json::from_slice(line).map_err(|error| {
            Refused::new(
                "request-invalid",
                format!("the request is not erden.shacl/v1: {error}"),
            )
        })?;
        check_envelope(&request, &self.tool)?;
        let shapes = self.shapes_for(&request.shapes)?;
        let mut reports = Vec::with_capacity(request.graphs.len());
        for graph in &request.graphs {
            let digest = sha256_hex(graph.n_triples.as_bytes());
            if digest != graph.digest {
                return Err(Refused::graph(
                    "input-digest",
                    &graph.id,
                    format!(
                        "graph {} hashes to {digest}, not the claimed {}",
                        graph.id, graph.digest
                    ),
                ));
            }
            let dataset = purrdf_rdf::parse_dataset(
                graph.n_triples.as_bytes(),
                "application/n-triples",
                None,
            )
            .map_err(|error| Refused::graph("data-parse", &graph.id, error.to_string()))?;
            let report = purrdf_shapes::engine::validate_dataset(&dataset, &shapes)
                .map_err(|error| validation_refusal(&graph.id, &error))?;
            if report.results.len() as u64 > request.limits.max_results {
                return Err(Refused::graph(
                    "result-limit",
                    &graph.id,
                    format!(
                        "graph {} has {} results, more than the request's limit of {}",
                        graph.id,
                        report.results.len(),
                        request.limits.max_results
                    ),
                ));
            }
            reports.push(graph_report(graph, digest, &report)?);
        }
        Ok(Body::Validated {
            shapes_digest: request.shapes.digest.clone(),
            reports,
        })
    }

    fn shapes_for(&mut self, input: &ShapesInput) -> Result<Arc<Shapes>, Refused> {
        // A session keeps one compilation per shapes digest and graph IRI.
        let key = format!("{}\u{0}{}", input.digest, input.graph_iri.as_deref().unwrap_or(""));
        if let Some(text) = &input.n_triples {
            let digest = sha256_hex(text.as_bytes());
            if digest != input.digest {
                return Err(Refused::new(
                    "input-digest",
                    format!(
                        "the shapes graph hashes to {digest}, not the claimed {}",
                        input.digest
                    ),
                ));
            }
            if let Some(found) = self.cached(&key) {
                return Ok(found);
            }
            let dataset = purrdf_rdf::parse_dataset(text.as_bytes(), "application/n-triples", None)
                .map_err(|error| Refused::new("shapes-parse", error.to_string()))?;
            let shapes = purrdf_shapes::shapes::from_dataset_with_base(
                &dataset,
                None,
                &[],
                None,
                input.graph_iri.clone(),
                &ShapesImports::new(),
            )
            .map_err(|error| shapes_refusal(&error))?;
            let shapes = Arc::new(shapes);
            if self.long_lived {
                self.remember(key, Arc::clone(&shapes));
            }
            return Ok(shapes);
        }
        self.cached(&key).ok_or_else(|| {
            Refused::new(
                "shapes-not-loaded",
                format!(
                    "this session holds no shapes graph {}; send its text",
                    input.digest
                ),
            )
        })
    }

    fn cached(&mut self, digest: &str) -> Option<Arc<Shapes>> {
        let found = self.shapes.get(digest).cloned()?;
        self.order.retain(|key| key != digest);
        self.order.push_back(digest.to_owned());
        Some(found)
    }

    fn remember(&mut self, digest: String, shapes: Arc<Shapes>) {
        if self.shapes.len() >= SESSION_SHAPES_CACHE
            && let Some(oldest) = self.order.pop_front()
        {
            self.shapes.remove(&oldest);
        }
        self.order.push_back(digest.clone());
        self.shapes.insert(digest, shapes);
    }
}

fn is_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn check_envelope(request: &Request, tool: &Tool) -> Result<(), Refused> {
    if request.kind != "ShaclRequest" || request.protocol_version != PROTOCOL_VERSION {
        return Err(Refused::new(
            "request-invalid",
            format!("expected a ShaclRequest of protocol version {PROTOCOL_VERSION}"),
        ));
    }
    if request.request_id.is_empty()
        || request.request_id.len() > MAX_REQUEST_ID_BYTES
        || !request
            .request_id
            .bytes()
            .all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(Refused::new(
            "request-invalid",
            "the request id must be 1 to 1,024 visible ASCII bytes",
        ));
    }
    if &request.required_tool != tool {
        return Err(Refused::new(
            "tool-mismatch",
            format!(
                "the request requires {} {} (engine {}, executable {}), but this is {} {} (engine {}, executable {})",
                request.required_tool.name,
                request.required_tool.version,
                request.required_tool.engine_digest,
                request.required_tool.executable_digest,
                tool.name,
                tool.version,
                tool.engine_digest,
                tool.executable_digest
            ),
        ));
    }
    if let Some(iri) = &request.shapes.graph_iri
        && (iri.is_empty() || !iri.contains(':') || iri.chars().any(|c| c.is_whitespace() || c.is_control()))
    {
        return Err(Refused::new("request-invalid", "shapes.graphIri must be an absolute IRI"));
    }
    if !is_digest(&request.shapes.digest) {
        return Err(Refused::new(
            "request-invalid",
            "the shapes digest must be sha256: and 64 lowercase hex digits",
        ));
    }
    if request.graphs.is_empty() || request.graphs.len() > MAX_GRAPHS {
        return Err(Refused::new(
            "request-invalid",
            format!("a request names 1 to {MAX_GRAPHS} data graphs"),
        ));
    }
    let mut ids = std::collections::HashSet::with_capacity(request.graphs.len());
    for graph in &request.graphs {
        if graph.id.is_empty()
            || graph.id.len() > MAX_GRAPH_ID_BYTES
            || !graph.id.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
            || !ids.insert(graph.id.as_str())
        {
            return Err(Refused::new(
                "request-invalid",
                "graph ids must be unique and 1 to 256 visible ASCII bytes",
            ));
        }
        if !is_digest(&graph.digest) {
            return Err(Refused::graph(
                "request-invalid",
                &graph.id,
                "a graph digest must be sha256: and 64 hex digits",
            ));
        }
    }
    if request.limits.max_results == 0 {
        return Err(Refused::new(
            "request-invalid",
            "limits.maxResults must be positive",
        ));
    }
    Ok(())
}

// ── Mapping the engine's report ──────────────────────────────────────────────────────────────────────────────────

fn graph_report(
    graph: &GraphInput,
    digest: String,
    report: &ValidationReport,
) -> Result<GraphReport, Refused> {
    let results = report
        .results
        .iter()
        .map(|result| {
            wire_result(result)
                .map_err(|message| Refused::graph("unsupported-term", &graph.id, message))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let diagnostics = report
        .diagnostics
        .iter()
        .map(|diagnostic| {
            Ok(WireDiagnostic {
                rule: diagnostic.rule,
                shape: wire_term(&diagnostic.shape)?,
                message: diagnostic.message(),
            })
        })
        .collect::<Result<Vec<_>, String>>()
        .map_err(|message| Refused::graph("unsupported-term", &graph.id, message))?;
    Ok(GraphReport {
        id: graph.id.clone(),
        digest,
        conforms: report.conforms,
        results,
        diagnostics,
    })
}

fn wire_result(result: &ValidationResult) -> Result<WireResult, String> {
    let result_path = match (&result.path_structure, &result.result_path) {
        (Some(structure), _) => Some(wire_path(structure)),
        (None, Some(Term::NamedNode(iri))) => Some(WirePath::Predicate(iri.as_str().to_owned())),
        (None, Some(other)) => Some(WirePath::Node(wire_term(other)?)),
        (None, None) => None,
    };
    Ok(WireResult {
        focus_node: wire_term(&result.focus_node)?,
        result_path,
        value: result.value.as_ref().map(wire_term).transpose()?,
        source_constraint_component: result.source_constraint_component.as_str().to_owned(),
        source_shape: wire_term(&result.source_shape)?,
        result_severity: result.severity.iri().to_owned(),
        result_messages: result
            .messages
            .iter()
            .map(|message| wire_term(&Term::Literal(message.clone())))
            .collect::<Result<_, _>>()?,
        details: result
            .details
            .iter()
            .map(wire_result)
            .collect::<Result<_, _>>()?,
    })
}

fn wire_term(term: &Term) -> Result<WireTerm, String> {
    Ok(match term {
        Term::NamedNode(iri) => WireTerm::NamedNode {
            value: iri.as_str().to_owned(),
        },
        Term::BlankNode(label) => WireTerm::BlankNode {
            value: label.clone(),
        },
        Term::Literal(literal) => {
            if literal.direction().is_some() {
                return Err(
                    "a result names a directional literal, which erden.shacl/v1 does not carry"
                        .to_owned(),
                );
            }
            WireTerm::Literal {
                value: literal.value().to_owned(),
                datatype: literal.datatype_str().to_owned(),
                language: literal.language().unwrap_or_default().to_owned(),
            }
        }
        Term::Triple(_) => {
            return Err(
                "a result names a triple term, which erden.shacl/v1 does not carry".to_owned(),
            );
        }
    })
}

fn wire_path(path: &Path) -> WirePath {
    match path {
        Path::Predicate(iri) => WirePath::Predicate(iri.as_str().to_owned()),
        Path::Inverse(inner) => WirePath::Inverse(Box::new(wire_path(inner))),
        Path::Sequence(items) => WirePath::Sequence(items.iter().map(wire_path).collect()),
        Path::Alternative(items) => WirePath::Alternative(items.iter().map(wire_path).collect()),
        Path::ZeroOrMore(inner) => WirePath::ZeroOrMore(Box::new(wire_path(inner))),
        Path::OneOrMore(inner) => WirePath::OneOrMore(Box::new(wire_path(inner))),
        Path::ZeroOrOne(inner) => WirePath::ZeroOrOne(Box::new(wire_path(inner))),
    }
}

/// The SHA-256 of this process's own executable, as `sha256:<hex>`.
pub fn own_executable_digest() -> Result<String, String> {
    let path =
        std::env::current_exe().map_err(|error| format!("resolve own executable: {error}"))?;
    let bytes = std::fs::read(&path).map_err(|error| format!("read own executable: {error}"))?;
    Ok(sha256_hex(&bytes))
}
