//! The answer read off a saturation: the inferred statements, the lemmas their proofs need, the
//! unsatisfiable classes and the inconsistency evidence, each step written once with its premises.

use super::model::{Expr, ExprId};
use super::saturate::{Conclusion, Inconsistency, NodeId, NodeKind, Prem, Saturation, StepId};
use crate::{
    Refusal, decided_evidence, engine_refusal, sort_statements, sort_unsatisfiable_classes,
    sort_utf16,
};
use serde_json::{Value, json};
use std::collections::HashMap;

const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUBCLASS: &str = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const OWL_SAME_AS: &str = "http://www.w3.org/2002/07/owl#sameAs";

const ZERO_DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

/// What a step is written as: an RDF statement, or a lemma.
enum Shape {
    Statement(String, String, Value),
    Lemma(Value),
}

/// A proof step added while writing: its rule, premises, node and class.
struct Extra {
    rule: &'static str,
    premises: Vec<Prem>,
    node: NodeId,
    expression: ExprId,
}

struct Writer<'s, 't> {
    saturation: &'s Saturation<'t>,
    /// Steps added while writing. A `conjunct` step turns an asserted `owl:Nothing` into a proof
    /// step, or states `A ⊑ A` for a named class in a cycle of named subsumptions, as V1 lists it.
    /// A `told` step states `X ⊑ owl:Thing` (or `x rdf:type owl:Thing`) through a told
    /// `B ⊑ owl:Thing`, as V1 lists it; the saturation itself never cites `owl:Thing`.
    extra: Vec<Extra>,
}

impl Writer<'_, '_> {
    fn iri(&self, sym: u32) -> String {
        self.saturation.model.iri_text(sym).to_owned()
    }

    fn named_iri(&self, expression: ExprId) -> Option<&str> {
        self.saturation.model.named_iri(expression)
    }

    /// The RDF statement a class fact is, if it is one the answer lists.
    fn class_statement(&self, node: NodeId, expression: ExprId) -> Option<(String, String, Value)> {
        self.statement_of(node, expression, false)
    }

    /// The RDF statement a class fact is; `owl:Thing` as the object only when `thing` is set.
    fn statement_of(
        &self,
        node: NodeId,
        expression: ExprId,
        thing: bool,
    ) -> Option<(String, String, Value)> {
        let object = self.named_iri(expression)?;
        if (object == super::model::OWL_THING && !thing) || object == super::model::OWL_NOTHING {
            return None;
        }
        match &self.saturation.nodes[node as usize].kind {
            NodeKind::Individual(sym) => Some((
                self.iri(*sym),
                RDF_TYPE.into(),
                Value::String(object.to_owned()),
            )),
            NodeKind::Context {
                expression: own, ..
            } => {
                let subject = self.named_iri(*own)?;
                if subject == super::model::OWL_THING || subject == super::model::OWL_NOTHING {
                    return None;
                }
                Some((
                    subject.to_owned(),
                    RDFS_SUBCLASS.into(),
                    Value::String(object.to_owned()),
                ))
            }
        }
    }

    fn lemma_conclusion(&self, node: NodeId, expression: ExprId) -> Value {
        let model = &self.saturation.model;
        match &self.saturation.nodes[node as usize].kind {
            NodeKind::Individual(sym) => json!({
                "classExpression": model.to_json(expression),
                "individual": self.iri(*sym),
                "kind": "ClassAssertion"
            }),
            NodeKind::Context {
                expression: own, ..
            } => json!({
                "kind": "SubClassOf",
                "subClass": model.to_json(*own),
                "superClass": model.to_json(expression)
            }),
        }
    }

    fn shape(&self, conclusion: &Conclusion) -> Shape {
        match *conclusion {
            Conclusion::Class(node, expression) => match self.class_statement(node, expression) {
                Some((subject, predicate, object)) => Shape::Statement(subject, predicate, object),
                None => Shape::Lemma(self.lemma_conclusion(node, expression)),
            },
            Conclusion::Edge(subject, property, object) => Shape::Statement(
                self.iri(subject),
                self.iri(property),
                Value::String(self.iri(object)),
            ),
            Conclusion::Same(left, right) => Shape::Statement(
                self.node_iri(left),
                OWL_SAME_AS.into(),
                Value::String(self.node_iri(right)),
            ),
            Conclusion::Data(node, property, literal) => Shape::Statement(
                self.node_iri(node),
                self.iri(self.saturation.idx.data_props[property as usize]),
                self.saturation.literals[literal as usize].clone(),
            ),
        }
    }

