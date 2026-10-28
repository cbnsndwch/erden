//! Black-box tests of the `erden-shacl` executable: the one-shot and long-lived invocations, the answers' fields and
//! every refusal the adapter itself makes.
use std::io::Write;
use std::process::{Command, Stdio};

use erden_shacl::{CARGO_LOCK_SHA256, TOOL_NAME, TOOL_VERSION, engine_digest, sha256_hex};
use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_erden-shacl");
const SH: &str = "http://www.w3.org/ns/shacl#";
const RDF_TYPE: &str = "<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>";
const XSD_INTEGER: &str = "<http://www.w3.org/2001/XMLSchema#integer>";

fn executable_digest() -> String {
    sha256_hex(&std::fs::read(BIN).expect("read the built executable"))
}

fn tool() -> Value {
    json!({
        "name": TOOL_NAME,
        "version": TOOL_VERSION,
        "engineDigest": engine_digest(),
        "executableDigest": executable_digest(),
    })
}

fn request(id: &str, shapes: &str, graphs: &[(&str, &str)]) -> Value {
    json!({
        "kind": "ShaclRequest",
        "protocolVersion": 1,
        "requestId": id,
        "requiredTool": tool(),
        "shapes": { "digest": sha256_hex(shapes.as_bytes()), "nTriples": shapes },
        "graphs": graphs.iter().map(|(graph, text)| json!({
            "id": graph, "digest": sha256_hex(text.as_bytes()), "nTriples": text,
        })).collect::<Vec<_>>(),
        "limits": { "maxResults": 1000 },
    })
}

struct Run {
    status: i32,
    stdout: String,
    stderr: String,
}

fn run(args: &[&str], input: &[u8]) -> Run {
    let mut child = Command::new(BIN)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn erden-shacl");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input)
        .expect("write stdin");
    let output = child.wait_with_output().expect("wait");
    Run {
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8(output.stdout).expect("utf-8 stdout"),
        stderr: String::from_utf8(output.stderr).expect("utf-8 stderr"),
    }
}

fn one_shot(value: &Value) -> (Value, String) {
    let line = format!("{value}\n");
    let run = run(&[], line.as_bytes());
    assert_eq!(run.status, 0, "stderr: {}", run.stderr);
    assert_eq!(run.stderr, "");
    assert!(
        run.stdout.ends_with('\n') && run.stdout.matches('\n').count() == 1,
        "one answer line"
    );
    (
        serde_json::from_str(&run.stdout).expect("answer JSON"),
        run.stdout,
    )
}

fn refusal(answer: &Value) -> (&str, &str) {
    assert_eq!(answer["outcome"], "refused", "{answer}");
    (
        answer["refusal"]["code"].as_str().unwrap(),
        answer["refusal"]["message"].as_str().unwrap(),
    )
}

fn person_shapes() -> String {
    [
        format!("<http://ex/PersonShape> {RDF_TYPE} <{SH}NodeShape> ."),
        format!("<http://ex/PersonShape> <{SH}targetClass> <http://ex/Person> ."),
        format!("<http://ex/PersonShape> <{SH}property> _:s0 ."),
        format!("_:s0 <{SH}path> <http://ex/age> ."),
        format!("_:s0 <{SH}datatype> <http://www.w3.org/2001/XMLSchema#integer> ."),
        format!("_:s0 <{SH}maxCount> \"1\"^^{XSD_INTEGER} ."),
        format!("<http://ex/PersonShape> <{SH}property> _:s1 ."),
        format!("_:s1 <{SH}path> _:s2 ."),
        format!("_:s2 <{SH}inversePath> <http://ex/parent> ."),
        format!("_:s1 <{SH}minCount> \"1\"^^{XSD_INTEGER} ."),
        String::new(),
    ]
    .join("\n")
}

#[test]
fn the_engine_identity_names_the_committed_lock() {
    let lock = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../Cargo.lock"))
        .expect("read Cargo.lock");
    assert_eq!(
        sha256_hex(&lock),
        CARGO_LOCK_SHA256,
        "update CARGO_LOCK_SHA256 and the TypeScript identity"
    );
}

