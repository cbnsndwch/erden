---
name: erden-check
description: Validate an Erden knowledge project, explain contradictions, failed rules, competency questions and citation problems, and repair model errors when requested. Use when someone asks “validate my knowledge”, “check these rules in Erden”, or wants to understand an Erden check report. Use erden-setup instead for installation readiness alone; this skill checks the project's knowledge and evidence.
license: Apache-2.0
metadata:
    version: '0.1.0'
---

# Validate Erden knowledge

Requirements: Requires terminal and filesystem access, the Erden CLI and working local engines. Offline checks need dependency artifacts already installed.

Explain what was actually checked, what failed and what the evidence supports, in the user's language. A validation request does not by itself authorize changing the model.

## Run the check

1. Locate the intended project and its `erden.config.*`. Read the relevant sources and existing report if supplied. Preserve the selected configuration; do not create a second manifest to bypass an error.
2. Use `erden` or `den`; consult `help` for the installed contract. If a source checkout is already built, its CLI can be run as `node <checkout>/apps/cli/dist/bin.js` from the desired directory. If the command or engines are missing, report that separately; use `erden-setup` if available, without making it a mandatory dependency.
3. Run `erden check <project-dir> --json`, or `erden check --config <manifest-file> --json` for an explicit configuration. Add `--offline` when requested and available dependencies make it possible. Do not assume a semantic error just because the process exited nonzero.
4. Parse JSON if produced, and retain stderr and exit status. Read [reports.md](references/reports.md) to interpret the result and select the relevant source evidence.

## Explain or repair

For each material failure, give the human meaning, the affected source or term, the relevant diagnostic and a concrete next action. Prioritize root failures; downstream `not-run` stages did not pass and did not independently fail.

If the user asked for fixes, make the smallest change that preserves their intended knowledge and rerun the check. Stop after two unsuccessful attempts at the same unresolved issue, or when correcting it requires a business decision. Ask about that decision using domain language rather than asking the user to write ontology syntax.

Do not remove constraints, lower expectations, delete evidence, change dependency identities or switch `outsideProfile` to `report` merely to make validation green. Do not manually edit generated layers or `erden.lock`. Environment repair, dependency restoration and model repair are different actions; perform only those included in the request.

## Deliver the result

State passed, failed or unable to run; summarize the stages that actually executed and their relevant warnings. If there were changes, list them and the final rerun result. Distinguish consistency and rule conformance from the factual truth or completeness of the knowledge. Include evidence for any remaining limitation.

Example requests: “Validate this Erden project and explain the errors without changing files.” / “Fix the failed competency question while preserving the intended supplier rule.”
