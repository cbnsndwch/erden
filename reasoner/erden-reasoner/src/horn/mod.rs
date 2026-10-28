//! The Horn calculus (profile V2 beyond V1): a consequence-based saturation over the request's own
//! class expressions, after Kazakov's calculus for Horn-SHIQ (IJCAI 2009) with cardinality at most
//! one, and named individuals as roots with their property assertions as edges. Every conclusion is
//! a step with a rule and premises that proof checker v3 verifies; nothing the engine says is
//! trusted unchecked. The rules are the ones `reasoner/protocol/src/proof-horn-rules.ts` checks.

mod chain;
mod literal;
mod model;
mod output;
mod saturate;
mod tbox;
mod union;

use crate::{Diagnostic, Refusal, Request, UsedIris, elapsed, engine, engine_refusal};
use model::Expr;
use saturate::{Prem, Saturation, Stop};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::time::Instant;
use tbox::Tbox;

/// Whether an axiom is inside V1 exactly as V1 admits it (`isV1Axiom` in
/// reasoner/protocol/src/expressions.ts): a request of such axioms only runs the 0.2 procedure.
pub(crate) fn is_v1_axiom(axiom: &Value) -> bool {
    let named = |value: &Value| value.get("kind").and_then(Value::as_str) == Some("NamedClass");
    match axiom.get("kind").and_then(Value::as_str) {
        Some("SubClassOf") => named(&axiom["subClass"]) && named(&axiom["superClass"]),
        Some("ClassAssertion") => named(&axiom["classExpression"]),
        Some("EquivalentClasses" | "DisjointClasses") => axiom["classes"]
            .as_array()
            .is_some_and(|classes| classes.iter().all(named)),
        Some("PropertyDomain") => matches!(
            axiom["domain"].get("kind").and_then(Value::as_str),
            Some("NamedClass" | "ObjectUnionOf")
        ),
        Some("PropertyRange") => axiom["range"].is_string(),
        Some(
            "SubObjectPropertyOf"
            | "EquivalentObjectProperties"
            | "FunctionalObjectProperty"
            | "InverseFunctionalObjectProperty"
            | "SymmetricObjectProperty"
            | "SubDataPropertyOf"
            | "EquivalentDataProperties"
            | "FunctionalDataProperty",
        ) => false,
        _ => true,
    }
}

