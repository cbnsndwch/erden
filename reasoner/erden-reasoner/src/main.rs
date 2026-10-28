use std::io::{self, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const UNTRUSTED_WORKER_ARG: &str = "--erden-private-untrusted-worker-v3";
const TEST_WORKER_MODE_ENV: &str = "ERDEN_REASONER_TEST_WORKER_MODE";

enum Invocation {
    Supervisor,
    UntrustedWorker,
}

fn main() {
    let started = Instant::now();
    match parse_invocation() {
        Ok(Invocation::Supervisor) => {
            let input = read_input(erden_reasoner::MAX_WIRE_BYTES + 1)
                .unwrap_or_else(|error| exit_error(error));
            run_supervisor(&input, started);
        }
        Ok(Invocation::UntrustedWorker) => {
            let input = read_input(erden_reasoner::MAX_WIRE_BYTES + 1)
                .unwrap_or_else(|error| worker_exit_error(error));
            run_untrusted_worker(&input, started);
        }
        Err(error) => exit_error(error),
    }
}

fn parse_invocation() -> Result<Invocation, String> {
    let arguments: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|argument| {
            argument
                .into_string()
                .map_err(|_| "arguments must be UTF-8".to_owned())
        })
        .collect::<Result<_, _>>()?;
    match arguments.as_slice() {
        [] => Ok(Invocation::Supervisor),
        [mode] if mode == UNTRUSTED_WORKER_ARG => Ok(Invocation::UntrustedWorker),
        _ => Err("arguments are not accepted on the public protocol invocation".into()),
    }
}

fn read_input(maximum: usize) -> Result<Vec<u8>, String> {
    let mut input = Vec::new();
    io::stdin()
        .take(maximum as u64)
        .read_to_end(&mut input)
        .map_err(|error| format!("stdin read failed: {error}"))?;
    Ok(input)
}

fn run_untrusted_worker(input: &[u8], started: Instant) -> ! {
    // Read from the request's canonical prefix, so the watchdog is armed before the request is
    // parsed; `run` then parses it once.
    let max_wall_time_ms =
        erden_reasoner::wall_time_limit_ms(input).unwrap_or_else(|error| worker_exit_error(error));
    let deadline = started
        .checked_add(Duration::from_millis(max_wall_time_ms))
        .unwrap_or(started);
    if Instant::now() >= deadline {
        worker_exit_error("wall-time budget elapsed before worker execution".into());
    }
    let completed = arm_worker_deadline(deadline);

    match std::env::var(TEST_WORKER_MODE_ENV).as_deref() {
        Ok("hang") => loop {
            std::thread::park();
        },
        Ok("slow") => std::thread::sleep(Duration::from_secs(30)),
        Ok("oversized") => {
            let output = vec![b'x'; erden_reasoner::MAX_WORKER_STDOUT_BYTES + 1];
            write_worker_output(&output, deadline, &completed);
        }
        Ok(mode) => worker_exit_error(format!("unknown internal test worker mode: {mode}")),
        Err(_) => {}
    }

    match erden_reasoner::run(input) {
        Ok(output) => write_worker_output(&output, deadline, &completed),
        Err(error) => worker_exit_error(error),
    }
}

fn arm_worker_deadline(deadline: Instant) -> Arc<AtomicBool> {
    let completed = Arc::new(AtomicBool::new(false));
    let watchdog_completed = Arc::clone(&completed);
    std::thread::spawn(move || {
        loop {
            if watchdog_completed.load(Ordering::Acquire) {
                return;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                worker_exit_error("internal worker wall-time budget elapsed".into());
            }
            std::thread::sleep(remaining.min(Duration::from_millis(10)));
        }
    });
    completed
}

fn run_supervisor(input: &[u8], started: Instant) -> ! {
    // The supervisor needs only the budget; the worker parses and checks the whole request.
    let max_wall_time_ms = match erden_reasoner::wall_time_limit_ms(input) {
        Ok(value) => value,
        Err(error) => exit_error(error),
    };
    let deadline = started
        .checked_add(Duration::from_millis(max_wall_time_ms))
        .unwrap_or(started);
    if Instant::now() >= deadline {
        write_refusal(
            input,
            "wall-time-budget",
            "Wall-time budget elapsed before worker launch",
        );
    }

    let mut child = match spawn_untrusted_worker(input) {
        Ok(child) => child,
        Err(error) => exit_error(error),
    };
    let stdout = child.stdout.take().expect("worker stdout is piped");
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = sender.send(read_worker_stdout(stdout));
    });

    let remaining = deadline.saturating_duration_since(Instant::now());
    match receiver.recv_timeout(remaining) {
        Ok(Ok(output)) => {
            if Instant::now() >= deadline {
                terminate(&mut child);
                write_refusal(
                    input,
                    "wall-time-budget",
                    "Wall-time budget elapsed before accepting worker output",
                );
            }
            if let Err(error) = erden_reasoner::check_output_framing(&output) {
                terminate(&mut child);
                write_refusal(input, "worker-output-invalid", error);
            }
            match child.wait() {
                Ok(status) if status.success() => {
                    if Instant::now() >= deadline {
                        write_refusal(
                            input,
                            "wall-time-budget",
                            "Wall-time budget elapsed before emitting worker output",
                        );
                    }
                    write_stdout(&output)
                }
                Ok(status) => write_refusal(
                    input,
                    "worker-process-failed",
                    format!("Internal worker failed closed with {status}"),
                ),
                Err(error) => exit_error(format!("wait for internal worker: {error}")),
            }
        }
        Ok(Err(error)) => {
            terminate(&mut child);
            write_refusal(input, "worker-stdout-limit", error);
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            terminate(&mut child);
            write_refusal(
                input,
                "wall-time-budget",
                "Wall-time budget elapsed; internal worker was terminated",
            );
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            terminate(&mut child);
            exit_error("internal worker output reader disconnected".into());
        }
    }
}

