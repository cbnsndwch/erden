use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const OLD_WORKER_ARG_V1: &str = "--erden-private-internal-worker-v1";
const OLD_WORKER_ARG_V2: &str = "--erden-private-internal-worker-v2";
const UNTRUSTED_WORKER_ARG: &str = "--erden-private-untrusted-worker-v3";
const TEST_MODE_ENV: &str = "ERDEN_REASONER_TEST_WORKER_MODE";
const ADAPTER_CONTRACT: &str = "erden-reasoner-adapter-v1\nprotocol=1\nprofile=erden-required-constructs-v1\nproof-checker=erden-proof-checker-v2\nmax-wire-bytes=134217728\n";
const CALCULUS_CONTRACT: &str = "purrdf-entail=0.12.0\nsource=https://github.com/Blackcat-Informatics/purrdf\nrev=dfb1df73199668720116dfbc737c0585e23afb5e\nservices=classify-hierarchy,satisfiability-per-signature,consistency-per-data-range\n";

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn canonical_json(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).expect("encode canonical JSON");
    bytes.push(b'\n');
    bytes
}

fn refresh_input_digest(request: &mut Value) {
    let digest_input = json!({
        "axioms": request["ontology"]["axioms"].clone(),
        "sources": request["ontology"]["sources"].clone(),
    });
    request["ontology"]["digest"] = Value::String(digest(&canonical_json(&digest_input)));
}

fn request(max_wall_time_ms: u64) -> Vec<u8> {
    let mut request: Value = serde_json::from_slice(include_bytes!(
        "../../protocol/fixtures/known-answer/subclass-type.request.json"
    ))
    .expect("parse committed request fixture");
    request["limits"]["maxWallTimeMs"] = json!(max_wall_time_ms);
    request["requiredTool"] = json!({
        "adapterDigest": digest(ADAPTER_CONTRACT.as_bytes()),
        "calculusDigest": digest(CALCULUS_CONTRACT.as_bytes()),
        "executableDigest": digest(&fs::read(env!("CARGO_BIN_EXE_erden-reasoner")).expect("read test executable")),
        "name": "erden-reasoner",
        "version": "0.2.0+purrdf.0.12.0.dfb1df7"
    });
    canonical_json(&request)
}

fn request_with_id(bytes: usize) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(&request(5_000)).expect("parse request");
    value["requestId"] = Value::String(format!(
        "r{}",
        "a".repeat(bytes.checked_sub(1).expect("non-empty request ID"))
    ));
    canonical_json(&value)
}

fn request_at_wire_size(target: usize) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(&request(30_000)).expect("parse request");
    value["requestId"] = Value::String(format!(
        "r{}",
        "a".repeat(erden_reasoner::MAX_REASONER_REQUEST_ID_BYTES - 1)
    ));
    value["ontology"]["sources"][0]["ontologyIri"] = Value::String("https://padding.test/".into());
    refresh_input_digest(&mut value);
    let baseline = canonical_json(&value);
    let padding = target
        .checked_sub(baseline.len())
        .expect("target must fit the base request");
    value["ontology"]["sources"][0]["ontologyIri"] =
        Value::String(format!("https://padding.test/{}", "p".repeat(padding)));
    refresh_input_digest(&mut value);
    let bytes = canonical_json(&value);
    assert_eq!(bytes.len(), target);
    bytes
}

fn request_with_oversized_id_at_wire_size(target: usize) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(&request(5_000)).expect("parse request");
    value["requestId"] = Value::String("r".into());
    let baseline = canonical_json(&value);
    let padding = target
        .checked_sub(baseline.len())
        .expect("target must fit the base request");
    value["requestId"] = Value::String(format!("r{}", "a".repeat(padding)));
    let bytes = canonical_json(&value);
    assert_eq!(bytes.len(), target);
    bytes
}

fn invoke(arguments: &[&str], mode: Option<&str>, input: Option<&[u8]>) -> (Output, Duration) {
    let started = Instant::now();
    let mut command = Command::new(env!("CARGO_BIN_EXE_erden-reasoner"));
    command
        .args(arguments)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(mode) = mode {
        command.env(TEST_MODE_ENV, mode);
    }
    let mut child = command.spawn().expect("spawn direct invocation probe");
    if let Some(input) = input {
        use std::io::Write;
        child
            .stdin
            .take()
            .expect("probe stdin")
            .write_all(input)
            .expect("write probe input");
    }
    let output = child.wait_with_output().expect("wait for direct probe");
    (output, started.elapsed())
}

fn assert_closed(output: &Output, elapsed: Duration) {
    assert!(!output.status.success(), "direct worker probe must fail");
    assert!(
        output.stdout.len() <= erden_reasoner::MAX_WORKER_STDOUT_BYTES,
        "direct worker probe exceeded stdout ceiling"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "direct worker probe did not fail promptly: {elapsed:?}"
    );
}