#[test]
fn a_conforming_graph_has_no_results() {
    let data = format!(
        "<http://ex/a> {RDF_TYPE} <http://ex/Person> .\n<http://ex/b> <http://ex/parent> <http://ex/a> .\n"
    );
    let (answer, _) = one_shot(&request("conforms", &person_shapes(), &[("data", &data)]));
    assert_eq!(answer["kind"], "ShaclAnswer");
    assert_eq!(answer["protocolVersion"], 1);
    assert_eq!(answer["requestId"], "conforms");
    assert_eq!(answer["tool"], tool());
    assert_eq!(answer["outcome"], "validated");
    assert_eq!(
        answer["shapesDigest"],
        sha256_hex(person_shapes().as_bytes())
    );
    let report = &answer["reports"][0];
    assert_eq!(report["id"], "data");
    assert_eq!(report["digest"], sha256_hex(data.as_bytes()));
    assert_eq!(report["conforms"], true);
    assert_eq!(report["results"], json!([]));
}

#[test]
fn results_carry_focus_path_value_component_shape_and_severity_with_input_labels() {
    let data = format!(
        "_:d0 {RDF_TYPE} <http://ex/Person> .\n_:d0 <http://ex/age> \"x\" .\n_:d0 <http://ex/age> \"1\"^^{XSD_INTEGER} .\n"
    );
    let (answer, _) = one_shot(&request("violates", &person_shapes(), &[("data", &data)]));
    let report = &answer["reports"][0];
    assert_eq!(report["conforms"], false);
    let results = report["results"].as_array().unwrap();
    assert_eq!(results.len(), 3, "{report}");
    let by_component = |component: &str| {
        results
            .iter()
            .find(|result| result["sourceConstraintComponent"] == format!("{SH}{component}"))
            .unwrap_or_else(|| panic!("no {component} result in {report}"))
    };
    let datatype = by_component("DatatypeConstraintComponent");
    assert_eq!(
        datatype["focusNode"],
        json!({ "termType": "BlankNode", "value": "d0" })
    );
    assert_eq!(
        datatype["resultPath"],
        json!({ "predicate": "http://ex/age" })
    );
    assert_eq!(
        datatype["value"],
        json!({ "termType": "Literal", "value": "x", "datatype": "http://www.w3.org/2001/XMLSchema#string", "language": "" })
    );
    assert_eq!(
        datatype["sourceShape"],
        json!({ "termType": "BlankNode", "value": "s0" })
    );
    assert_eq!(datatype["resultSeverity"], format!("{SH}Violation"));
    assert_eq!(datatype["resultMessages"], json!([]));
    let max = by_component("MaxCountConstraintComponent");
    assert_eq!(max["value"], Value::Null);
    let min = by_component("MinCountConstraintComponent");
    assert_eq!(
        min["resultPath"],
        json!({ "inverse": { "predicate": "http://ex/parent" } })
    );
    assert_eq!(
        min["sourceShape"],
        json!({ "termType": "BlankNode", "value": "s1" })
    );
}

#[test]
fn sparql_constraints_run_and_substitute_messages() {
    let shapes = [
        format!("<http://ex/S> {RDF_TYPE} <{SH}NodeShape> ."),
        format!("<http://ex/S> <{SH}targetClass> <http://ex/Task> ."),
        format!("<http://ex/S> <{SH}sparql> _:c ."),
        format!("_:c <{SH}message> \"{{$this}} ends before it starts\" ."),
        format!(
            "_:c <{SH}select> \"SELECT $this ?value WHERE {{ $this <http://ex/start> ?s ; <http://ex/end> ?value . FILTER (?value < ?s) }}\" ."
        ),
        String::new(),
    ]
    .join("\n");
    let data = format!(
        "<http://ex/t1> {RDF_TYPE} <http://ex/Task> .\n<http://ex/t1> <http://ex/start> \"5\"^^{XSD_INTEGER} .\n<http://ex/t1> <http://ex/end> \"3\"^^{XSD_INTEGER} .\n<http://ex/t2> {RDF_TYPE} <http://ex/Task> .\n<http://ex/t2> <http://ex/start> \"1\"^^{XSD_INTEGER} .\n<http://ex/t2> <http://ex/end> \"3\"^^{XSD_INTEGER} .\n"
    );
    let (answer, _) = one_shot(&request("sparql", &shapes, &[("data", &data)]));
    let results = answer["reports"][0]["results"].as_array().unwrap();
    assert_eq!(results.len(), 1, "{answer}");
    let result = &results[0];
    assert_eq!(result["focusNode"]["value"], "http://ex/t1");
    assert_eq!(
        result["sourceConstraintComponent"],
        format!("{SH}SPARQLConstraintComponent")
    );
    assert_eq!(result["value"]["value"], "3");
    let message = result["resultMessages"][0]["value"].as_str().unwrap();
    assert!(
        message.contains("ends before it starts") && !message.contains("{$this}"),
        "{message}"
    );
}