fn spawn_untrusted_worker(input: &[u8]) -> Result<Child, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("resolve supervisor executable: {error}"))?;
    let mut command = Command::new(executable);
    command
        .arg(UNTRUSTED_WORKER_ARG)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // A `phase-timing` build passes the worker's phase lines through; release builds discard them.
    #[cfg(feature = "phase-timing")]
    command.stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn internal worker: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "internal worker stdin was not piped".to_owned())?;
    stdin
        .write_all(input)
        .map_err(|error| format!("write untrusted worker stdin: {error}"))?;
    Ok(child)
}

fn read_worker_stdout(mut stdout: impl Read) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let read = stdout
            .read(&mut chunk)
            .map_err(|error| format!("read internal worker stdout: {error}"))?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > erden_reasoner::MAX_WORKER_STDOUT_BYTES {
            return Err(format!(
                "Internal worker exceeded the {} byte captured-stdout limit",
                erden_reasoner::MAX_WORKER_STDOUT_BYTES
            ));
        }
        output.extend_from_slice(&chunk[..read]);
    }
}

fn terminate(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn write_refusal(input: &[u8], code: &'static str, message: impl Into<String>) -> ! {
    match erden_reasoner::supervisor_refusal(input, code, message) {
        Ok(output) => write_output(&output),
        Err(error) => exit_error(error),
    }
}

/// The worker's answer is canonical JSON by construction; only its size is checked here, and
/// the supervisor checks its framing once before passing it on.
fn write_worker_output(output: &[u8], deadline: Instant, completed: &AtomicBool) -> ! {
    if output.len() > erden_reasoner::MAX_WORKER_STDOUT_BYTES {
        worker_exit_error(format!(
            "internal worker refused output above {} bytes",
            erden_reasoner::MAX_WORKER_STDOUT_BYTES
        ));
    }
    if Instant::now() >= deadline {
        worker_exit_error("internal worker wall-time budget elapsed before output".into());
    }
    if let Err(error) = io::stdout()
        .write_all(output)
        .and_then(|()| io::stdout().flush())
    {
        worker_exit_error(format!("stdout write failed: {error}"));
    }
    completed.store(true, Ordering::Release);
    std::process::exit(0)
}

/// Writes a refusal the supervisor encoded itself, after the framing and ceiling every public
/// write must meet.
fn write_output(output: &[u8]) -> ! {
    if let Err(error) = check_public_output(output) {
        exit_error(error);
    }
    write_stdout(output)
}

/// Writes bytes whose framing was already checked.
fn write_stdout(output: &[u8]) -> ! {
    if let Err(error) = io::stdout()
        .write_all(output)
        .and_then(|()| io::stdout().flush())
    {
        exit_error(format!("stdout write failed: {error}"));
    }
    std::process::exit(0)
}

fn check_public_output(output: &[u8]) -> Result<(), String> {
    erden_reasoner::check_output_framing(output)
        .map_err(|error| format!("refusing invalid public response before stdout write: {error}"))
}

fn worker_exit_error(error: String) -> ! {
    eprintln!("erden-reasoner worker: {error}");
    std::process::exit(3)
}

fn exit_error(error: String) -> ! {
    eprintln!("erden-reasoner: {error}");
    std::process::exit(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_reader_rejects_more_than_the_hard_stdout_cap() {
        let oversized = vec![b'x'; erden_reasoner::MAX_WORKER_STDOUT_BYTES + 1];
        let error = read_worker_stdout(std::io::Cursor::new(oversized))
            .expect_err("oversized worker output must fail");
        assert!(error.contains("captured-stdout limit"));
    }

    #[test]
    fn every_public_output_is_one_line_and_within_the_hard_cap() {
        assert!(check_public_output(b"{}\n").is_ok());
        assert!(check_public_output(b"{}\r\n").is_err());
        assert!(check_public_output(b"{}\n{}\n").is_err());
        let oversized = vec![b'x'; erden_reasoner::MAX_WORKER_STDOUT_BYTES + 1];
        assert!(check_public_output(&oversized).is_err());
    }
}
