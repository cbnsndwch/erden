# Erden demo

This dependency-free project demonstrates the local workflow. The ontology declares a published artifact, the bundled reasoner infers its superclass type, SHACL validates that inferred fact, the competency question queries it, and citation validation checks this README through the configured local citation root.

From the repository root:

```console
pnpm erden -- check examples/erden-demo --offline
```
