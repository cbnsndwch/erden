# Interpreting check reports

| Exit | Meaning             | Response                                                                                               |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| 0    | Successful check    | Read warnings and stage statuses before describing coverage                                            |
| 1    | Semantic failure    | Explain the failed stages using their diagnostics and source evidence                                  |
| 2    | Invalid invocation  | Correct the command or configuration selection, then retry                                             |
| 3    | Operational failure | Diagnose unavailable engines, I/O, dependency or execution failure; no semantic verdict is established |

The JSON report has `outcome`, `stages`, `reasoning`, `sources` and `warnings`. Stage names include `sources`, `reasoning`, `core`, `shacl`, `competencyQuestions` and `citations`. Some details are null when execution never reached that stage. Do not assume every failure produces this report; operational errors may be printed only on stderr.

## Interpret in dependency order

1. **Sources and dependencies:** verify which files were actually selected and assembled. A missing dependency artifact is not proof of inconsistent knowledge. Offline mode cannot fetch missing artifacts.
2. **Reasoning:** a decided consistency result differs from a refusal, an incompatible engine or a resource limit. If reasoning fails, downstream validation can be `not-run`. Inspect unsatisfiable classes and explanations without equating every unsatisfiable class to a globally inconsistent ontology.
3. **Core:** inspect borrowed-term and property domain/range diagnostics. Preserve established vocabulary semantics rather than redeclaring imported terms arbitrarily.
4. **SHACL:** identify the focus node, path, constraint, severity and source. A `skipped` stage can mean no shapes were configured; it does not mean all possible business rules were validated.
5. **Competency questions:** compare actual results to the intended expectation. Some dependency questions may be dormant. Explain coverage from the report instead of claiming every question was executed.
6. **Citations:** distinguish missing or unsafe source paths from warnings such as `changed-since` or `uncommitted-edit`, and from incomplete verification such as `no-source-root`, `git-unavailable`, `not-in-git` or `no-commit-cited`. Do not invent a provenance guarantee from a passing top-level report.

## Common operational boundaries

`CHECK_SHACL_ENGINE_UNAVAILABLE` means the CLI cannot use its verified SHACL engine. Run `erden doctor --json` to inspect the selected engine; changing the ontology will not install it. A file under a build target directory can exist while the platform package remains unprepared.

Reasoner budget settings for checks are `ERDEN_REASONER_MAX_WALL_TIME_MS`, `ERDEN_REASONER_MAX_INPUT_AXIOMS`, `ERDEN_REASONER_MAX_INFERENCES` and `ERDEN_REASONER_MAX_REQUEST_BYTES`. A resource refusal is not a proof of inconsistency. Do not silently raise limits or claim that a local result predicts a registry configured with different limits.

Local `check` results and a registry publication verdict are separate evidence. Rerun after the final authorized changes and use the actual final report in the response.