    fn node_iri(&self, node: NodeId) -> String {
        match self.saturation.nodes[node as usize].kind {
            NodeKind::Individual(sym) => self.iri(sym),
            NodeKind::Context { .. } => unreachable!("only individuals are the same"),
        }
    }

    /// A proof step concluding `node ⊑ owl:Nothing`: the fact's own step, or a `conjunct` step
    /// citing the axiom that asserts it.
    fn nothing_step(&mut self, node: NodeId) -> Prem {
        let nothing = self.saturation.idx.nothing;
        match self.saturation.nodes[node as usize].why(nothing) {
            Some(Prem::Step(step)) => Prem::Step(step),
            Some(Prem::Axiom(axiom)) => self.conjunct(vec![Prem::Axiom(axiom)], node, nothing),
            None => unreachable!("owl:Nothing is never implicit"),
        }
    }
}

impl Writer<'_, '_> {
    fn conjunct(&mut self, premises: Vec<Prem>, node: NodeId, expression: ExprId) -> Prem {
        self.add_extra("conjunct", premises, node, expression)
    }

    fn add_extra(
        &mut self,
        rule: &'static str,
        premises: Vec<Prem>,
        node: NodeId,
        expression: ExprId,
    ) -> Prem {
        let id = (self.saturation.steps.len() + self.extra.len()) as StepId;
        self.extra.push(Extra {
            rule,
            premises,
            node,
            expression,
        });
        Prem::Step(id)
    }

    /// `X ⊑ owl:Thing` for `X` a named class or an individual that holds a named `B` with a told
    /// `B ⊑ owl:Thing`, by `told`: V1 lists these (`subclass-transitive`, `subclass-type`), so the
    /// Horn answer does too. A class that is `B` itself states it already, so it gets none.
    fn thing_statement(&mut self, node: NodeId, supers: &[(ExprId, u32)]) -> Option<Prem> {
        let saturation = self.saturation;
        let entry = &saturation.nodes[node as usize];
        let own = match entry.kind {
            NodeKind::Individual(_) => None,
            NodeKind::Context { expression, .. } => {
                self.named_iri(expression)?;
                Some(expression)
            }
        };
        let thing = saturation.idx.thing;
        for &(class, axiom) in supers {
            if Some(class) == own || !saturation.holds(node, class) {
                continue;
            }
            let Some(why) = entry.why(class) else {
                continue;
            };
            return Some(self.add_extra("told", vec![why, Prem::Axiom(axiom)], node, thing));
        }
        None
    }

    /// `A ⊑ A` for a named class `A` with a named `B ≠ A`, `A ⊑ B` and `B ⊑ A`: V1 lists these.
    fn reflexive(&mut self, node: NodeId, own: ExprId) -> Option<Prem> {
        let saturation = self.saturation;
        let entry = &saturation.nodes[node as usize];
        for &other in &entry.order {
            if other == own || self.class_statement(node, other).is_none() {
                continue;
            }
            let Some(back) = saturation.context_of(other) else {
                continue;
            };
            if !saturation.holds(back, own) {
                continue;
            }
            let premises: Vec<Prem> = [entry.why(other), saturation.nodes[back as usize].why(own)]
                .into_iter()
                .flatten()
                .collect();
            return Some(self.conjunct(premises, node, own));
        }
        None
    }
}

/// A step of the written answer: its rule, premises and shape.
struct Written<'a> {
    rule: &'static str,
    premises: &'a [Prem],
}