#[test]
fn obsolete_and_channel_shaped_arguments_never_run_worker_hooks() {
    let cases: &[&[&str]] = &[
        &[OLD_WORKER_ARG_V1],
        &[OLD_WORKER_ARG_V1, "extra"],
        &[OLD_WORKER_ARG_V2],
        &[
            OLD_WORKER_ARG_V2,
            "1234",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        &["--erden-private-internal-worker-v3", "random-or-stale-pipe"],
        &[UNTRUSTED_WORKER_ARG, "extra"],
    ];
    for arguments in cases {
        let (output, elapsed) = invoke(arguments, Some("hang"), None);
        assert_closed(&output, elapsed);
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn direct_untrusted_worker_is_independently_time_and_output_bounded() {
    let short = request(50);
    for mode in ["hang", "slow"] {
        let (output, elapsed) = invoke(&[UNTRUSTED_WORKER_ARG], Some(mode), Some(&short));
        assert_closed(&output, elapsed);
        assert!(output.stdout.is_empty());
    }

    let one_millisecond = request(1);
    let (normal_output, normal_elapsed) =
        invoke(&[UNTRUSTED_WORKER_ARG], None, Some(&one_millisecond));
    assert_closed(&normal_output, normal_elapsed);
    assert!(normal_output.stdout.is_empty());

    let (output, elapsed) = invoke(
        &[UNTRUSTED_WORKER_ARG],
        Some("hang"),
        Some(&one_millisecond),
    );
    assert_closed(&output, elapsed);
    assert!(output.stdout.is_empty());

    let bounded = request(5_000);
    let (output, elapsed) = invoke(&[UNTRUSTED_WORKER_ARG], Some("oversized"), Some(&bounded));
    assert_closed(&output, elapsed);
    assert!(output.stdout.is_empty());
}

#[test]
fn direct_untrusted_worker_has_the_same_canonical_reasoning_boundary() {
    let valid = request(5_000);
    let (output, elapsed) = invoke(&[UNTRUSTED_WORKER_ARG], None, Some(&valid));
    assert!(output.status.success());
    assert!(elapsed < Duration::from_secs(5));
    assert!(output.stderr.is_empty());
    erden_reasoner::validate_worker_output(&output.stdout).expect("canonical bounded response");
    assert!(output.stdout.len() <= erden_reasoner::MAX_WORKER_STDOUT_BYTES);

    let (malformed, elapsed) = invoke(&[UNTRUSTED_WORKER_ARG], Some("oversized"), Some(b"{}\n"));
    assert_closed(&malformed, elapsed);
    assert!(malformed.stdout.is_empty());
}

#[test]
fn public_and_untrusted_entries_enforce_exact_wire_boundaries() {
    let oversized_id = request_with_id(erden_reasoner::MAX_REASONER_REQUEST_ID_BYTES + 1);
    for arguments in [&[][..], &[UNTRUSTED_WORKER_ARG][..]] {
        let (output, elapsed) = invoke(arguments, None, Some(&oversized_id));
        assert_closed(&output, elapsed);
        assert!(output.stdout.is_empty());
    }

    let original_reproduction =
        request_with_oversized_id_at_wire_size(erden_reasoner::MAX_WIRE_BYTES);
    for arguments in [&[][..], &[UNTRUSTED_WORKER_ARG][..]] {
        let (output, elapsed) = invoke(arguments, None, Some(&original_reproduction));
        assert_closed(&output, elapsed);
        assert!(output.stdout.is_empty());
    }

    let exact = request_at_wire_size(erden_reasoner::MAX_WIRE_BYTES);
    let (public, public_elapsed) = invoke(&[], None, Some(&exact));
    let (direct, direct_elapsed) = invoke(&[UNTRUSTED_WORKER_ARG], None, Some(&exact));
    for (output, elapsed) in [(&public, public_elapsed), (&direct, direct_elapsed)] {
        assert!(output.status.success());
        assert!(elapsed < Duration::from_secs(30));
        assert!(output.stderr.is_empty());
        erden_reasoner::validate_worker_output(&output.stdout)
            .expect("exact-max response must remain canonical and bounded");
    }
    assert_eq!(public.stdout, direct.stdout);

    let too_large = request_at_wire_size(erden_reasoner::MAX_WIRE_BYTES + 1);
    for arguments in [&[][..], &[UNTRUSTED_WORKER_ARG][..]] {
        let (output, elapsed) = invoke(arguments, None, Some(&too_large));
        assert_closed(&output, elapsed);
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn supervisor_generated_containment_refusals_are_canonical_and_bounded() {
    let short = request(50);
    for mode in ["hang", "slow"] {
        let (output, elapsed) = invoke(&[], Some(mode), Some(&short));
        assert!(output.status.success());
        assert!(elapsed < Duration::from_secs(5));
        erden_reasoner::validate_worker_output(&output.stdout)
            .expect("timeout refusal must be canonical and bounded");
    }
    let bounded = request(5_000);
    for mode in ["oversized", "worker-failure"] {
        let (output, elapsed) = invoke(&[], Some(mode), Some(&bounded));
        assert!(output.status.success());
        assert!(elapsed < Duration::from_secs(5));
        erden_reasoner::validate_worker_output(&output.stdout)
            .expect("worker failure/output refusal must be canonical and bounded");
    }
}
