# Project modeling reference

## Initialize or reuse

Use a new target directory whose parent exists. Example values below are for a local example, not an organization's production identity:

```bash
erden init ./supplier-knowledge --canonical-iri https://example.invalid/suppliers --alias @example/suppliers --owned-prefix 'https://example.invalid/suppliers#' --json
```

`init` also accepts `--format json|jsonc|yml|yaml|toml`. Inspect the files it generated before editing. `init` writes `registry: "https://registry.erden.sh"`; preserve that destination unless the task specifies another. Initialization needs a verified reasoner identity for the initial lockfile. It can succeed without SHACL even though a later full check cannot; report a draft's creation separately from its validation.

An existing manifest's important fields are:

```json
{
    "schemaVersion": 1,
    "canonicalIri": "https://example.invalid/suppliers",
    "registry": "https://registry.erden.sh",
    "alias": "@example/suppliers",
    "ownedIriPrefixes": ["https://example.invalid/suppliers#"],
    "sources": {
        "ontology": ["ontology.ttl"],
        "shapes": ["shapes.ttl"],
        "competencyQuestions": ["suppliers.rq"]
    },
    "citationRoots": { "default": "." }
}
```

Add source entries only for files that actually exist. Explicit ontology files can be Turtle, RDF/XML or JSON-LD; directory selectors read Turtle files. Shapes are Turtle and questions are `.rq` files. Keep paths relative to the project. Preserve the manifest's format and unrelated fields.

## Minimal evidence-backed model

This example assumes `notes.md` exists and supports the assertion that Acme is a preferred supplier. Do not create a source citation to an absent file or fabricate its contents.

```turtle
@prefix ex: <https://example.invalid/suppliers#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix ev: <https://erden.sh/o/erden/evidence#> .

<https://example.invalid/suppliers> a owl:Ontology .
ex:Supplier a owl:Class .
ex:PreferredSupplier a owl:Class ; rdfs:subClassOf ex:Supplier .
ev:sourcePath a owl:AnnotationProperty .
ev:sourceRoot a owl:AnnotationProperty .
prov:wasGeneratedBy a owl:ObjectProperty .

ex:acme a ex:PreferredSupplier ; prov:wasGeneratedBy ex:notesObservation .
ex:notesObservation ev:sourcePath "notes.md" ; ev:sourceRoot "default" .
```

Use the source-root mappings that actually exist. Citation warnings such as a missing Git commit are not evidence of falsity; report their actual status. When a document has several unrelated claims, keep the provenance granular enough to show which source supports which assertion.

An example SHACL constraint checks the inferred superclass type:

```turtle
@prefix ex: <https://example.invalid/suppliers#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .

ex:PreferredSupplierShape a sh:NodeShape ;
  sh:targetClass ex:PreferredSupplier ;
  sh:property [ sh:path rdf:type ; sh:hasValue ex:Supplier ] .
```

A corresponding competency question:

```sparql
# @ask     Which suppliers are known?
# @expect  rows == 1
# @from    Acme is a PreferredSupplier and therefore a Supplier.
SELECT ?supplier WHERE {
  ?supplier a <https://example.invalid/suppliers#Supplier>
}
```

`rows == 1` is justified only by this one-supplier fixture. Choose the real expectation from the user's rules, and update it only when those rules or facts change.

## Check boundaries

Erden reasons over a supported profile, not unrestricted OWL. Preserve the default `outsideProfile: refuse` behavior unless the user knowingly requests another policy; changing it to `report` leaves the listed statements unreasoned.

Check the full project after edits. Read `stages`, `reasoning`, diagnostics and `warnings` in its JSON report. Missing dependencies should be restored through `erden install`, within the user's authorized task. Do not hand-edit a lockfile or generated layers.

`erden path <layer> --json` locates derived layers when needed; use layer names exposed by the installed CLI rather than guessing them. A source-checkout CLI can be invoked with `node <checkout>/apps/cli/dist/bin.js` after its runtime packages are built, from the target project's directory.