#[test]
fn every_data_graph_of_a_request_is_answered_in_order() {
    let ok = format!(
        "<http://ex/a> {RDF_TYPE} <http://ex/Person> .\n<http://ex/b> <http://ex/parent> <http://ex/a> .\n"
    );
    let bad = format!("<http://ex/a> {RDF_TYPE} <http://ex/Person> .\n");
    let (answer, _) = one_shot(&request(
        "batch",
        &person_shapes(),
        &[("one", &bad), ("two", &ok), ("three", &bad)],
    ));
    let ids: Vec<_> = answer["reports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|report| report["id"].clone())
        .collect();
    assert_eq!(ids, vec![json!("one"), json!("two"), json!("three")]);
    let conforms: Vec<_> = answer["reports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["conforms"].clone())
        .collect();
    assert_eq!(conforms, vec![json!(false), json!(true), json!(false)]);
}

#[test]
fn the_same_request_gives_the_same_bytes() {
    let data = format!("_:d0 {RDF_TYPE} <http://ex/Person> .\n_:d0 <http://ex/age> \"x\" .\n");
    let value = request("same", &person_shapes(), &[("data", &data)]);
    let (_, first) = one_shot(&value);
    for _ in 0..5 {
        assert_eq!(one_shot(&value).1, first);
    }
}

#[test]
fn a_different_tool_identity_is_refused() {
    let data = format!("<http://ex/a> {RDF_TYPE} <http://ex/Person> .\n");
    for field in ["name", "version", "engineDigest", "executableDigest"] {
        let mut value = request("tool", &person_shapes(), &[("data", &data)]);
        value["requiredTool"][field] = json!(if field.ends_with("Digest") {
            format!("sha256:{}", "0".repeat(64))
        } else {
            "other".to_owned()
        });
        let (answer, _) = one_shot(&value);
        assert_eq!(refusal(&answer).0, "tool-mismatch", "{field}");
        assert_eq!(answer["requestId"], "tool");
    }
}

#[test]
fn text_that_does_not_hash_to_its_claimed_digest_is_refused() {
    let data = format!("<http://ex/a> {RDF_TYPE} <http://ex/Person> .\n");
    let mut value = request("digest", &person_shapes(), &[("data", &data)]);
    value["graphs"][0]["nTriples"] = json!(format!(
        "{data}<http://ex/x> <http://ex/y> <http://ex/z> .\n"
    ));
    let (answer, _) = one_shot(&value);
    assert_eq!(refusal(&answer).0, "input-digest");
    assert_eq!(answer["refusal"]["graph"], "data");
    let mut value = request("digest", &person_shapes(), &[("data", &data)]);
    value["shapes"]["digest"] = json!(format!("sha256:{}", "a".repeat(64)));
    let (answer, _) = one_shot(&value);
    assert_eq!(refusal(&answer).0, "input-digest");
    assert_eq!(answer["refusal"]["graph"], Value::Null);
}

#[test]
fn malformed_requests_are_refused_with_their_id_when_it_can_be_read() {
    let data = format!("<http://ex/a> {RDF_TYPE} <http://ex/Person> .\n");
    let mut value = request("extra", &person_shapes(), &[("data", &data)]);
    value["unexpected"] = json!(true);
    let (answer, _) = one_shot(&value);
    assert_eq!(refusal(&answer).0, "request-invalid");
    assert_eq!(answer["requestId"], "extra");
    let (answer, _) = one_shot(&json!({ "kind": "ShaclRequest" }));
    assert_eq!(refusal(&answer).0, "request-invalid");
    assert_eq!(answer["requestId"], Value::Null);
    let mut value = request("dup", &person_shapes(), &[("data", &data), ("data", &data)]);
    let (answer, _) = one_shot(&value);
    assert_eq!(refusal(&answer).0, "request-invalid");
    value["graphs"] = json!([]);
    assert_eq!(refusal(&one_shot(&value).0).0, "request-invalid");
}

#[test]
fn inputs_the_engine_cannot_read_are_refused_by_stage() {
    let data = format!("<http://ex/a> {RDF_TYPE} <http://ex/Person> .\n");
    let (answer, _) = one_shot(&request(
        "bad-data",
        &person_shapes(),
        &[("data", "<http://ex/a> broken")],
    ));
    assert_eq!(refusal(&answer).0, "data-parse");
    let (answer, _) = one_shot(&request("bad-shapes", "not n-triples", &[("data", &data)]));
    assert_eq!(refusal(&answer).0, "shapes-parse");
    let imports = format!(
        "{}<http://ex/shapes> {RDF_TYPE} <http://www.w3.org/2002/07/owl#Ontology> .\n<http://ex/shapes> <http://www.w3.org/2002/07/owl#imports> <http://ex/elsewhere> .\n",
        person_shapes()
    );
    let (answer, _) = one_shot(&request("imports", &imports, &[("data", &data)]));
    assert_eq!(refusal(&answer).0, "shapes-imports");
}

#[test]
fn more_results_than_the_limit_is_refused_not_truncated() {
    let data = format!(
        "<http://ex/a> {RDF_TYPE} <http://ex/Person> .\n<http://ex/b> {RDF_TYPE} <http://ex/Person> .\n"
    );
    let mut value = request("limit", &person_shapes(), &[("data", &data)]);
    value["limits"]["maxResults"] = json!(1);
    let (answer, _) = one_shot(&value);
    assert_eq!(refusal(&answer).0, "result-limit");
}

#[test]
fn a_long_lived_session_reuses_shapes_by_digest() {
    let data = format!("<http://ex/a> {RDF_TYPE} <http://ex/Person> .\n");
    let first = request("first", &person_shapes(), &[("data", &data)]);
    let mut second = request("second", &person_shapes(), &[("data", &data)]);
    second["shapes"].as_object_mut().unwrap().remove("nTriples");
    let mut unknown = second.clone();
    unknown["requestId"] = json!("unknown");
    unknown["shapes"]["digest"] = json!(format!("sha256:{}", "b".repeat(64)));
    let input = format!("{first}\n{second}\n{unknown}\n");
    let run = run(&["--serve"], input.as_bytes());
    assert_eq!(run.status, 0, "{}", run.stderr);
    let answers: Vec<Value> = run
        .stdout
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(answers.len(), 3);
    assert_eq!(answers[0]["outcome"], "validated");
    assert_eq!(answers[1]["outcome"], "validated");
    assert_eq!(answers[1]["reports"], answers[0]["reports"]);
    assert_eq!(answers[1]["requestId"], "second");
    assert_eq!(refusal(&answers[2]).0, "shapes-not-loaded");
    // A one-shot process keeps nothing.
    let (answer, _) = one_shot(&second);
    assert_eq!(refusal(&answer).0, "shapes-not-loaded");
}

#[test]
fn unframed_input_and_arguments_exit_2_without_stdout() {
    for (args, input) in [
        (vec!["--other"], b"{}\n".as_slice()),
        (vec![], b"{}".as_slice()),
        (vec![], b"{}\n{}\n".as_slice()),
        (vec!["--serve"], b"{}".as_slice()),
    ] {
        let run = run(&args, input);
        assert_eq!(run.status, 2, "{args:?}");
        assert_eq!(run.stdout, "");
        assert!(run.stderr.starts_with("erden-shacl: "));
    }
}