/// Decides a request by the Horn saturation. `asserted` are the request's asserted statements.
pub(crate) fn decide(
    request: &Request,
    started: Instant,
    used: &UsedIris<'_>,
    asserted: Vec<Value>,
) -> Result<Value, Refusal> {
    let axioms = &request.ontology.axioms;
    let mut tbox = Tbox::read(axioms)
        .map_err(|message| engine_refusal("incomplete-certificate", "horn-axiom", message))?;
    if !tbox.unsupported.is_empty() {
        // A property chain that makes the hierarchy non-regular, or counting over a non-simple property.
        return Err(Refusal {
            reason: "unsupported-construct",
            diagnostics: tbox
                .unsupported
                .iter()
                .map(|&(axiom, code)| Diagnostic {
                    code,
                    message: if code == "non-simple-property-in-cardinality" {
                        "This cardinality or functionality limits a property that is transitive or composed by a property chain (directly or through a sub-property), which OWL 2 DL does not allow"
                    } else {
                        "This property chain makes the property hierarchy non-regular, which OWL 2 does not allow"
                    }
                    .into(),
                    axiom_ids: vec![tbox.id(axiom).to_owned()],
                })
                .collect(),
        });
    }
    phase!("horn-read");
    let model = std::mem::take(&mut tbox.model);
    let mut saturation = Saturation::new(&tbox, model);
    for &class in &tbox.classes {
        let expression = saturation.model.intern(Expr::Named(class));
        saturation.context(&[expression]);
    }
    for &individual in &tbox.individuals {
        saturation.individual(individual);
    }
    for assertion in &tbox.class_assertions {
        let node = saturation.individual(assertion.individual);
        saturation.assert_fact(node, assertion.expression, assertion.axiom);
    }
    for edge in &tbox.edges {
        saturation.insert_edge(
            edge.subject,
            edge.property,
            edge.object,
            Prem::Axiom(edge.axiom),
        );
    }
    for data in &tbox.data_assertions {
        let node = saturation.individual(data.subject);
        let literal = saturation.literal(&data.value);
        let property = tbox.data_index[&data.property];
        saturation.insert_data(node, property, literal, Prem::Axiom(data.axiom));
    }
    match saturation.run(|| !elapsed(request, started)) {
        Ok(()) => {}
        Err(Stop::Budget) => {
            return Err(engine_refusal(
                "budget-exhausted",
                "wall-time-budget",
                "Wall-time budget elapsed during the Horn saturation",
            ));
        }
        Err(Stop::NotLocal(axiom, node)) => {
            let element = saturation.element_name(node);
            return Err(Refusal {
                reason: "unsupported-construct",
                diagnostics: vec![Diagnostic {
                    code: "union-domain-not-local",
                    message: format!(
                        "The union domain's cases for {element} reach a conclusion a neighbour would read; deciding it needs disjunctive reasoning"
                    ),
                    axiom_ids: vec![tbox.id(axiom).to_owned()],
                }],
            });
        }
        Err(Stop::ChainBudget) => {
            return Err(engine_refusal(
                "budget-exhausted",
                "max-chain-steps",
                "Property chains need more path steps than one request may take",
            ));
        }
        Err(Stop::TooManyCases) => {
            return Err(engine_refusal(
                "budget-exhausted",
                "max-union-cases",
                "Union domains need more cases than the proof checker accepts",
            ));
        }
    }
    phase!("horn-saturation");
    crate::within_budget(request, started, "after the Horn saturation")?;
    if saturation.inconsistency.is_none() {
        // As in V1, PurRDF decides each literal against the data ranges of its properties; a
        // literal reached through a sub-property is checked against that property's ranges too.
        let mut checked: Vec<Value> = axioms.clone();
        for &(node, property, literal) in &saturation.data_order {
            if let Some(Prem::Step(_)) = saturation.data.get(&(node, property, literal)) {
                checked.push(json!({
                    "kind": "DataPropertyAssertion",
                    "property": saturation.model.iri_text(tbox.data_props[property as usize]),
                    "value": saturation.literals[literal as usize]
                }));
            }
        }
        let individual = engine::fresh_iri(used, "urn:erden-reasoner:check:individual");
        let property = engine::fresh_iri(used, "urn:erden-reasoner:check:property");
        let clashes = engine::check_literals(&checked, &property, &individual)?;
        if !clashes.is_empty() {
            return Err(engine::literal_clash_refusal(
                axioms,
                &clashes,
                literal_uses(&saturation, &tbox, axioms, &engine::clash_keys(&clashes)),
            ));
        }
        // Two literals the checker cannot compare under a functional data property: PurRDF decides
        // whether they are one value. If not, the ontology is inconsistent without a checkable proof.
        for &(left, right) in &saturation.undecided_data {
            let literals = [
                &saturation.literals[left as usize],
                &saturation.literals[right as usize],
            ];
            if !engine::check_functional_values(&property, &individual, literals)? {
                return Err(crate::uncheckable_inconsistency());
            }
        }
        phase!("purrdf-literals");
    }
    let evidence = output::evidence(&saturation, asserted, request.limits.max_inferences)?;
    phase!("horn-output");
    crate::within_budget(request, started, "before certificate binding")?;
    Ok(evidence)
}

/// Every value among `literals` (as [`crate::canonical_text`] writes them) that the saturation
/// gave a subject, asserted or reached through sub-properties or equal individuals, in the order
/// the saturation found them, each with the request axioms its proof rests on.
fn literal_uses<'a>(
    saturation: &'a Saturation,
    tbox: &'a Tbox,
    axioms: &'a [Value],
    literals: &'a HashSet<String>,
) -> impl Iterator<Item = engine::LiteralUse<'a>> {
    let wanted = move |&&(_, _, literal): &&(_, _, u32)| {
        literals.contains(&crate::canonical_text(
            &saturation.literals[literal as usize],
        ))
    };
    saturation
        .data_order
        .iter()
        .filter(wanted)
        .map(move |&key| {
            let (node, property, literal) = key;
            let property = saturation
                .model
                .iri_text(tbox.data_props[property as usize]);
            let leaves = supporting_axioms(saturation, saturation.data[&key]);
            let asserted = leaves
                .iter()
                .map(|&ix| &axioms[ix as usize])
                .find(|axiom| axiom["kind"] == "DataPropertyAssertion")
                .and_then(|axiom| axiom["property"].as_str())
                .unwrap_or(property);
            engine::LiteralUse {
                subject: saturation.element_name(node),
                property,
                asserted,
                value: &saturation.literals[literal as usize],
                axiom_ids: leaves.iter().map(|&ix| tbox.id(ix).to_owned()).collect(),
            }
        })
}

/// The request axioms a premise rests on, the leaves of its proof, each once, in the order a
/// depth-first walk of the proof first cites them.
fn supporting_axioms(saturation: &Saturation, prem: Prem) -> Vec<tbox::AxiomIx> {
    let mut steps = HashSet::new();
    let mut leaves = Vec::new();
    let mut stack = vec![prem];
    while let Some(prem) = stack.pop() {
        match prem {
            Prem::Axiom(axiom) => {
                if !leaves.contains(&axiom) {
                    leaves.push(axiom);
                }
            }
            Prem::Step(step) => {
                if steps.insert(step) {
                    stack.extend(saturation.steps[step as usize].premises.iter().rev());
                }
            }
        }
    }
    leaves
}