/// The decided evidence of a saturated request (not yet bound to a certificate).
pub(crate) fn evidence(
    saturation: &Saturation<'_>,
    asserted: Vec<Value>,
    max_inferences: u64,
) -> Result<Value, Refusal> {
    let mut writer = Writer {
        saturation,
        extra: Vec::new(),
    };
    let steps = &saturation.steps;
    let mut roots: Vec<StepId> = Vec::new();
    let mut unsatisfiable: Vec<(String, Prem)> = Vec::new();
    let mut diagnostic: Option<(&'static str, &'static str, Vec<Prem>)> = None;
    match &saturation.inconsistency {
        Some(Inconsistency::Nothing(node)) => {
            let prem = writer.nothing_step(*node);
            diagnostic = Some((
                "derived-inconsistency",
                "An individual, or every element, is proved to be in owl:Nothing",
                vec![prem],
            ));
        }
        Some(Inconsistency::DataClash(premises)) => {
            diagnostic = Some((
                "functional-data-clash",
                "A functional data property has two different values for one individual",
                premises.clone(),
            ));
        }
        None => {
            for (id, step) in steps.iter().enumerate() {
                if matches!(writer.shape(&step.conclusion), Shape::Statement(..)) {
                    roots.push(id as StepId);
                }
            }
            let nothing = saturation.idx.nothing;
            let thing = saturation.idx.thing;
            let mut supers: Vec<(ExprId, u32)> = saturation
                .idx
                .told
                .iter()
                .filter(|(sub, _)| {
                    **sub != thing && matches!(saturation.model.expr(**sub), Expr::Named(_))
                })
                .flat_map(|(&sub, told)| {
                    told.iter()
                        .filter(|(_, sup)| *sup == thing)
                        .map(move |&(axiom, _)| (sub, axiom))
                })
                .collect();
            supers.sort_by_key(|&(_, axiom)| axiom);
            if !supers.is_empty() {
                let mut individuals: Vec<NodeId> =
                    saturation.individuals.values().copied().collect();
                individuals.sort_unstable();
                for node in individuals {
                    if let Some(Prem::Step(step)) = writer.thing_statement(node, &supers) {
                        roots.push(step);
                    }
                }
            }
            for &class in &saturation.idx.classes {
                let Some(expression) = saturation.model.find(&Expr::Named(class)) else {
                    continue;
                };
                let Some(node) = saturation.context_of(expression) else {
                    continue;
                };
                if saturation.holds(node, nothing) {
                    let prem = writer.nothing_step(node);
                    unsatisfiable.push((writer.iri(class), prem));
                }
                if let Some(Prem::Step(step)) = writer.reflexive(node, expression) {
                    roots.push(step);
                }
                if let Some(Prem::Step(step)) = writer.thing_statement(node, &supers) {
                    roots.push(step);
                }
            }
        }
    }
    // Every step a root, an unsatisfiable class or the diagnostic needs, depth first.
    let total = steps.len() + writer.extra.len();
    let written = |id: usize| -> Written<'_> {
        if id < steps.len() {
            Written {
                rule: steps[id].rule,
                premises: &steps[id].premises,
            }
        } else {
            let extra = &writer.extra[id - steps.len()];
            Written {
                rule: extra.rule,
                premises: &extra.premises,
            }
        }
    };
    let mut needed = vec![false; total];
    let mut pending: Vec<usize> = roots.iter().map(|&id| id as usize).collect();
    pending.extend(unsatisfiable.iter().filter_map(|(_, prem)| match prem {
        Prem::Step(id) => Some(*id as usize),
        Prem::Axiom(_) => None,
    }));
    if let Some((_, _, premises)) = &diagnostic {
        pending.extend(premises.iter().filter_map(|prem| match prem {
            Prem::Step(id) => Some(*id as usize),
            Prem::Axiom(_) => None,
        }));
    }
    while let Some(id) = pending.pop() {
        if needed[id] {
            continue;
        }
        needed[id] = true;
        for prem in written(id).premises {
            if let Prem::Step(step) = prem
                && !needed[*step as usize]
            {
                pending.push(*step as usize);
            }
        }
    }
    // Shapes; statements are numbered in their sorted order, lemmas in step order.
    let mut statements: Vec<(usize, String, String, Value)> = Vec::new();
    let mut lemma_ids: HashMap<usize, String> = HashMap::new();
    let mut lemmas: Vec<(usize, Value)> = Vec::new();
    for (id, &is_needed) in needed.iter().enumerate() {
        if !is_needed {
            continue;
        }
        let shape = if id < steps.len() {
            writer.shape(&steps[id].conclusion)
        } else {
            let extra = &writer.extra[id - steps.len()];
            match writer.statement_of(extra.node, extra.expression, extra.rule == "told") {
                Some((subject, predicate, object)) => Shape::Statement(subject, predicate, object),
                None => Shape::Lemma(writer.lemma_conclusion(extra.node, extra.expression)),
            }
        };
        match shape {
            Shape::Statement(subject, predicate, object) => {
                statements.push((id, subject, predicate, object));
            }
            Shape::Lemma(conclusion) => {
                lemma_ids.insert(id, format!("lemma:{}", lemmas.len() + 1));
                lemmas.push((id, conclusion));
            }
        }
    }
    if (statements.len() + lemmas.len()) as u64 > max_inferences {
        return Err(engine_refusal(
            "budget-exhausted",
            "max-inferences",
            "Inference output limit reached before closure",
        ));
    }
    let mut keyed: Vec<(Box<[u16]>, usize)> = statements
        .iter()
        .enumerate()
        .map(|(position, (_, subject, predicate, object))| {
            let mut parts = vec![subject.as_str(), "\0", predicate.as_str(), "\0"];
            parts.extend(crate::statement_object_key_parts(object));
            (crate::utf16_key(&parts), position)
        })
        .collect();
    keyed.sort();
    let mut statement_ids: HashMap<usize, String> = HashMap::new();
    for (number, (_, position)) in keyed.iter().enumerate() {
        statement_ids.insert(statements[*position].0, format!("inferred:{}", number + 1));
    }
    let axiom_id = |axiom: u32| saturation.idx.id(axiom).to_owned();
    let premise_ids = |premises: &[Prem]| -> Vec<String> {
        let mut ids: Vec<String> = premises
            .iter()
            .map(|prem| match prem {
                Prem::Axiom(axiom) => axiom_id(*axiom),
                Prem::Step(step) => statement_ids
                    .get(&(*step as usize))
                    .or_else(|| lemma_ids.get(&(*step as usize)))
                    .expect("every cited step is written")
                    .clone(),
            })
            .collect();
        sort_utf16(&mut ids);
        ids.dedup();
        ids
    };
    let mut inferred: Vec<Value> = Vec::with_capacity(statements.len());
    for (id, subject, predicate, object) in statements {
        let step = written(id);
        inferred.push(json!({
            "graph": {"kind": "DefaultGraph"},
            "id": statement_ids[&id],
            "object": object,
            "predicate": predicate,
            "provenance": {
                "justificationDigest": ZERO_DIGEST,
                "kind": "inferred",
                "premiseIds": premise_ids(step.premises),
                "rule": step.rule
            },
            "subject": subject
        }));
    }
    sort_statements(&mut inferred);
    let mut lemma_values: Vec<(String, Value)> = lemmas
        .into_iter()
        .map(|(id, conclusion)| {
            let step = written(id);
            let lemma_id = lemma_ids[&id].clone();
            (
                lemma_id.clone(),
                json!({
                    "conclusion": conclusion,
                    "id": lemma_id,
                    "justificationDigest": ZERO_DIGEST,
                    "premiseIds": premise_ids(step.premises),
                    "rule": step.rule
                }),
            )
        })
        .collect();
    lemma_values.sort_by(|left, right| crate::cmp_utf16(&left.0, &right.0));
    let lemma_values: Vec<Value> = lemma_values.into_iter().map(|(_, value)| value).collect();
    let mut unsatisfiable_values: Vec<Value> = unsatisfiable
        .iter()
        .map(|(class, prem)| {
            json!({
                "classIri": class,
                "justificationDigest": ZERO_DIGEST,
                "premiseIds": premise_ids(std::slice::from_ref(prem))
            })
        })
        .collect();
    sort_unsatisfiable_classes(&mut unsatisfiable_values);
    let (consistency, diagnostics) = match diagnostic {
        Some((code, message, premises)) => (
            "inconsistent",
            vec![json!({
                "axiomIds": premise_ids(&premises),
                "code": code,
                "message": message,
                "severity": "error"
            })],
        ),
        None => ("consistent", Vec::new()),
    };
    let mut evidence = decided_evidence(
        asserted,
        consistency,
        diagnostics,
        inferred,
        unsatisfiable_values,
    );
    if !lemma_values.is_empty() {
        evidence
            .as_object_mut()
            .expect("decided evidence is an object")
            .insert("lemmas".into(), Value::Array(lemma_values));
    }
    Ok(evidence)
}
