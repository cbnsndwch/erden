# Erden Agent Skills

Use Erden through natural-language requests in an agent that can read files and run commands. The agent selects the relevant skill, operates the Erden CLI, and explains the actual result in your language.

| Skill                                             | What you can ask                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [erden-setup](erden-setup/SKILL.md)               | “Check whether my machine is ready for Erden.” / “Prepara todo lo necesario para usar Erden.”                |
| [erden-model](erden-model/SKILL.md)               | “Turn these supplier rules into Erden knowledge.” / “Convierte estas notas en conocimiento reutilizable.”    |
| [erden-check](erden-check/SKILL.md)               | “Validate this project and explain its errors.” / “Valida estas reglas sin cambiar archivos.”                |
| [erden-query](erden-query/SKILL.md)               | “Ask this published release which products use this supplier.” / “Consulta los proveedores de esta versión.” |
| [erden-dependencies](erden-dependencies/SKILL.md) | “Restore the exact locked dependencies offline.” / “Actualiza este vocabulario compartido.”                  |
| [erden-publish](erden-publish/SKILL.md)           | “Prepare version 1.2.0 without uploading.” / “Publica esta versión en el registro indicado.”                 |

## Install from this checkout

From the repository root, list the available skills:

```bash
npx skills add ./ --list
```

Install the collection, or just the environment-readiness skill:

```bash
npx skills add ./ --skill '*'
npx skills add ./ --skill erden-setup
```

The CLI lets you select the target agents. Add `--agent codex` or `--agent claude-code` to select one explicitly. Its default scope is the current project; use `--global` only if you want a user-wide installation. The current Vercel skills CLI requires Node 22.20 or later to run its installer; this is separate from the runtime bundled with an Erden release.

Each skill is self-contained and can be installed independently. References stay inside its own directory. The optional `agents/openai.yaml` files provide Codex UI metadata; the core instructions use the open Agent Skills format.

## Runtime prerequisites

Installing a skill installs instructions, not Erden. A compatible agent needs terminal and filesystem access. Run `erden-setup` first if the runtime is not ready. Release archives bundle the CLI, Node and the reasoner/SHACL engines; a source checkout needs the toolchains described in the [project README](../README.md).

Full local validation needs working engines and available dependency artifacts; project initialization and packaging have narrower requirements. Queries run against an exact published version on a registry. Registry operations need network access, and private resources/publication need the appropriate authorization. No skill bundles credentials or installs a background service.

This collection targets CLI package `0.1.0` and the interface at upstream commit `1dc6fd0`. Initial evaluation results from `e937a6f` are labeled historical in TESTING.md; registry defaults and publication behavior were updated for the upstream interface. Verify the selected release assets before installation.

## Publishing the collection on skills.sh

The canonical source is [cbnsndwch/erden](https://github.com/cbnsndwch/erden). The Vercel CLI discovers `skills/<name>/SKILL.md`; no npm package or proprietary skill archive is required for that distribution route. Once these files are merged into the upstream default branch, the installation command is:

```text
npx skills add cbnsndwch/erden --skill '*'
```

Contributions should target `cbnsndwch/erden`; a contributor's fork is the pull request source, not the canonical installation source. Before upstream integration, use the local-checkout instructions above to try the collection. Opening a pull request does not make the skills available from the upstream default branch or establish a skills.sh listing.

According to the [skills.sh FAQ](https://skills.sh/docs/faq), listing is driven by real installations through `npx skills add`, with aggregate installation telemetry contributing to ranking. Publication of a repository does not guarantee a ranking or an indexing deadline. Do not generate artificial installations to inflate it.

After public integration, test listing and installation from a clean project, verify the resulting skills.sh entry, and add its actual link and an optional install-count badge to the repository. Keep telemetry disabled for local validation when desired; such tests are not evidence of public indexing.

## Maintain and evaluate

See [TESTING.md](TESTING.md) for validation commands, the initial evaluation set, observed results and remaining gaps. Update the relevant skill whenever a CLI flag, JSON contract, runtime prerequisite or semantic policy changes. Run formatting, structural validation, installation checks and the affected behavioral cases before release.

The collection includes 18 initial behavioral cases and 36 trigger/non-trigger examples across Spanish and English. Their presence is not a claim that every case has run. Trigger selection also depends on the agent/model, so validate the clients you intend to advertise.

Authoring follows the [Agent Skills specification](https://agentskills.io/specification), its [creation guidance](https://agentskills.io/skill-creation/best-practices), and the [skill-creator evaluation workflow](https://github.com/anthropics/skills/tree/main/skills/skill-creator). The project-specific research and tradeoffs are recorded in [skills-research.md](../docs/skills-research.md).

## License

These skills and their original evaluation fixtures are Apache-2.0, under the repository's [LICENSE](../LICENSE), [NOTICE](../NOTICE) and REUSE attribution. The Erden name remains subject to the project's [trademark policy](../TRADEMARKS.md).
