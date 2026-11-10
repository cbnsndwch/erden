# Public Erden skills: research and proposal

Research date: November 10, 2026. Initial source revision: `e937a6f`. Instructions were updated for upstream `1dc6fd0`, with `cbnsndwch/erden` confirmed as the destination.
Status: the agreed scope includes `erden-setup`; six initial skills are implemented. Local installation and initial checks are complete; public distribution is pending. See the [validation status](../skills/TESTING.md).

## Recommendation

Create six outcome-focused Agent Skills under `skills/` in this repository. Use the Erden CLI as the execution interface and the open `SKILL.md` format as the agent interface. Keeping code and skills together makes it easier to review compatibility when commands change.

The intended experience is that a person describes what they need; the agent identifies the project, prepares the files or query, runs Erden, verifies the result and explains it in the user's language. Users should not need to write Turtle, SHACL, SPARQL or commands.

The skills require a compatible agent with filesystem and terminal access, plus an Erden installation. Installing them does not automatically install Erden or grant registry access. Supporting clients without a terminal would require an additional remote integration, such as MCP. That integration is outside this initial scope.

## Source recommendations

| Source or tool                                                                                 | Proposed use                                                                        | Scope and limitations                                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Agent Skills](https://agentskills.io/specification)                                           | Portable format and structural validation with `skills-ref validate`                | Checks structure; does not establish behavioral quality               |
| [Agent Skills best practices](https://agentskills.io/skill-creation/best-practices)            | Concise instructions, cohesive tasks and references loaded as needed                | Guidance for authoring and refining skills through actual runs        |
| [Anthropic skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator) | Draft, compare runs with and without a skill, review results and improve activation | Some optimization automation depends on Claude Code                   |
| The `skill-creator` bundled with this Codex environment                                        | Initialize, write and validate skills in this session                               | Available locally; its validation does not replace functional testing |
| [Vercel CLI](https://github.com/vercel-labs/skills)                                            | Create a template, discover, install and distribute skills                          | `npx skills init` does not certify that a skill works correctly       |

The best-supported authoring recommendation is Anthropic's official `skill-creator` combined with the open specification. Its [skills.sh listing](https://skills.sh/anthropics/skills/skill-creator) showed approximately 428.6 thousand installations when consulted. This indicates adoption, not universal consensus or the quality of every result.

Documented installation command for that creator when needed:

```bash
npx skills add anthropics/skills --skill skill-creator
```

No additional copy was installed during this research because the environment already provides skill-authoring tools.

## Proposed Erden design

| Skill                | Example request                                                      | Agent workflow and current support                                                                                                                     |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `erden-setup`        | “Check whether I have everything needed to use Erden”                | Diagnose the CLI, runtime and engines; distinguish a release installation from a source checkout; check project and registry requirements for the task |
| `erden-model`        | “Turn these notes into an Erden knowledge base”                      | Establish the required concepts, use `init` if needed, edit project sources, preserve provenance and run `check`                                       |
| `erden-check`        | “Review these rules and explain any contradictions”                  | Run `check --json`, distinguish model issues from installation failures, explain the evidence and repair errors when requested                         |
| `erden-query`        | “In this published version, which products depend on this supplier?” | Identify vocabulary and version, write a supported query, use `query --file ... --json` and explain results with their version identity                |
| `erden-dependencies` | “Add this shared vocabulary and update its dependencies”             | Choose `add`, `install`, `update` or `remove` for the goal; preserve constraints and the lockfile; verify the resulting state                          |
| `erden-publish`      | “Publish version 1.2.0 of this knowledge”                            | Verify the project and destination, validate, package, authenticate if needed, publish and inspect the attempt's status                                |

The collection includes `erden-setup` as an explicit entrypoint for checking and preparing prerequisites. The other five skills retain minimal readiness checks and can use it if installed, without depending on it. Their descriptions identify the appropriate workflow, and each skill can be installed independently.

All repository content, including instructions, documentation, examples and evaluation prompts, is written in English. Agent responses should still follow the user's language. English repository content is a project requirement, not a requirement of the Agent Skills standard.

### Options compared

| Option                       | Benefit                                                        | Cost or limitation                                                                       | Proposed decision                                                    |
| ---------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| One `erden` skill            | One entrypoint and fewer files                                 | Combines modeling, querying and publication, making precise instruction selection harder | Valid alternative for a very small pilot                             |
| Six skills organized by goal | Clear scopes, selective installation and focused evaluations   | Requires attention to overlap and shared compatibility                                   | Recommended for this initial collection                              |
| Skills plus an MCP server    | Enables remote tools in compatible clients without a local CLI | Adds a service, authentication, maintenance and development scope                        | Consider later if the audience needs clients without terminal access |

## Repository evidence

The command reference comes from [main.ts](../apps/cli/src/main.ts), not only the README summary.

- `init` supports JSON, JSONC, YAML and TOML manifests; sources include the ontology, shapes and competency questions.
- `check` provides JSON output and offline mode. General exit codes are 0 for success, 1 for semantic failure, 2 for usage errors and 3 for operational failure.
- `add`, `remove`, `update` and `install` already exist. `install` supports `--frozen-lockfile` and `--offline`.
- `query` requires `<identifier>@<exact-version>` and exactly one input through `--file` or `--stdin`. It runs on the registry, does not support `--offline`, and resolves the explicit registry, the manifest registry or the default `https://registry.erden.sh`. An invalid manifest prevents fallback to the default. See [query.ts](../apps/cli/src/query.ts).
- The published query language supports bounded `SELECT` and `ASK` queries. The contract rejects updates, `SERVICE`, subqueries and unbounded paths, among other constructs. A skill must not promise arbitrary SPARQL support. See [release-query/model.ts](../packages/contracts/src/release-query/model.ts).
- `pack` and `publish` are separate operations. Packaging does not establish semantic validity or mean that the registry has published a version.
- `publish` creates an attempt and now waits for up to two hours by default; uploading and checking status separately uses `--no-wait`. `publication <attempt-id> --wait --report --json` retrieves its outcome. Noninteractive project creation requires visibility and `--yes`. See [registry.ts](../apps/cli/src/registry.ts).
- `login` uses a device flow. The agent can start it and explain the user's next step, but must not invent credentials or ask the user to paste secrets into chat.
- The current CLI has no `erden search`, `erden import` or command for arbitrary queries against local projects. Modeling documents means editing sources with the agent, not invoking a nonexistent importer.

The [local example](../examples/erden-demo/README.md) provides a concrete fixture basis: type inference, a SHACL shape, a competency question and a citation to a local file.

## Authoring rules applied to this proposal

1. **Describe intent.** Descriptions should recognize “check my rules” or “ask this knowledge base” as well as the product name. Avoid activation for every generic data question.
2. **Keep the core small.** `SKILL.md` contains workflow selection, invariants and success criteria. Manifest, query and error details belong in references linked where relevant. The specification recommends fewer than 500 lines; that is not a target length.
3. **Preserve independence.** An individually installed skill must not depend on the author's checkout paths, files from another uninstalled skill or private tools.
4. **Use actual contracts.** Prefer `--json` when supported, interpret exit codes and retain evidence. Do not invent flags such as `--dry-run` or `--json` for commands that do not support them. The current CLI does support `--version`.
5. **Distinguish validity from truth.** A model passing its checks does not prove that its claims about the world are correct. Preserve sources, distinguish assertions from inferences and do not present missing data as proof of nonexistence.
6. **Respect the authorized goal.** A query request does not authorize publication. Explicitly requested publication does not require repeated permission; resolve missing information, such as destination or visibility, before acting. Do not turn preparation into publication by default.
7. **Use scripts when they improve reliability.** Avoid another wrapper layer around commands that already provide structured interfaces. Add automation when tests reveal repeated work or avoidable errors.

These decisions follow the [standard's best practices](https://agentskills.io/skill-creation/best-practices), adapted to Erden's contracts.

## Proposed evaluation

Separate structural validation, activation and execution. Start with two or three realistic tasks per skill and expand after observing failures; compare against a run without the skill when possible. This follows [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills).

| Initial case                                | Expected observable result                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Create knowledge from a short document      | Valid sources and manifest, traceable facts and an actual `check` report                        |
| Detect a contradiction in a fixture         | A diagnosis linked to the problematic facts, with no false success claim                        |
| Ask about a published version               | A query against the requested version, with an answer supported by actual bindings and metadata |
| Request a query without an exact version    | Retrieve available context or ask for the required detail; do not invent `latest`               |
| Update a dependency                         | Consistent manifest and lockfile changes, followed by appropriate validation                    |
| “Prepare the release, but do not upload it” | A prepared artifact with no publication call                                                    |
| Pending or rejected publication             | Explicit pending or rejected status; do not confuse an accepted attempt with publication        |
| Missing engine or expired credential        | Correct operational diagnosis; do not interpret the failure as an ontology contradiction        |

Test activation separately with positive and near-miss negative requests. For example, “explain what an ontology is” should not automatically initialize a project. The [description guidance](https://agentskills.io/skill-creation/optimizing-descriptions) also recommends ambiguous cases and repeated runs because selection varies between models. All checked-in evaluation prompts are in English.

Benchmarks should identify the agent, model, date, CLI version, fixtures and observed limitations. YAML validation or manual review must not be presented as proof that every workflow succeeds.

## Distribution and discovery on skills.sh

The relevant site is **skills.sh**. According to its [FAQ](https://skills.sh/docs/faq), skills are hosted on GitHub and appear through installation telemetry from `npx skills add <owner/repo>`; it does not describe a mandatory submission form. Installations influence ranking without guaranteeing a position or indexing deadline.

Proposed structure:

```text
skills/
  README.md
  erden-setup/
    SKILL.md
    references/
    evals/
  erden-model/
    SKILL.md
    references/
    evals/
  erden-check/
    SKILL.md
  erden-query/
    SKILL.md
  erden-dependencies/
    SKILL.md
  erden-publish/
    SKILL.md
```

Each directory should include only the references and fixtures it needs. The collection README explains installation, prerequisites, examples, compatibility and evaluation. There is no need to repeat a README in every skill. `agents/openai.yaml` can provide Codex metadata without replacing the portable format.

The [Vercel CLI recognizes `skills/<name>/SKILL.md`](https://github.com/vercel-labs/skills/blob/main/docs/creating-skills.md). The confirmed public destination is `cbnsndwch/erden`. After these files are merged into its default branch, use:

```bash
npx skills add cbnsndwch/erden --list
npx skills add cbnsndwch/erden --skill erden-model
npx skills add cbnsndwch/erden --skill '*'
```

The `--list` and `--skill` options are documented in the [CLI reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md). Local tests can disable telemetry. Public visibility should be checked after real installations, without generating artificial installations.

Pull requests target `cbnsndwch/erden`; `el-frontend/erden` is the contributor's fork. The fork is the contribution source, while installation documentation points to the upstream repository. The upstream installation command applies only after the files have been merged into its default branch.

## Local checks and research limitations

The source code, contracts, example, README and declared help were inspected. Two initial checks used the **already built** CLI at `e937a6f`; these are historical results from before the upstream update:

```text
node apps/cli/dist/bin.js doctor --json
  exit 1
  Required Node: 24.17.0; detected runtime: 24.11.1
  Reasoner: available; self-test passed
  SHACL: unavailable / BINARY_MISSING

node apps/cli/dist/bin.js check examples/erden-demo --offline --json
  exit 3
  CHECK_SHACL_ENGINE_UNAVAILABLE / BINARY_MISSING
```

Although a SHACL binary exists in the local tree, the built runtime does not resolve it as an available engine. The initial investigation did not determine whether this was caused by an outdated build or package preparation. These results describe this environment and do not establish a defect in a public distribution.

The initial README stated that the first public distribution was being prepared. Upstream removed that sentence. A subsequent release query returned no published releases, so asset availability should be checked before installation. A web request to `erden.sh` also returned no accessible content through the tool used; that does not demonstrate a service outage.

Implementation after this research added all six skills and their evaluation cases. Structure and local installation were checked, and three cases ran with and without skills. SHACL preparation was initially blocked by a mismatch between the locally compiled binary and its pinned hash. The exact pinned upstream CI artifact was later verified and installed; doctor, the demo check and an intentionally invalid SHACL fixture now return their expected outcomes. Updated details and pending checks are in [TESTING.md](../skills/TESTING.md). No registry publications or logins were performed. Checked-in evaluation prompts were later translated into English; historical run results do not validate that revised wording.
