//! The `erden-shacl` executable. Two invocations, nothing else:
//!
//! - no arguments: read one request line from stdin, write one answer line to stdout, exit 0;
//! - `--serve`: a long-lived session that answers request lines in order until stdin closes, keeping the shapes
//!   graphs it compiled so a request can name one by digest.
//!
//! Exit status 2, with a message on stderr and nothing on stdout, means no answer could be framed at all (unreadable
//! stdin, a line above the wire limit, no final newline, an unknown argument, an unreadable own executable).
use std::io::{self, BufRead, Read, Write};

use erden_shacl::{MAX_WIRE_BYTES, Session, own_executable_digest};

fn main() {
    let arguments: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|argument| argument.into_string().unwrap_or_default())
        .collect();
    let long_lived = match arguments.as_slice() {
        [] => false,
        [mode] if mode == "--serve" => true,
        _ => fatal("arguments other than --serve are not accepted".to_owned()),
    };
    // A panic is turned into a refusal by the session; keep the default hook from writing to stderr.
    std::panic::set_hook(Box::new(|_| {}));
    let digest = own_executable_digest().unwrap_or_else(|error| fatal(error));
    let mut session = Session::new(digest, long_lived);
    if long_lived {
        serve(&mut session);
    } else {
        one_shot(&mut session);
    }
}

fn one_shot(session: &mut Session) {
    let mut input = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_WIRE_BYTES as u64 + 1)
        .read_to_end(&mut input)
        .unwrap_or_else(|error| fatal(format!("stdin read failed: {error}")));
    if input.len() > MAX_WIRE_BYTES {
        fatal(format!("the request exceeds {MAX_WIRE_BYTES} bytes"));
    }
    let Some(line) = input.strip_suffix(b"\n") else {
        fatal("the request must be one line ending in a newline".to_owned());
    };
    if line.contains(&b'\n') {
        fatal("the request must be exactly one line".to_owned());
    }
    write(&session.answer(line));
}

fn serve(session: &mut Session) {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = (&mut reader)
            .take(MAX_WIRE_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
            .unwrap_or_else(|error| fatal(format!("stdin read failed: {error}")));
        if read == 0 {
            return;
        }
        let Some(request) = line.strip_suffix(b"\n") else {
            fatal(if line.len() > MAX_WIRE_BYTES {
                format!("a request exceeds {MAX_WIRE_BYTES} bytes")
            } else {
                "the last request has no final newline".to_owned()
            });
        };
        write(&session.answer(request));
    }
}

fn write(answer: &[u8]) {
    let mut stdout = io::stdout().lock();
    if let Err(error) = stdout.write_all(answer).and_then(|()| stdout.flush()) {
        fatal(format!("stdout write failed: {error}"));
    }
}

fn fatal(message: String) -> ! {
    eprintln!("erden-shacl: {message}");
    std::process::exit(2)
}
