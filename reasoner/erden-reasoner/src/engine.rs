//! The V1 decision procedure: hierarchy classification and per-individual consistency.
//!
//! The V1 profile has no class restriction, cardinality, nominal or property hierarchy, so
//! individuals interact only through the typing that domains, ranges, inverses and transitivity
//! give their property assertions. Erden's closure applies that typing with proofs. What is left
//! is independent per individual: PurRDF decides the class hierarchy once, each distinct
//! individual signature (its closure types plus one union per union-domain assertion) that the
//! classification does not already answer once, and each data range against the literals
//! asserted under it. The inferred statements are the closure's plus the types its rules cannot
//! reach (`type_individuals`); for V1 that is exact, since an individual's types depend only on
//! its own signature.

use super::*;
use purrdf_core::TermId;
use purrdf_entail::{Certified, ClassHierarchy, EntailError};
use std::collections::HashSet;

const OWL_CLASS: &str = "http://www.w3.org/2002/07/owl#Class";
const OWL_DATATYPE_PROPERTY: &str = "http://www.w3.org/2002/07/owl#DatatypeProperty";
const OWL_FUNCTIONAL_PROPERTY: &str = "http://www.w3.org/2002/07/owl#FunctionalProperty";
const OWL_INTERSECTION: &str = "http://www.w3.org/2002/07/owl#intersectionOf";

/// At most this many literals share one data-range check, so no single PurRDF run grows with the
/// package while the number of runs stays far below one per literal.
const LITERALS_PER_CHECK: usize = 256;

/// The most operand combinations one individual's union domains may have. Its types are listed
/// by case analysis over every combination, and the proof checker repeats that analysis, so a
/// larger product is refused rather than left unlisted.
pub(crate) const MAX_UNION_CASES: usize = 4_096;

// #region Closure

/// Property and class axioms the closure rules read, indexed by the term a new fact matches on.
#[derive(Default)]
struct RuleIndex<'a> {
    domains: HashMap<&'a str, Vec<(&'a str, &'static str, &'a Value)>>,
    ranges: HashMap<&'a str, Vec<(&'a str, &'a Value)>>,
    equivalents: HashMap<&'a str, Vec<(&'a str, Vec<&'a str>)>>,
    inverses: HashMap<&'a str, Vec<(&'a str, &'a str, &'a str)>>,
    transitive: HashMap<&'a str, Vec<&'a str>>,
}

impl<'a> RuleIndex<'a> {
    fn new(axioms: &'a [Value], queue: &mut BTreeSet<Candidate>) -> Self {
        let mut index = Self::default();
        for axiom in axioms {
            let id = axiom["id"].as_str().expect("preflight id");
            match axiom["kind"].as_str().expect("preflight kind") {
                "PropertyDomain" if axiom["domain"]["kind"] == "NamedClass" => {
                    let rule = match axiom["propertyKind"].as_str() {
                        Some("ObjectProperty") => "object-property-domain",
                        Some("DataProperty") => "data-property-domain",
                        _ => continue,
                    };
                    let property = axiom["property"].as_str().expect("preflight property");
                    index.domains.entry(property).or_default().push((
                        id,
                        rule,
                        &axiom["domain"]["iri"],
                    ));
                }
                "PropertyRange" if axiom["propertyKind"] == "ObjectProperty" => {
                    let property = axiom["property"].as_str().expect("preflight property");
                    index
                        .ranges
                        .entry(property)
                        .or_default()
                        .push((id, &axiom["range"]));
                }
                "EquivalentClasses" => {
                    let classes: Vec<&str> = axiom["classes"]
                        .as_array()
                        .expect("preflight classes")
                        .iter()
                        .map(|item| item["iri"].as_str().expect("preflight named class"))
                        .collect();
                    for &left in &classes {
                        for &right in &classes {
                            if left != right {
                                add_candidate(
                                    queue,
                                    left,
                                    RDFS_SUBCLASS,
                                    Value::String(right.to_owned()),
                                    "equivalent-class-subclass",
                                    vec![id.to_owned()],
                                );
                            }
                        }
                    }
                    let mut members = classes.clone();
                    members.sort_unstable();
                    members.dedup();
                    for class in members {
                        index
                            .equivalents
                            .entry(class)
                            .or_default()
                            .push((id, classes.clone()));
                    }
                }
                "InverseObjectProperties" => {
                    let left = axiom["left"].as_str().expect("preflight left");
                    let right = axiom["right"].as_str().expect("preflight right");
                    index
                        .inverses
                        .entry(left)
                        .or_default()
                        .push((id, left, right));
                    if right != left {
                        index
                            .inverses
                            .entry(right)
                            .or_default()
                            .push((id, left, right));
                    }
                }
                "TransitiveObjectProperty" => {
                    let property = axiom["property"].as_str().expect("preflight property");
                    index.transitive.entry(property).or_default().push(id);
                }
                _ => {}
            }
        }
        index
    }
}

/// Facts indexed by the terms the two-premise rules join on.
#[derive(Default)]
struct FactIndex {
    facts: Vec<Fact>,
    subclass_by_subject: HashMap<String, Vec<usize>>,
    named_subclass_by_object: HashMap<String, Vec<usize>>,
    named_type_by_class: HashMap<String, Vec<usize>>,
    named_by_predicate_subject: HashMap<(String, String), Vec<usize>>,
    named_by_predicate_object: HashMap<(String, String), Vec<usize>>,
}

impl FactIndex {
    fn insert(&mut self, fact: Fact) -> usize {
        let position = self.facts.len();
        let object = fact.object.as_str().map(str::to_owned);
        if fact.predicate == RDFS_SUBCLASS {
            self.subclass_by_subject
                .entry(fact.subject.clone())
                .or_default()
                .push(position);
            if let Some(object) = &object {
                self.named_subclass_by_object
                    .entry(object.clone())
                    .or_default()
                    .push(position);
            }
        }
        if let Some(object) = object {
            if fact.predicate == RDF_TYPE {
                self.named_type_by_class
                    .entry(object.clone())
                    .or_default()
                    .push(position);
            }
            self.named_by_predicate_subject
                .entry((fact.predicate.clone(), fact.subject.clone()))
                .or_default()
                .push(position);
            self.named_by_predicate_object
                .entry((fact.predicate.clone(), object))
                .or_default()
                .push(position);
        }
        self.facts.push(fact);
        position
    }

    fn at<'a>(
        &'a self,
        map: &'a HashMap<String, Vec<usize>>,
        key: &str,
    ) -> impl Iterator<Item = &'a Fact> + 'a {
        map.get(key)
            .into_iter()
            .flatten()
            .map(|&position| &self.facts[position])
    }

    fn at_pair<'a>(
        &'a self,
        map: &'a HashMap<(String, String), Vec<usize>>,
        predicate: &str,
        term: &str,
    ) -> impl Iterator<Item = &'a Fact> + 'a {
        map.get(&(predicate.to_owned(), term.to_owned()))
            .into_iter()
            .flatten()
            .map(|&position| &self.facts[position])
    }
}

/// Queues one candidate unless its statement is already a fact.
///
/// Facts only grow, so a candidate whose statement is a fact would never be chosen; skipping it
/// here instead of when it is popped changes nothing but the work and memory it would cost.
fn offer(
    queue: &mut BTreeSet<Candidate>,
    known: &BTreeMap<String, Fact>,
    subject: &str,
    predicate: &str,
    object: &Value,
    rule: &'static str,
    premises: impl FnOnce() -> Vec<String>,
) {
    let key = fact_key(subject, predicate, object);
    if !known.contains_key(&key) {
        insert_candidate(
            queue,
            key,
            subject,
            predicate,
            object.clone(),
            rule,
            premises(),
        );
    }
}

/// Every candidate in which the fact at `position` takes part, joined with the facts indexed so far.
///
/// The fact is indexed before this runs, so a fact that joins with itself is included. Across the
/// whole run every pair of premises is therefore met once, when its later premise is indexed.
fn derive(
    index: &FactIndex,
    rules: &RuleIndex<'_>,
    position: usize,
    known: &BTreeMap<String, Fact>,
    queue: &mut BTreeSet<Candidate>,
) {
    let fact = &index.facts[position];
    let subject = fact.subject.as_str();
    let predicate = fact.predicate.as_str();
    let premise = || fact.premise_id.clone();
    let object_iri = fact.object.as_str();
    if predicate == RDF_TYPE
        && let Some(class) = object_iri
    {
        for right in index.at(&index.subclass_by_subject, class) {
            offer(
                queue,
                known,
                subject,
                RDF_TYPE,
                &right.object,
                "subclass-type",
                || vec![premise(), right.premise_id.clone()],
            );
        }
        for (axiom_id, classes) in rules.equivalents.get(class).into_iter().flatten() {
            for &equivalent in classes {
                if equivalent != class {
                    offer(
                        queue,
                        known,
                        subject,
                        RDF_TYPE,
                        &Value::String(equivalent.to_owned()),
                        "equivalent-class-type",
                        || vec![(*axiom_id).to_owned(), premise()],
                    );
                }
            }
        }
    }
    if predicate == RDFS_SUBCLASS {
        for left in index.at(&index.named_type_by_class, subject) {
            offer(
                queue,
                known,
                &left.subject,
                RDF_TYPE,
                &fact.object,
                "subclass-type",
                || vec![left.premise_id.clone(), premise()],
            );
        }
        if let Some(middle) = object_iri {
            for right in index.at(&index.subclass_by_subject, middle) {
                offer(
                    queue,
                    known,
                    subject,
                    RDFS_SUBCLASS,
                    &right.object,
                    "subclass-transitive",
                    || vec![premise(), right.premise_id.clone()],
                );
            }
        }
        for left in index.at(&index.named_subclass_by_object, subject) {
            offer(
                queue,
                known,
                &left.subject,
                RDFS_SUBCLASS,
                &fact.object,
                "subclass-transitive",
                || vec![left.premise_id.clone(), premise()],
            );
        }
    }
    for (axiom_id, rule, domain) in rules.domains.get(predicate).into_iter().flatten() {
        let applies = if *rule == "object-property-domain" {
            fact.object.is_string()
        } else {
            fact.object.is_object()
        };
        if applies {
            offer(queue, known, subject, RDF_TYPE, domain, rule, || {
                vec![(*axiom_id).to_owned(), premise()]
            });
        }
    }
    let Some(object) = object_iri else {
        return;
    };
    for (axiom_id, range) in rules.ranges.get(predicate).into_iter().flatten() {
        offer(
            queue,
            known,
            object,
            RDF_TYPE,
            range,
            "object-property-range",
            || vec![(*axiom_id).to_owned(), premise()],
        );
    }
    for (axiom_id, left, right) in rules.inverses.get(predicate).into_iter().flatten() {
        let inverse = if predicate == *left { right } else { left };
        offer(
            queue,
            known,
            object,
            inverse,
            &Value::String(subject.to_owned()),
            "inverse-object-property",
            || vec![(*axiom_id).to_owned(), premise()],
        );
    }
    for axiom_id in rules.transitive.get(predicate).into_iter().flatten() {
        for right in index.at_pair(&index.named_by_predicate_subject, predicate, object) {
            offer(
                queue,
                known,
                subject,
                predicate,
                &right.object,
                "transitive-object-property",
                || vec![(*axiom_id).to_owned(), premise(), right.premise_id.clone()],
            );
        }
        for left in index.at_pair(&index.named_by_predicate_object, predicate, subject) {
            offer(
                queue,
                known,
                &left.subject,
                predicate,
                &fact.object,
                "transitive-object-property",
                || vec![(*axiom_id).to_owned(), left.premise_id.clone(), premise()],
            );
        }
    }
}

/// Saturates `facts` under the V1 rules, adding one statement at a time with its proof. The
/// statements come back in derivation order; the caller sorts the final list once.
///
/// Each step adds the least candidate (in `cmp_candidate` order) whose statement is not yet a
/// fact, exactly as the 0.1 engine did by recomputing every candidate on every step. Facts only
/// grow, so a candidate that was not chosen stays a candidate: keeping all of them in one ordered
/// queue and deriving only from the newest fact yields the same sequence, identifiers and proofs.
pub(crate) fn close_facts(
    axioms: &[Value],
    facts: &mut BTreeMap<String, Fact>,
    max_inferences: u64,
) -> Result<Vec<Value>, Refusal> {
    let mut queue = BTreeSet::new();
    let rules = RuleIndex::new(axioms, &mut queue);
    let mut index = FactIndex::default();
    for fact in facts.values() {
        let position = index.insert(fact.clone());
        derive(&index, &rules, position, facts, &mut queue);
    }
    let mut inferred = Vec::new();
    while let Some(candidate) = queue.pop_first() {
        if facts.contains_key(&candidate.key) {
            continue;
        }
        if inferred.len() as u64 >= max_inferences {
            return Err(engine_refusal(
                "budget-exhausted",
                "max-inferences",
                "Inference output limit reached before closure",
            ));
        }
        let id = format!("inferred:{}", inferred.len() + 1);
        let mut premises = candidate.premises;
        sort_dedup_utf16(&mut premises);
        let fact = Fact {
            subject: candidate.subject,
            predicate: candidate.predicate,
            object: candidate.object,
            premise_id: id.clone(),
        };
        inferred.push(json!({
            "graph": {"kind": "DefaultGraph"},
            "id": id,
            "object": fact.object,
            "predicate": fact.predicate,
            "provenance": {"justificationDigest": format!("sha256:{}", "0".repeat(64)), "kind": "inferred", "premiseIds": premises, "rule": candidate.rule},
            "subject": fact.subject
        }));
        facts.insert(candidate.key, fact.clone());
        let position = index.insert(fact);
        derive(&index, &rules, position, facts, &mut queue);
    }
    Ok(inferred)
}

// #endregion

// #region Datasets

/// The axioms PurRDF classifies: class, property and datatype declarations, `SubClassOf`,
/// `EquivalentClasses` and `DisjointClasses`. Every other V1 axiom holds when every property is
/// empty, so leaving it out changes no subsumption and no class satisfiability.
pub(crate) fn hierarchy_axioms(axioms: &[Value]) -> Vec<&Value> {
    axioms
        .iter()
        .filter(|axiom| match axiom["kind"].as_str() {
            Some("SubClassOf" | "EquivalentClasses" | "DisjointClasses") => true,
            Some("Declaration") => !matches!(
                axiom["entityKind"].as_str(),
                Some("NamedIndividual" | "Ontology")
            ),
            _ => false,
        })
        .collect()
}

fn hierarchy_builder(hierarchy: &[&Value]) -> Result<RdfDatasetBuilder, String> {
    let mut builder = RdfDatasetBuilder::new();
    for axiom in hierarchy {
        let kind = string(axiom, "kind")?;
        match kind {
            "Declaration" => {
                let object = match string(axiom, "entityKind")? {
                    "Class" => OWL_CLASS,
                    "ObjectProperty" => "http://www.w3.org/2002/07/owl#ObjectProperty",
                    "DataProperty" => OWL_DATATYPE_PROPERTY,
                    "AnnotationProperty" => "http://www.w3.org/2002/07/owl#AnnotationProperty",
                    "Datatype" => "http://www.w3.org/2000/01/rdf-schema#Datatype",
                    _ => return Err("invalid hierarchy declaration kind".into()),
                };
                push_iri(&mut builder, string(axiom, "iri")?, RDF_TYPE, object);
            }
            "SubClassOf" => push_iri(
                &mut builder,
                named_iri(field(axiom, "subClass")?)?,
                RDFS_SUBCLASS,
                named_iri(field(axiom, "superClass")?)?,
            ),
            "EquivalentClasses" | "DisjointClasses" => {
                let predicate = if kind == "EquivalentClasses" {
                    OWL_EQUIVALENT
                } else {
                    OWL_DISJOINT
                };
                let classes: Vec<&str> = array(axiom, "classes")?
                    .iter()
                    .map(named_iri)
                    .collect::<Result<_, _>>()?;
                for left in 0..classes.len() {
                    for right in left + 1..classes.len() {
                        push_iri(&mut builder, classes[left], predicate, classes[right]);
                    }
                }
            }
            _ => return Err(format!("{kind} is not a hierarchy axiom")),
        }
    }
    Ok(builder)
}

pub(crate) fn hierarchy_dataset(hierarchy: &[&Value]) -> Result<Arc<RdfDataset>, String> {
    hierarchy_builder(hierarchy)?
        .freeze()
        .map_err(|error| error.to_string())
}

/// What one individual must satisfy against the hierarchy: its named types after the closure,
/// and the operands of each union domain of a property it is the subject of.
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct Signature {
    pub(crate) types: BTreeSet<String>,
    pub(crate) unions: BTreeSet<Vec<String>>,
}

/// One individual after the closure, with the statement behind each part of its signature.
#[derive(Default)]
pub(crate) struct Individual<'a> {
    /// Each named type, with the id of the fact `individual rdf:type class`.
    types: BTreeMap<&'a str, &'a str>,
    /// Each union domain it falls under, with the least (domain axiom id, assertion id) pair.
    unions: BTreeMap<Vec<&'a str>, (&'a str, &'a str)>,
    /// The least axiom that names it as an individual: a class, object or data property
    /// assertion, or a `NamedIndividual` declaration.
    named_by: Option<&'a str>,
}

impl Individual<'_> {
    pub(crate) fn signature(&self) -> Signature {
        Signature {
            types: self.types.keys().map(|&class| class.to_owned()).collect(),
            unions: self
                .unions
                .keys()
                .map(|operands| operands.iter().map(|&operand| operand.to_owned()).collect())
                .collect(),
        }
    }
}

/// The union domains of each property: whether it is an object property, the operands and the
/// domain axiom.
type UnionDomains<'a> = HashMap<&'a str, Vec<(bool, Vec<&'a str>, &'a str)>>;

/// The typing already decided for one combination of asserted types and union domains.
type Analysed<'a> = HashMap<(Vec<&'a str>, Vec<&'a [&'a str]>), Option<Typing<'a>>>;

/// Every individual of the request after the closure, in IRI order.
pub(crate) struct Individuals<'a> {
    pub(crate) by_iri: BTreeMap<&'a str, Individual<'a>>,
}

impl<'a> Individuals<'a> {
    /// Collects each individual's types and union domains from the closed facts in one pass.
    pub(crate) fn collect(axioms: &'a [Value], facts: &'a BTreeMap<String, Fact>) -> Self {
        let mut union_domains: UnionDomains<'_> = HashMap::new();
        let mut by_iri: BTreeMap<&str, Individual<'_>> = BTreeMap::new();
        for axiom in axioms {
            let id = axiom["id"].as_str().expect("preflight id");
            let named: &[&Value] = match axiom["kind"].as_str() {
                Some("PropertyDomain") if axiom["domain"]["kind"] == "ObjectUnionOf" => {
                    let object_property = match axiom["propertyKind"].as_str() {
                        Some("ObjectProperty") => true,
                        Some("DataProperty") => false,
                        _ => continue,
                    };
                    let operands = axiom["domain"]["operands"]
                        .as_array()
                        .expect("preflight operands")
                        .iter()
                        .map(|operand| operand.as_str().expect("preflight operand"))
                        .collect();
                    union_domains
                        .entry(axiom["property"].as_str().expect("preflight property"))
                        .or_default()
                        .push((object_property, operands, id));
                    continue;
                }
                Some("ClassAssertion") => &[&axiom["individual"]],
                Some("ObjectPropertyAssertion") => &[&axiom["subject"], &axiom["object"]],
                Some("DataPropertyAssertion") => &[&axiom["subject"]],
                Some("Declaration") if axiom["entityKind"] == "NamedIndividual" => &[&axiom["iri"]],
                _ => continue,
            };
            for iri in named {
                let entry = by_iri
                    .entry(iri.as_str().expect("preflight individual"))
                    .or_default();
                // Axioms arrive sorted by id, so the first one seen is the least.
                entry.named_by.get_or_insert(id);
            }
        }
        for fact in facts.values() {
            if fact.predicate == RDF_TYPE
                && let Some(class) = fact.object.as_str()
            {
                by_iri
                    .entry(&fact.subject)
                    .or_default()
                    .types
                    .insert(class, &fact.premise_id);
            }
            for (object_property, operands, axiom_id) in union_domains
                .get(fact.predicate.as_str())
                .into_iter()
                .flatten()
            {
                let applies = if *object_property {
                    fact.object.is_string()
                } else {
                    fact.object.is_object()
                };
                if !applies {
                    continue;
                }
                let candidate = (*axiom_id, fact.premise_id.as_str());
                by_iri
                    .entry(&fact.subject)
                    .or_default()
                    .unions
                    .entry(operands.clone())
                    .and_modify(|least| {
                        if cmp_pair(candidate, *least) == Ordering::Less {
                            *least = candidate;
                        }
                    })
                    .or_insert(candidate);
            }
        }
        Self { by_iri }
    }

    /// The distinct signatures, each with the individuals that share it.
    pub(crate) fn signatures(&self) -> BTreeMap<Signature, Vec<&'a str>> {
        let mut grouped: BTreeMap<Signature, Vec<&str>> = BTreeMap::new();
        for (&iri, individual) in &self.by_iri {
            grouped.entry(individual.signature()).or_default().push(iri);
        }
        grouped
    }
}

fn cmp_pair(left: (&str, &str), right: (&str, &str)) -> Ordering {
    cmp_utf16(left.0, right.0).then_with(|| cmp_utf16(left.1, right.1))
}

fn literal_dataset(
    property: &str,
    individual: &str,
    range: Option<&str>,
    literals: &[&Value],
) -> Result<Arc<RdfDataset>, String> {
    let mut builder = RdfDatasetBuilder::new();
    push_iri(&mut builder, property, RDF_TYPE, OWL_DATATYPE_PROPERTY);
    if let Some(range) = range {
        push_iri(&mut builder, property, RDFS_RANGE, range);
    }
    for literal in literals {
        push_literal(&mut builder, individual, property, literal)?;
    }
    builder.freeze().map_err(|error| error.to_string())
}

/// Whether two literals can be the one value of a functional data property: PurRDF decides the
/// consistency of an individual with both under a fresh functional property.
pub(crate) fn check_functional_values(
    property: &str,
    individual: &str,
    literals: [&Value; 2],
) -> Result<bool, Refusal> {
    let mut builder = RdfDatasetBuilder::new();
    push_iri(&mut builder, property, RDF_TYPE, OWL_DATATYPE_PROPERTY);
    push_iri(&mut builder, property, RDF_TYPE, OWL_FUNCTIONAL_PROPERTY);
    for literal in literals {
        push_literal(&mut builder, individual, property, literal).map_err(dataset_refusal)?;
    }
    let dataset = builder
        .freeze()
        .map_err(|error| dataset_refusal(error.to_string()))?;
    decide_consistency(&open_reasoner(&dataset)?, "functional data consistency")
}

/// An IRI that no axiom of the request mentions, for the one individual or property of a check.
pub(crate) fn fresh_iri(used: &BTreeSet<&str>, base: &str) -> String {
    let mut candidate = base.to_owned();
    while used.contains(candidate.as_str()) {
        candidate.push('-');
    }
    candidate
}

/// A prefix that begins no IRI of the request, so `prefix` plus any suffix is fresh. `stem`
/// ends with the separator, which the padding goes before.
pub(crate) fn fresh_prefix(used: &BTreeSet<&str>, stem: &str) -> String {
    let (head, separator) = stem.split_at(stem.len() - 1);
    let mut head = head.to_owned();
    loop {
        let candidate = format!("{head}{separator}");
        let taken = used
            .range(candidate.as_str()..)
            .next()
            .is_some_and(|iri| iri.starts_with(candidate.as_str()));
        if !taken {
            return candidate;
        }
        head.push('-');
    }
}

// #endregion

// #region PurRDF checks

/// The answer of one consistency question PurRDF decided completely.
pub(crate) fn decide_consistency(reasoner: &Reasoner, phase: &str) -> Result<bool, Refusal> {
    let consistency = reasoner.consistency();
    check_dl_certificate(consistency.certificate(), phase)?;
    match *consistency.answer() {
        Verdict::True => Ok(true),
        Verdict::False => Ok(false),
        Verdict::Unknown => Err(engine_refusal(
            "unknown-result",
            "purrdf-unknown",
            format!("PurRDF {phase} returned Unknown"),
        )),
    }
}

pub(crate) fn open_reasoner(dataset: &RdfDataset) -> Result<Reasoner, Refusal> {
    Reasoner::new(dataset)
        .map_err(|error| engine_refusal("unknown-result", "purrdf-open", error.to_string()))
}

fn dataset_refusal(message: String) -> Refusal {
    engine_refusal("incomplete-certificate", "dataset-build", message)
}

/// The hierarchy's classification, or `None` when the hierarchy has no model.
///
/// PurRDF opens its session by deciding consistency, so this one call answers both questions;
/// asking for consistency first would decide it twice.
pub(crate) fn classify_hierarchy(
    reasoner: &Reasoner,
) -> Result<Option<Certified<ClassHierarchy>>, Refusal> {
    match reasoner.classify() {
        Ok(classification) => {
            check_dl_certificate(classification.certificate(), "classification")?;
            Ok(Some(classification))
        }
        Err(EntailError::Unsatisfiable) => Ok(None),
        Err(error) => Err(engine_refusal(
            "unknown-result",
            "purrdf-classify",
            error.to_string(),
        )),
    }
}

/// Whether PurRDF established a named superclass of `owl:Thing` other than itself.
pub(crate) fn thing_has_superclass(hierarchy: &ClassHierarchy) -> bool {
    hierarchy
        .subsumptions()
        .iter()
        .any(|(sub, sup)| sub.as_iri() == Some(OWL_THING) && sup.as_iri() != Some(OWL_THING))
}

/// Whether every individual signature is consistent with the hierarchy.
///
/// A signature `known` already answers (`Classified::satisfiable`) is not asked again. Each
/// other distinct signature is asked once, as the satisfiability of a fresh class `S` with one
/// axiom `S ⊑ T₁ ⊓ … ⊓ (O₁ ⊔ …) ⊓ …` over its types and unions. All of those axioms share one
/// copy of the hierarchy, which PurRDF builds once: each fresh class is mentioned by its own
/// axiom alone, so `S` is satisfiable exactly when an individual with that signature is
/// consistent with the hierarchy, and every question still concerns one element. The empty
/// signature is consistent whenever the hierarchy is, unless the hierarchy gives `owl:Thing` a
/// named superclass, so only then is it asked, as `S ⊑ owl:Thing`.
pub(crate) fn check_signatures(
    hierarchy: &[&Value],
    signatures: impl IntoIterator<Item = Signature>,
    thing_has_superclass: bool,
    known: impl Fn(&Signature) -> Option<bool>,
    fresh: &str,
    mut within_budget: impl FnMut() -> Result<(), Refusal>,
) -> Result<bool, Refusal> {
    let mut asked = Vec::new();
    for mut signature in signatures {
        if signature.types.is_empty() && signature.unions.is_empty() {
            if !thing_has_superclass {
                continue;
            }
            signature.types.insert(OWL_THING.to_owned());
        }
        match known(&signature) {
            Some(true) => {}
            Some(false) => return Ok(false),
            None => asked.push(signature),
        }
    }
    if asked.is_empty() {
        return Ok(true);
    }
    let mut builder = hierarchy_builder(hierarchy).map_err(dataset_refusal)?;
    for (index, signature) in asked.iter().enumerate() {
        push_signature_class(&mut builder, &format!("{fresh}{index}"), index, signature);
    }
    let dataset = builder
        .freeze()
        .map_err(|error| dataset_refusal(error.to_string()))?;
    let mut reasoner = open_reasoner(&dataset)?;
    for index in 0..asked.len() {
        let class = TermValue::iri(format!("{fresh}{index}"));
        let satisfiable = reasoner.class_satisfiability(&class).map_err(|error| {
            engine_refusal("unknown-result", "purrdf-satisfiability", error.to_string())
        })?;
        check_dl_certificate(satisfiable.certificate(), "signature consistency")?;
        match *satisfiable.answer() {
            Verdict::True => {}
            Verdict::False => return Ok(false),
            Verdict::Unknown => {
                return Err(engine_refusal(
                    "unknown-result",
                    "purrdf-unknown",
                    "PurRDF signature consistency returned Unknown",
                ));
            }
        }
        within_budget()?;
    }
    Ok(true)
}

/// Adds `class ⊑ T₁ ⊓ … ⊓ (O₁ ⊔ …) ⊓ …` for one signature to a hierarchy dataset.
fn push_signature_class(
    builder: &mut RdfDatasetBuilder,
    class: &str,
    index: usize,
    signature: &Signature,
) {
    let rdf_type = builder.intern_iri(RDF_TYPE);
    let owl_class = builder.intern_iri(OWL_CLASS);
    let mut members = Vec::new();
    for named in &signature.types {
        members.push(builder.intern_iri(named));
    }
    for (offset, operands) in signature.unions.iter().enumerate() {
        let union = builder.intern_blank(&format!("erden_s{index}_u{offset}"), BlankScope::DEFAULT);
        builder.push_quad(union, rdf_type, owl_class, None);
        let operands: Vec<_> = operands
            .iter()
            .map(|operand| builder.intern_iri(operand))
            .collect();
        let list = push_list(builder, &format!("erden_s{index}_u{offset}"), &operands);
        let union_of = builder.intern_iri(OWL_UNION);
        builder.push_quad(union, union_of, list, None);
        members.push(union);
    }
    let subject = builder.intern_iri(class);
    builder.push_quad(subject, rdf_type, owl_class, None);
    let subclass_of = builder.intern_iri(RDFS_SUBCLASS);
    if let [only] = members.as_slice() {
        builder.push_quad(subject, subclass_of, *only, None);
        return;
    }
    let intersection = builder.intern_blank(&format!("erden_s{index}"), BlankScope::DEFAULT);
    builder.push_quad(intersection, rdf_type, owl_class, None);
    let list = push_list(builder, &format!("erden_s{index}_i"), &members);
    let intersection_of = builder.intern_iri(OWL_INTERSECTION);
    builder.push_quad(intersection, intersection_of, list, None);
    builder.push_quad(subject, subclass_of, intersection, None);
}

/// Adds an RDF list of `items` with blank cells labelled from `label`, and returns its head.
fn push_list(builder: &mut RdfDatasetBuilder, label: &str, items: &[TermId]) -> TermId {
    let first = builder.intern_iri(RDF_FIRST);
    let rest = builder.intern_iri(RDF_REST);
    let mut next = builder.intern_iri(RDF_NIL);
    for (offset, &item) in items.iter().enumerate().rev() {
        let cell = builder.intern_blank(&format!("{label}_{offset}"), BlankScope::DEFAULT);
        builder.push_quad(cell, first, item, None);
        builder.push_quad(cell, rest, next, None);
        next = cell;
    }
    next
}

/// At most this many literals outside their ranges are looked for and explained once a literal
/// check is inconsistent: each costs PurRDF runs on the way to a refusal, and an author who
/// fixes these runs the check again.
pub(crate) const MAX_EXPLAINED_CLASHES: usize = 32;

/// A literal that PurRDF found has no value under a data range, or, with no range, under its own
/// datatype (an ill-formed lexical form).
#[derive(Debug)]
pub(crate) struct LiteralClash {
    /// The data range, or `None` for a literal checked on its own.
    pub(crate) range: Option<String>,
    /// The literal, or `None` when no single literal of an inconsistent check is inconsistent on
    /// its own (independent values cannot do that, so this only guards the explanation).
    pub(crate) literal: Option<Value>,
}

/// Checks every asserted literal against each data range of its property, and on its own when
/// no range applies to it.
///
/// A literal that is ill-typed makes every check it takes part in inconsistent, so a range check
/// also decides whether the literal is well-typed; checking it on its own as well would decide
/// that twice. Returns the literals outside a range or ill-typed (up to
/// [`MAX_EXPLAINED_CLASHES`]), empty when every literal has a value. Only an inconsistent check
/// costs more PurRDF runs, to find which of its literals clash.
pub(crate) fn check_literals(
    axioms: &[Value],
    property: &str,
    individual: &str,
) -> Result<Vec<LiteralClash>, Refusal> {
    let mut ranges: HashMap<&str, Vec<&str>> = HashMap::new();
    for axiom in axioms {
        if axiom["kind"] == "PropertyRange" && axiom["propertyKind"] == "DataProperty" {
            ranges
                .entry(axiom["property"].as_str().expect("preflight property"))
                .or_default()
                .push(axiom["range"].as_str().expect("preflight range"));
        }
    }
    let mut by_range: BTreeMap<Option<&str>, BTreeMap<String, &Value>> = BTreeMap::new();
    for axiom in axioms {
        if axiom["kind"] != "DataPropertyAssertion" {
            continue;
        }
        let value = &axiom["value"];
        let key = canonical_text(value);
        by_range.entry(None).or_default().insert(key.clone(), value);
        let asserted = axiom["property"].as_str().expect("preflight property");
        for &range in ranges.get(asserted).into_iter().flatten() {
            by_range
                .entry(Some(range))
                .or_default()
                .insert(key.clone(), value);
        }
    }
    let ranged: BTreeSet<String> = by_range
        .iter()
        .filter(|(range, _)| range.is_some())
        .flat_map(|(_, literals)| literals.keys().cloned())
        .collect();
    if let Some(alone) = by_range.get_mut(&None) {
        alone.retain(|key, _| !ranged.contains(key));
    }
    let mut clashes = Vec::new();
    for (range, literals) in by_range {
        let literals: Vec<&Value> = literals.into_values().collect();
        for chunk in literals.chunks(LITERALS_PER_CHECK) {
            if clashes.len() >= MAX_EXPLAINED_CLASHES {
                return Ok(clashes);
            }
            if literals_have_values(property, individual, range, chunk)? {
                continue;
            }
            let mut found = Vec::new();
            isolate_literals(property, individual, range, chunk, &mut found)?;
            if found.is_empty() {
                clashes.push(LiteralClash {
                    range: range.map(str::to_owned),
                    literal: None,
                });
            }
            for literal in found {
                if clashes.len() < MAX_EXPLAINED_CLASHES {
                    clashes.push(LiteralClash {
                        range: range.map(str::to_owned),
                        literal: Some(literal.clone()),
                    });
                }
            }
        }
    }
    Ok(clashes)
}

/// Whether one individual can have all of `literals` as values of a property with `range`.
fn literals_have_values(
    property: &str,
    individual: &str,
    range: Option<&str>,
    literals: &[&Value],
) -> Result<bool, Refusal> {
    let dataset =
        literal_dataset(property, individual, range, literals).map_err(dataset_refusal)?;
    decide_consistency(&open_reasoner(&dataset)?, "literal consistency")
}

/// Adds to `found` the literals of an inconsistent check that have no value on their own, by
/// halving it: two PurRDF runs per halving, along each path down to a clashing literal, and
/// none past [`MAX_EXPLAINED_CLASHES`] literals found.
fn isolate_literals<'v>(
    property: &str,
    individual: &str,
    range: Option<&str>,
    literals: &[&'v Value],
    found: &mut Vec<&'v Value>,
) -> Result<(), Refusal> {
    if let [literal] = literals {
        found.push(literal);
        return Ok(());
    }
    let (left, right) = literals.split_at(literals.len() / 2);
    for half in [left, right] {
        if found.len() < MAX_EXPLAINED_CLASHES
            && !literals_have_values(property, individual, range, half)?
        {
            isolate_literals(property, individual, range, half, found)?;
        }
    }
    Ok(())
}

/// The literals of `clashes`, as [`canonical_text`] writes them, so a caller lists only the uses
/// of those.
pub(crate) fn clash_keys(clashes: &[LiteralClash]) -> HashSet<String> {
    clashes
        .iter()
        .filter_map(|clash| clash.literal.as_ref().map(canonical_text))
        .collect()
}

/// One literal value a subject has for a data property, and the axioms that give it: the
/// assertion, and for a value reached through sub-properties or equal individuals, those axioms
/// too. `asserted` is the property the assertion names.
pub(crate) struct LiteralUse<'a> {
    pub(crate) subject: String,
    pub(crate) property: &'a str,
    pub(crate) asserted: &'a str,
    pub(crate) value: &'a Value,
    pub(crate) axiom_ids: Vec<String>,
}

/// The refusal for literal clashes, one diagnostic per value that clashes, naming the
/// statements in terms an author can look up: the subject, the property and its value, and the
/// range it is outside, with the assertion's and the range's axioms. A clash with no isolated
/// literal or no use to explain it adds the opaque diagnostic instead.
pub(crate) fn literal_clash_refusal<'a>(
    axioms: &[Value],
    clashes: &[LiteralClash],
    uses: impl IntoIterator<Item = LiteralUse<'a>>,
) -> Refusal {
    let uses: Vec<LiteralUse<'a>> = uses.into_iter().collect();
    let mut diagnostics = Vec::new();
    let mut unexplained = false;
    let mut more = clashes.len() >= MAX_EXPLAINED_CLASHES;
    for clash in clashes {
        let Some(literal) = &clash.literal else {
            unexplained = true;
            continue;
        };
        let key = canonical_text(literal);
        let before = diagnostics.len();
        for item in uses.iter().filter(|item| canonical_text(item.value) == key) {
            if diagnostics.len() >= MAX_EXPLAINED_CLASHES {
                more = true;
                break;
            }
            let range_axiom = clash.range.as_deref().map(|range| {
                axioms.iter().find(|axiom| {
                    axiom["kind"] == "PropertyRange"
                        && axiom["propertyKind"] == "DataProperty"
                        && axiom["property"] == item.property
                        && axiom["range"] == range
                })
            });
            match range_axiom {
                Some(None) => {}
                Some(Some(axiom)) => diagnostics.push(clash_diagnostic(item, literal, Some(axiom))),
                None => diagnostics.push(clash_diagnostic(item, literal, None)),
            }
        }
        unexplained |= diagnostics.len() == before;
    }
    if unexplained {
        diagnostics.extend(uncheckable_inconsistency().diagnostics);
    }
    if more {
        diagnostics.push(Diagnostic {
            code: "uncheckable-inconsistency",
            message: format!(
                "More literals may be outside their ranges: this list stops at {MAX_EXPLAINED_CLASHES}"
            ),
            axiom_ids: Vec::new(),
        });
    }
    Refusal {
        reason: "incomplete-certificate",
        diagnostics,
    }
}

/// One literal clash in an author's terms; `range` is the range axiom, or `None` for a literal
/// that is not a valid value of its own datatype.
fn clash_diagnostic(item: &LiteralUse<'_>, literal: &Value, range: Option<&Value>) -> Diagnostic {
    let value = display_literal(literal);
    let statement = format!(
        "{} {} {value}",
        display_iri(&item.subject),
        display_iri(item.asserted)
    );
    let through = if item.asserted == item.property {
        String::new()
    } else {
        format!(
            ", so it has that value for {} too, of which {} is a sub-property",
            display_iri(item.property),
            display_iri(item.asserted)
        )
    };
    let clash = match range.and_then(|axiom| axiom["range"].as_str()) {
        Some(range) => format!(
            "but {} has range {}, and {value} is not a value of {}",
            display_iri(item.property),
            display_iri(range),
            display_iri(range)
        ),
        None => format!(
            "but {value} is not a valid value of its datatype {}",
            display_iri(literal["datatype"].as_str().unwrap_or_default())
        ),
    };
    let mut axiom_ids = item.axiom_ids.clone();
    if let Some(id) = range.and_then(|axiom| axiom["id"].as_str()) {
        axiom_ids.push(id.to_owned());
    }
    Diagnostic {
        code: "uncheckable-inconsistency",
        message: format!(
            "{statement}{through}, {clash}, so the ontology is inconsistent; Erden's proof checker cannot certify this kind of inconsistency yet, so reasoning is refused"
        ),
        axiom_ids,
    }
}

/// An IRI as an author reads it in a message: `xsd:`, `rdf:` and `rdfs:` terms by prefix, any
/// other IRI in full between angle brackets.
fn display_iri(iri: &str) -> String {
    const PREFIXES: [(&str, &str); 3] = [
        ("http://www.w3.org/2001/XMLSchema#", "xsd:"),
        ("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdf:"),
        ("http://www.w3.org/2000/01/rdf-schema#", "rdfs:"),
    ];
    PREFIXES
        .iter()
        .find_map(|(namespace, prefix)| {
            iri.strip_prefix(namespace)
                .map(|local| format!("{prefix}{local}"))
        })
        .unwrap_or_else(|| format!("<{iri}>"))
}

/// A literal in Turtle form, with a lexical form longer than 80 characters cut to 79 and an
/// ellipsis.
fn display_literal(literal: &Value) -> String {
    let lexical = literal["lexicalForm"].as_str().unwrap_or_default();
    let lexical = if lexical.chars().count() > 80 {
        format!("{}…", lexical.chars().take(79).collect::<String>())
    } else {
        lexical.to_owned()
    };
    let quoted = serde_json::to_string(&lexical).expect("strings serialize as JSON");
    match literal["language"].as_str() {
        Some(language) => format!("{quoted}@{language}"),
        None => format!(
            "{quoted}^^{}",
            display_iri(literal["datatype"].as_str().unwrap_or_default())
        ),
    }
}

// #endregion

// #region Types the closure's rules cannot reach

/// Why a class is in the upward closure of one case of an individual's types.
#[derive(Clone, Copy)]
enum Why<'a> {
    /// One of the individual's own types after the closure.
    Type(&'a str),
    /// The operand this case chose for a union, or `owl:Thing`: no premise needed.
    Given,
    /// A named superclass of `from`, by the closed subclass fact `premise`.
    Via { from: &'a str, premise: &'a str },
}

/// How one case of an individual's types is ruled out.
#[derive(Clone, Copy)]
enum Exclusion<'a> {
    Nothing,
    Disjoint {
        axiom: &'a str,
        left: &'a str,
        right: &'a str,
    },
}

/// What the case analysis reads: each class's named superclasses after the closure, with the
/// fact that states each (the closure's subclass facts are transitively closed), and the
/// `DisjointClasses` axioms, indexed by member.
pub(crate) struct Hierarchy<'a> {
    supers: HashMap<&'a str, Vec<(&'a str, &'a str)>>,
    disjoint: Vec<(&'a str, Vec<&'a str>)>,
    disjoint_by_member: HashMap<&'a str, Vec<usize>>,
}

impl<'a> Hierarchy<'a> {
    pub(crate) fn collect(axioms: &'a [Value], facts: &'a BTreeMap<String, Fact>) -> Self {
        let mut supers: HashMap<&str, Vec<(&str, &str)>> = HashMap::new();
        for fact in facts.values() {
            if fact.predicate == RDFS_SUBCLASS
                && let Some(sup) = fact.object.as_str()
                && sup != fact.subject
            {
                supers
                    .entry(&fact.subject)
                    .or_default()
                    .push((sup, &fact.premise_id));
            }
        }
        let mut disjoint = Vec::new();
        let mut disjoint_by_member: HashMap<&str, Vec<usize>> = HashMap::new();
        for axiom in axioms
            .iter()
            .filter(|axiom| axiom["kind"] == "DisjointClasses")
        {
            let members: Vec<&str> = axiom["classes"]
                .as_array()
                .expect("preflight classes")
                .iter()
                .map(|class| class["iri"].as_str().expect("preflight named class"))
                .collect();
            for &member in &members {
                disjoint_by_member
                    .entry(member)
                    .or_default()
                    .push(disjoint.len());
            }
            disjoint.push((axiom["id"].as_str().expect("preflight id"), members));
        }
        Self {
            supers,
            disjoint,
            disjoint_by_member,
        }
    }

    /// The classes of `base` and their named superclasses, each with its first reason.
    fn upward(&self, base: &[(&'a str, Why<'a>)]) -> BTreeMap<&'a str, Why<'a>> {
        let mut up = BTreeMap::new();
        for &(class, why) in base {
            up.entry(class).or_insert(why);
        }
        for &(class, _) in base {
            for &(sup, premise) in self.supers.get(class).into_iter().flatten() {
                up.entry(sup).or_insert(Why::Via {
                    from: class,
                    premise,
                });
            }
        }
        up
    }

    /// Whether `up` cannot hold of one element: it has `owl:Nothing`, or two members of one
    /// `DisjointClasses` axiom (the first such axiom in request order, its first two members).
    fn exclusion(&self, up: &BTreeMap<&'a str, Why<'a>>) -> Option<Exclusion<'a>> {
        if up.contains_key(OWL_NOTHING) {
            return Some(Exclusion::Nothing);
        }
        let mut axioms: Vec<usize> = up
            .keys()
            .flat_map(|class| self.disjoint_by_member.get(class).into_iter().flatten())
            .copied()
            .collect();
        axioms.sort_unstable();
        axioms.dedup();
        for index in axioms {
            let (axiom, members) = &self.disjoint[index];
            // A `DisjointClasses` axiom's classes are distinct (the request is checked for it).
            let mut present = members.iter().filter(|member| up.contains_key(*member));
            if let (Some(&left), Some(&right)) = (present.next(), present.next()) {
                return Some(Exclusion::Disjoint { axiom, left, right });
            }
        }
        None
    }
}

/// What the hierarchy's classification already decides about individual signatures.
///
/// A signature without unions whose types are one declared class `C` and superclasses of `C`
/// (by the closed subclass facts, each entailed) describes exactly the elements of `C`. It is
/// satisfiable exactly when `C` is, which the classification has decided for every declared
/// class and for `owl:Thing` (so also for the empty signature, asked as `owl:Thing`): asking
/// PurRDF about the signature would decide that a second time.
pub(crate) struct Classified<'a> {
    hierarchy: &'a Hierarchy<'a>,
    declared: HashSet<&'a str>,
    unsatisfiable: HashSet<&'a str>,
}

impl<'a> Classified<'a> {
    pub(crate) fn new(
        axioms: &'a [Value],
        hierarchy: &'a Hierarchy<'a>,
        classification: &'a ClassHierarchy,
    ) -> Self {
        let declared = axioms
            .iter()
            .filter(|axiom| axiom["kind"] == "Declaration" && axiom["entityKind"] == "Class")
            .filter_map(|axiom| axiom["iri"].as_str())
            .collect();
        let unsatisfiable = classification
            .unsatisfiable()
            .iter()
            .filter_map(TermValue::as_iri)
            .collect();
        Self {
            hierarchy,
            declared,
            unsatisfiable,
        }
    }

    /// The signature's satisfiability, when the classification already decided it.
    pub(crate) fn satisfiable(&self, signature: &Signature) -> Option<bool> {
        if !signature.unions.is_empty() {
            return None;
        }
        let supers = |class: &str| self.hierarchy.supers.get(class).into_iter().flatten();
        // The closure closes every type upward, so the class with the most superclasses is the
        // only candidate for one the others are all superclasses of.
        let candidate = signature
            .types
            .iter()
            .max_by_key(|class| supers(class).count())?
            .as_str();
        // The classification decides every declared class, and `owl:Thing` (listed among the
        // unsatisfiable classes when the hierarchy rules out every element).
        if candidate != OWL_THING && !self.declared.contains(candidate) {
            return None;
        }
        let above: HashSet<&str> = supers(candidate).map(|&(sup, _)| sup).collect();
        signature
            .types
            .iter()
            .all(|class| class == candidate || above.contains(class.as_str()))
            .then(|| !self.unsatisfiable.contains(candidate))
    }
}

/// The premises that put `class` in `up`: the subclass fact, and the individual's own type it
/// starts from (collected by class, and cited per individual).
fn cite<'a>(
    up: &BTreeMap<&'a str, Why<'a>>,
    class: &'a str,
    premises: &mut BTreeSet<&'a str>,
    types: &mut BTreeSet<&'a str>,
) {
    let mut why = up[class];
    if let Why::Via { from, premise } = why {
        premises.insert(premise);
        why = up[from];
    }
    if let Why::Type(own) = why {
        types.insert(own);
    }
}

/// The types one signature adds, each with its class-level premises and the individual's own
/// types it cites, and the union domains its rule cites.
struct Typing<'a> {
    rule: &'static str,
    added: Vec<(&'a str, BTreeSet<&'a str>, BTreeSet<&'a str>)>,
    unions: Vec<&'a [&'a str]>,
}

/// The named types an individual with these closed types and union domains has in every model,
/// beyond its own types and `owl:Thing`.
///
/// They are the classes in the upward closure of every case that is not ruled out, a case being
/// its types, `owl:Thing` and one operand of each union. A union with an operand already in the
/// closure of its types adds nothing and is left out. Without unions only the superclasses of
/// `owl:Thing` can be new (rule `thing-subclass-type`); otherwise each new type cites, for every
/// case, why it holds there or why the case is ruled out (rule `union-domain-type`).
fn analyse<'a>(
    hierarchy: &Hierarchy<'a>,
    types: &[&'a str],
    unions: &[&'a [&'a str]],
) -> Result<Option<Typing<'a>>, Refusal> {
    let mut base: Vec<(&str, Why<'_>)> = types.iter().map(|&own| (own, Why::Type(own))).collect();
    base.push((OWL_THING, Why::Given));
    let closed = hierarchy.upward(&base);
    let unions: Vec<&[&str]> = unions
        .iter()
        .copied()
        .filter(|operands| !operands.iter().any(|operand| closed.contains_key(operand)))
        .collect();
    let added_beyond = |up: &BTreeMap<&'a str, Why<'a>>, class: &str| {
        class != OWL_THING && !types.contains(&class) && up.contains_key(class)
    };
    if unions.is_empty() {
        let added: Vec<_> = closed
            .iter()
            .filter(|(class, _)| added_beyond(&closed, class))
            .map(|(&class, _)| {
                let (mut premises, mut own) = (BTreeSet::new(), BTreeSet::new());
                cite(&closed, class, &mut premises, &mut own);
                (class, premises, own)
            })
            .collect();
        return Ok((!added.is_empty()).then_some(Typing {
            rule: "thing-subclass-type",
            added,
            unions,
        }));
    }
    let cases = unions
        .iter()
        .try_fold(1_usize, |product, operands| product.checked_mul(operands.len()))
        .filter(|&product| product <= MAX_UNION_CASES)
        .ok_or_else(|| {
            engine_refusal(
                "boundary-exhausted",
                "union-case-limit",
                format!(
                    "An individual's union domains have more than {MAX_UNION_CASES} operand combinations"
                ),
            )
        })?;
    let mut open = Vec::new();
    let mut excluded = Vec::new();
    for case in 0..cases {
        let mut chosen = base.clone();
        let mut rest = case;
        for operands in &unions {
            chosen.push((operands[rest % operands.len()], Why::Given));
            rest /= operands.len();
        }
        let up = hierarchy.upward(&chosen);
        match hierarchy.exclusion(&up) {
            Some(exclusion) => excluded.push((up, exclusion)),
            None => open.push(up),
        }
    }
    let Some((first, others)) = open.split_first() else {
        return Err(engine_refusal(
            "incomplete-certificate",
            "inconsistency-unconfirmed",
            "PurRDF found an individual signature consistent that its union domains and disjointness rule out",
        ));
    };
    let mut added = Vec::new();
    for &class in first.keys() {
        if !added_beyond(first, class) || others.iter().any(|up| !up.contains_key(class)) {
            continue;
        }
        let (mut premises, mut own) = (BTreeSet::new(), BTreeSet::new());
        for up in &open {
            cite(up, class, &mut premises, &mut own);
        }
        for (up, exclusion) in &excluded {
            match *exclusion {
                Exclusion::Nothing => cite(up, OWL_NOTHING, &mut premises, &mut own),
                Exclusion::Disjoint { axiom, left, right } => {
                    premises.insert(axiom);
                    cite(up, left, &mut premises, &mut own);
                    cite(up, right, &mut premises, &mut own);
                }
            }
        }
        added.push((class, premises, own));
    }
    Ok((!added.is_empty()).then_some(Typing {
        rule: "union-domain-type",
        added,
        unions,
    }))
}

/// The named types the closure's rules cannot derive, with proofs: those a union domain entails
/// by case analysis (a common superclass of its operands, or the one operand a disjointness
/// leaves), and the superclasses of `owl:Thing`. Numbered after the closure's `already`.
///
/// Types never pass between individuals in V1 and add no property assertion, so these complete
/// every individual's named types without another round of the closure.
pub(crate) fn type_individuals<'a>(
    hierarchy: &Hierarchy<'a>,
    individuals: &Individuals<'a>,
    thing_has_superclass: bool,
    already: usize,
    max_inferences: u64,
) -> Result<Vec<Value>, Refusal> {
    let any_union = individuals
        .by_iri
        .values()
        .any(|individual| !individual.unions.is_empty());
    if !thing_has_superclass && !any_union {
        return Ok(Vec::new());
    }
    let mut analysed: Analysed<'_> = HashMap::new();
    let mut statements = Vec::new();
    for (&iri, individual) in &individuals.by_iri {
        if individual.unions.is_empty() && !thing_has_superclass {
            continue;
        }
        let types: Vec<&str> = individual.types.keys().copied().collect();
        let unions: Vec<&[&str]> = individual.unions.keys().map(Vec::as_slice).collect();
        let key = (types, unions);
        let typing = match analysed.get(&key) {
            Some(typing) => typing,
            None => {
                let typing = analyse(hierarchy, &key.0, &key.1)?;
                analysed.entry(key).or_insert(typing)
            }
        };
        let Some(typing) = typing else {
            continue;
        };
        for (class, premises, own) in &typing.added {
            let mut ids: Vec<String> = premises.iter().map(|&id| id.to_owned()).collect();
            ids.extend(own.iter().map(|class| individual.types[class].to_owned()));
            for operands in &typing.unions {
                let (axiom, assertion) = individual.unions[*operands];
                ids.extend([axiom.to_owned(), assertion.to_owned()]);
            }
            if typing.rule == "thing-subclass-type" {
                let named = individual
                    .named_by
                    .or_else(|| individual.types.values().next().copied())
                    .ok_or_else(|| {
                        engine_refusal(
                            "incomplete-certificate",
                            "individual-unnamed",
                            format!("No axiom names {iri} as an individual"),
                        )
                    })?;
                ids.push(named.to_owned());
            }
            sort_dedup_utf16(&mut ids);
            let count = already + statements.len();
            if count as u64 >= max_inferences {
                return Err(engine_refusal(
                    "budget-exhausted",
                    "max-inferences",
                    "Inference output limit reached before closure",
                ));
            }
            statements.push(json!({
                "graph": {"kind": "DefaultGraph"},
                "id": format!("inferred:{}", count + 1),
                "object": class,
                "predicate": RDF_TYPE,
                "provenance": {"justificationDigest": format!("sha256:{}", "0".repeat(64)), "kind": "inferred", "premiseIds": ids, "rule": typing.rule},
                "subject": iri
            }));
        }
    }
    Ok(statements)
}

// #endregion

#[cfg(test)]
mod tests {
    use super::*;

    // The 0.1 closure, kept verbatim as the reference: it recomputes every candidate from every
    // fact on every step and adds the least one.
    fn cmp_fact(left: &Fact, right: &Fact) -> Ordering {
        let mut left_parts = spo_key_parts(&left.subject, &left.predicate, &left.object);
        left_parts.extend(["\0", &left.premise_id]);
        let mut right_parts = spo_key_parts(&right.subject, &right.predicate, &right.object);
        right_parts.extend(["\0", &right.premise_id]);
        cmp_utf16_parts(&left_parts, &right_parts)
            .then_with(|| cmp_statement_object_identity(&left.object, &right.object))
    }

    fn reference_close_facts(
        axioms: &[Value],
        facts: &mut BTreeMap<String, Fact>,
        max_inferences: u64,
    ) -> Result<Vec<Value>, Refusal> {
        let mut inferred = Vec::new();
        loop {
            let mut snapshot: Vec<Fact> = facts.values().cloned().collect();
            snapshot.sort_by(cmp_fact);
            let mut candidates = BTreeSet::new();
            add_subclass_candidates(&snapshot, &mut candidates);
            add_axiom_candidates(axioms, &snapshot, &mut candidates);
            let next = candidates
                .into_iter()
                .find(|candidate| !facts.contains_key(&candidate.key));
            let Some(candidate) = next else {
                break;
            };
            if inferred.len() as u64 >= max_inferences {
                return Err(engine_refusal(
                    "budget-exhausted",
                    "max-inferences",
                    "Inference output limit reached before closure",
                ));
            }
            let id = format!("inferred:{}", inferred.len() + 1);
            let mut premises = candidate.premises;
            sort_dedup_utf16(&mut premises);
            let statement = json!({
                "graph": {"kind": "DefaultGraph"},
                "id": id,
                "object": candidate.object,
                "predicate": candidate.predicate,
                "provenance": {"justificationDigest": format!("sha256:{}", "0".repeat(64)), "kind": "inferred", "premiseIds": premises, "rule": candidate.rule},
                "subject": candidate.subject
            });
            facts.insert(
                candidate.key,
                Fact {
                    subject: statement["subject"].as_str().unwrap().to_owned(),
                    predicate: statement["predicate"].as_str().unwrap().to_owned(),
                    object: statement["object"].clone(),
                    premise_id: id,
                },
            );
            inferred.push(statement);
        }
        inferred.sort_by(cmp_statement);
        Ok(inferred)
    }

    fn add_subclass_candidates(facts: &[Fact], candidates: &mut BTreeSet<Candidate>) {
        for left in facts {
            if left.predicate == RDF_TYPE {
                let Some(class) = left.object.as_str() else {
                    continue;
                };
                for right in facts {
                    if right.predicate == RDFS_SUBCLASS && right.subject == class {
                        add_candidate(
                            candidates,
                            &left.subject,
                            RDF_TYPE,
                            right.object.clone(),
                            "subclass-type",
                            vec![left.premise_id.clone(), right.premise_id.clone()],
                        );
                    }
                }
            }
            if left.predicate == RDFS_SUBCLASS {
                let Some(middle) = left.object.as_str() else {
                    continue;
                };
                for right in facts {
                    if right.predicate == RDFS_SUBCLASS && right.subject == middle {
                        add_candidate(
                            candidates,
                            &left.subject,
                            RDFS_SUBCLASS,
                            right.object.clone(),
                            "subclass-transitive",
                            vec![left.premise_id.clone(), right.premise_id.clone()],
                        );
                    }
                }
            }
        }
    }

    fn add_axiom_candidates(
        axioms: &[Value],
        facts: &[Fact],
        candidates: &mut BTreeSet<Candidate>,
    ) {
        for axiom in axioms {
            let kind = axiom["kind"].as_str().expect("preflight kind");
            let axiom_id = axiom["id"].as_str().expect("preflight id").to_owned();
            match kind {
                "PropertyDomain" => {
                    if axiom["domain"]["kind"] != "NamedClass" {
                        continue;
                    }
                    let property_kind = axiom["propertyKind"].as_str().unwrap();
                    if !matches!(property_kind, "ObjectProperty" | "DataProperty") {
                        continue;
                    }
                    let property = axiom["property"].as_str().unwrap();
                    let domain = axiom["domain"]["iri"].clone();
                    for assertion in facts.iter().filter(|fact| {
                        fact.predicate == property
                            && ((property_kind == "ObjectProperty" && fact.object.is_string())
                                || (property_kind == "DataProperty" && fact.object.is_object()))
                    }) {
                        let rule = if property_kind == "ObjectProperty" {
                            "object-property-domain"
                        } else {
                            "data-property-domain"
                        };
                        add_candidate(
                            candidates,
                            &assertion.subject,
                            RDF_TYPE,
                            domain.clone(),
                            rule,
                            vec![axiom_id.clone(), assertion.premise_id.clone()],
                        );
                    }
                }
                "PropertyRange" if axiom["propertyKind"] == "ObjectProperty" => {
                    let property = axiom["property"].as_str().unwrap();
                    for assertion in facts.iter().filter(|fact| fact.predicate == property) {
                        if let Some(object) = assertion.object.as_str() {
                            add_candidate(
                                candidates,
                                object,
                                RDF_TYPE,
                                axiom["range"].clone(),
                                "object-property-range",
                                vec![axiom_id.clone(), assertion.premise_id.clone()],
                            );
                        }
                    }
                }
                "EquivalentClasses" => {
                    let classes: Vec<&str> = axiom["classes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|item| item["iri"].as_str().unwrap())
                        .collect();
                    for &left in &classes {
                        for &right in &classes {
                            if left != right {
                                add_candidate(
                                    candidates,
                                    left,
                                    RDFS_SUBCLASS,
                                    Value::String(right.to_owned()),
                                    "equivalent-class-subclass",
                                    vec![axiom_id.clone()],
                                );
                            }
                        }
                    }
                    for fact in facts.iter().filter(|fact| fact.predicate == RDF_TYPE) {
                        let Some(class) = fact.object.as_str() else {
                            continue;
                        };
                        if classes.contains(&class) {
                            for &equivalent in &classes {
                                if equivalent != class {
                                    add_candidate(
                                        candidates,
                                        &fact.subject,
                                        RDF_TYPE,
                                        Value::String(equivalent.to_owned()),
                                        "equivalent-class-type",
                                        vec![axiom_id.clone(), fact.premise_id.clone()],
                                    );
                                }
                            }
                        }
                    }
                }
                "InverseObjectProperties" => {
                    let left = axiom["left"].as_str().unwrap();
                    let right = axiom["right"].as_str().unwrap();
                    for assertion in facts.iter().filter(|fact| {
                        fact.object.is_string()
                            && (fact.predicate == left || fact.predicate == right)
                    }) {
                        let inverse = if assertion.predicate == left {
                            right
                        } else {
                            left
                        };
                        add_candidate(
                            candidates,
                            assertion.object.as_str().unwrap(),
                            inverse,
                            Value::String(assertion.subject.clone()),
                            "inverse-object-property",
                            vec![axiom_id.clone(), assertion.premise_id.clone()],
                        );
                    }
                }
                "TransitiveObjectProperty" => {
                    let property = axiom["property"].as_str().unwrap();
                    for left in facts
                        .iter()
                        .filter(|fact| fact.predicate == property && fact.object.is_string())
                    {
                        for right in facts.iter().filter(|fact| {
                            fact.predicate == property
                                && fact.subject == left.object.as_str().unwrap()
                                && fact.object.is_string()
                        }) {
                            add_candidate(
                                candidates,
                                &left.subject,
                                property,
                                right.object.clone(),
                                "transitive-object-property",
                                vec![
                                    axiom_id.clone(),
                                    left.premise_id.clone(),
                                    right.premise_id.clone(),
                                ],
                            );
                        }
                    }
                }
                _ => {}
            }
        }
    }

    const X: &str = "https://x.test/";

    fn axiom(id: &str, body: Value) -> Value {
        let mut value = body;
        value["graph"] = json!({"kind": "DefaultGraph"});
        value["id"] = json!(id);
        value["provenance"] = json!({"locator": "x.ttl", "sourceDigest": format!("sha256:{}", "a".repeat(64)), "sourceId": "source:x", "status": "available"});
        value
    }

    fn class(name: &str) -> Value {
        json!({"iri": format!("{X}{name}"), "kind": "NamedClass"})
    }

    fn iri(name: &str) -> String {
        format!("{X}{name}")
    }

    fn integer(lexical: &str) -> Value {
        json!({"datatype": "http://www.w3.org/2001/XMLSchema#integer", "kind": "Literal", "language": null, "lexicalForm": lexical})
    }

    /// Every V1 rule at once: a class tree, equivalence, inverse and transitive properties, named
    /// and union domains, ranges, and data assertions, with identifiers out of order.
    fn rich_axioms(classes: usize, individuals: usize) -> Vec<Value> {
        let mut axioms = Vec::new();
        let mut next = 0;
        let mut push = |body: Value| {
            next += 1;
            axioms.push(axiom(&format!("a{:04}", (next * 7919) % 10_000), body));
        };
        for c in 1..classes {
            push(
                json!({"kind": "SubClassOf", "subClass": class(&format!("C{c}")), "superClass": class(&format!("C{}", (c - 1) / 2))}),
            );
        }
        push(json!({"classes": [class("C1"), class("Same")], "kind": "EquivalentClasses"}));
        push(json!({"kind": "InverseObjectProperties", "left": iri("p"), "right": iri("q")}));
        push(json!({"kind": "TransitiveObjectProperty", "property": iri("part")}));
        push(
            json!({"domain": class("C1"), "kind": "PropertyDomain", "property": iri("p"), "propertyKind": "ObjectProperty"}),
        );
        push(
            json!({"kind": "PropertyRange", "property": iri("p"), "propertyKind": "ObjectProperty", "range": iri(&format!("C{}", classes - 1))}),
        );
        push(
            json!({"domain": {"kind": "ObjectUnionOf", "operands": [iri("C2"), iri("C3")]}, "kind": "PropertyDomain", "property": iri("part"), "propertyKind": "ObjectProperty"}),
        );
        push(
            json!({"domain": class("C2"), "kind": "PropertyDomain", "property": iri("amount"), "propertyKind": "DataProperty"}),
        );
        for i in 0..individuals {
            let subject = iri(&format!("i{i}"));
            let object = iri(&format!("i{}", (i + 1) % individuals));
            push(
                json!({"classExpression": class(&format!("C{}", i % classes)), "individual": subject, "kind": "ClassAssertion"}),
            );
            push(
                json!({"kind": "ObjectPropertyAssertion", "object": object, "property": iri(if i % 2 == 0 { "p" } else { "q" }), "subject": subject}),
            );
            push(
                json!({"kind": "ObjectPropertyAssertion", "object": object, "property": iri("part"), "subject": subject}),
            );
            push(
                json!({"kind": "DataPropertyAssertion", "property": iri("amount"), "subject": subject, "value": integer(&(i % 3).to_string())}),
            );
        }
        axioms.sort_by(|left, right| {
            cmp_utf16(left["id"].as_str().unwrap(), right["id"].as_str().unwrap())
        });
        axioms
    }

    fn fixture_axioms(name: &str) -> Vec<Value> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../protocol/fixtures/known-answer")
            .join(format!("{name}.request.json"));
        let request: Value =
            serde_json::from_slice(&fs::read(path).expect("fixture")).expect("json");
        request["ontology"]["axioms"]
            .as_array()
            .expect("axioms")
            .clone()
    }

    fn premise_ids(facts: &BTreeMap<String, Fact>) -> Vec<(String, String)> {
        facts
            .iter()
            .map(|(key, fact)| (key.clone(), fact.premise_id.clone()))
            .collect()
    }

    #[test]
    fn the_queued_closure_matches_the_recomputing_reference_exactly() {
        let mut cases: Vec<Vec<Value>> = [
            "subclass-type",
            "domain-range",
            "equivalence",
            "disjointness",
            "inverse-transitive-properties",
            "unsatisfiable-classes",
            "current-demo-constructs",
        ]
        .iter()
        .map(|name| fixture_axioms(name))
        .collect();
        cases.extend([rich_axioms(4, 3), rich_axioms(7, 6), rich_axioms(12, 9)]);
        for axioms in cases {
            let (_, initial) = initial_facts(&axioms);
            let mut queued = initial.clone();
            let mut reference = initial.clone();
            let mut fast = close_facts(&axioms, &mut queued, 100_000).expect("closure");
            sort_statements(&mut fast);
            let slow = reference_close_facts(&axioms, &mut reference, 100_000).expect("reference");
            assert_eq!(fast, slow);
            assert_eq!(premise_ids(&queued), premise_ids(&reference));
            for limit in [0, 1, fast.len().saturating_sub(1) as u64, fast.len() as u64] {
                let (_, mut left) = initial_facts(&axioms);
                let (_, mut right) = initial_facts(&axioms);
                let left = close_facts(&axioms, &mut left, limit)
                    .map(|mut statements| {
                        sort_statements(&mut statements);
                        statements
                    })
                    .map_err(|refusal| refusal.diagnostics[0].code);
                let right = reference_close_facts(&axioms, &mut right, limit)
                    .map_err(|refusal| refusal.diagnostics[0].code);
                assert_eq!(left, right, "limit {limit}");
            }
        }
    }

    #[test]
    fn signatures_group_individuals_by_types_and_union_domains() {
        let axioms = rich_axioms(4, 3);
        let (_, mut facts) = initial_facts(&axioms);
        close_facts(&axioms, &mut facts, 100_000).expect("closure");
        let grouped = Individuals::collect(&axioms, &facts).signatures();
        let individuals: usize = grouped.values().map(Vec::len).sum();
        assert_eq!(individuals, 3);
        for signature in grouped.keys() {
            assert_eq!(
                signature.unions.len(),
                1,
                "every individual is the subject of a part assertion"
            );
            assert!(signature.types.contains(&iri("C0")));
        }
        let lone = vec![axiom(
            "b1",
            json!({"kind": "ObjectPropertyAssertion", "object": iri("j"), "property": iri("r"), "subject": iri("i")}),
        )];
        let (_, facts) = initial_facts(&lone);
        let grouped = Individuals::collect(&lone, &facts).signatures();
        assert_eq!(grouped.get(&Signature::default()).map(Vec::len), Some(2));
    }

    fn hierarchy_of(axioms: &[Value]) -> (Vec<&Value>, bool) {
        let hierarchy = hierarchy_axioms(axioms);
        let dataset = hierarchy_dataset(&hierarchy).expect("dataset");
        let reasoner = open_reasoner(&dataset).expect("reasoner");
        let classification = reasoner.classify().expect("classification");
        let thing = thing_has_superclass(classification.answer());
        (hierarchy, thing)
    }

    fn signatures_consistent(
        hierarchy: &[&Value],
        thing: bool,
        signatures: Vec<Signature>,
    ) -> bool {
        check_signatures(
            hierarchy,
            signatures,
            thing,
            |_| None,
            "urn:erden-reasoner:check:signature:",
            || Ok(()),
        )
        .expect("decided")
    }

    fn signature(types: &[&str], unions: &[&[&str]]) -> Signature {
        Signature {
            types: types.iter().map(|name| iri(name)).collect(),
            unions: unions
                .iter()
                .map(|operands| operands.iter().map(|name| iri(name)).collect())
                .collect(),
        }
    }

    fn inferred_shape(statements: &[Value]) -> Vec<Value> {
        statements
            .iter()
            .map(|item| {
                json!([
                    item["subject"],
                    item["predicate"],
                    item["object"],
                    item["provenance"]["rule"],
                    item["provenance"]["premiseIds"]
                ])
            })
            .collect()
    }

    /// Runs the whole procedure and requires a consistent decision listing exactly the closure's
    /// statements plus `typed`: `[individual, class, rule, premises]` for each type only case
    /// analysis or `owl:Thing` reaches.
    fn assert_decided_with_types(axioms: Vec<Value>, typed: &[(&str, &str, &str, &[&str])]) {
        let (_, mut facts) = initial_facts(&axioms);
        let closure = close_facts(&axioms, &mut facts, 100_000).expect("closure");
        let result = reason(&request_with(axioms), std::time::Instant::now());
        assert_eq!(result["outcome"], "decided", "{result}");
        assert_eq!(result["consistency"], "consistent");
        let mut expected = inferred_shape(&closure);
        expected.extend(typed.iter().map(|(subject, class, rule, premises)| {
            json!([iri(subject), RDF_TYPE, iri(class), rule, premises])
        }));
        let mut actual = inferred_shape(result["inferred"].as_array().expect("inferred"));
        let order = |left: &Value, right: &Value| left.to_string().cmp(&right.to_string());
        expected.sort_by(order);
        actual.sort_by(order);
        assert_eq!(actual, expected);
    }

    fn declared(name: &str) -> Value {
        axiom(
            &format!("decl-{name}"),
            json!({"entityKind": "Class", "iri": iri(name), "kind": "Declaration"}),
        )
    }

    fn union_domain(id: &str, property: &str, operands: &[&str]) -> Value {
        let mut operands: Vec<String> = operands.iter().map(|name| iri(name)).collect();
        operands.sort();
        axiom(
            id,
            json!({"domain": {"kind": "ObjectUnionOf", "operands": operands}, "kind": "PropertyDomain", "property": iri(property), "propertyKind": "ObjectProperty"}),
        )
    }

    fn related(id: &str, subject: &str, property: &str, object: &str) -> Value {
        axiom(
            id,
            json!({"kind": "ObjectPropertyAssertion", "object": iri(object), "property": iri(property), "subject": iri(subject)}),
        )
    }

    fn typed(id: &str, individual: &str, class_name: &str) -> Value {
        axiom(
            id,
            json!({"classExpression": class(class_name), "individual": iri(individual), "kind": "ClassAssertion"}),
        )
    }

    fn subclass(id: &str, sub: &str, sup: &str) -> Value {
        axiom(
            id,
            json!({"kind": "SubClassOf", "subClass": class(sub), "superClass": class(sup)}),
        )
    }

    fn disjoint(id: &str, classes: &[&str]) -> Value {
        axiom(
            id,
            json!({"classes": classes.iter().map(|name| class(name)).collect::<Vec<_>>(), "kind": "DisjointClasses"}),
        )
    }

    fn thing_below(id: &str, sup: &str) -> Value {
        axiom(
            id,
            json!({"kind": "SubClassOf", "subClass": {"iri": OWL_THING, "kind": "NamedClass"}, "superClass": class(sup)}),
        )
    }

    #[test]
    fn a_union_domain_whose_operands_share_a_superclass_types_its_subject() {
        assert_decided_with_types(
            vec![
                declared("A"),
                declared("B"),
                declared("Agent"),
                subclass("h1", "A", "Agent"),
                subclass("h2", "B", "Agent"),
                union_domain("h3", "p", &["A", "B"]),
                related("h4", "i", "p", "j"),
            ],
            &[("i", "Agent", "union-domain-type", &["h1", "h2", "h3", "h4"])],
        );
    }

    #[test]
    fn a_union_operand_excluded_by_disjointness_types_its_subject() {
        assert_decided_with_types(
            vec![
                declared("A"),
                declared("B"),
                declared("X"),
                disjoint("h1", &["A", "X"]),
                union_domain("h2", "p", &["A", "B"]),
                typed("h3", "i", "X"),
                related("h4", "i", "p", "j"),
            ],
            &[("i", "B", "union-domain-type", &["h1", "h2", "h3", "h4"])],
        );
    }

    #[test]
    fn a_superclass_of_owl_thing_types_every_individual() {
        assert_decided_with_types(
            vec![
                declared("T"),
                declared("U"),
                thing_below("h1", "T"),
                typed("h2", "j", "U"),
                axiom(
                    "h3",
                    json!({"entityKind": "NamedIndividual", "iri": iri("k"), "kind": "Declaration"}),
                ),
            ],
            &[
                ("j", "T", "thing-subclass-type", &["h1", "h2"]),
                ("k", "T", "thing-subclass-type", &["h1", "h3"]),
            ],
        );
    }

    #[test]
    fn two_union_domains_decide_together_what_neither_decides_alone() {
        // Either A or B, and either A or C, with B and C disjoint: only A is left in every case.
        assert_decided_with_types(
            vec![
                declared("A"),
                declared("B"),
                declared("C"),
                disjoint("h1", &["B", "C"]),
                union_domain("h2", "p", &["A", "B"]),
                union_domain("h3", "q", &["A", "C"]),
                related("h4", "i", "p", "j"),
                related("h5", "i", "q", "j"),
            ],
            &[(
                "i",
                "A",
                "union-domain-type",
                &["h1", "h2", "h3", "h4", "h5"],
            )],
        );
    }

    #[test]
    fn a_union_its_subject_already_meets_or_one_that_settles_nothing_adds_no_type() {
        assert_decided_with_types(
            vec![
                declared("A"),
                declared("B"),
                union_domain("h1", "p", &["A", "B"]),
                typed("h2", "i", "A"),
                related("h3", "i", "p", "j"),
                related("h4", "k", "p", "j"),
            ],
            &[],
        );
    }

    #[test]
    fn too_many_union_cases_are_refused_rather_than_left_untyped() {
        let mut axioms = Vec::new();
        for index in 0..13 {
            axioms.push(union_domain(
                &format!("u{index:02}"),
                &format!("p{index:02}"),
                &[&format!("A{index:02}"), &format!("B{index:02}")],
            ));
            axioms.push(related(
                &format!("v{index:02}"),
                "i",
                &format!("p{index:02}"),
                "j",
            ));
        }
        let result = reason(&request_with(axioms), std::time::Instant::now());
        assert_eq!(result["outcome"], "refused", "{result}");
        assert_eq!(result["reason"], "boundary-exhausted");
        assert_eq!(result["diagnostics"][0]["code"], "union-case-limit");
    }

    // A deterministic generator of small V1 ontologies, for comparing the engine's named types
    // with PurRDF's realization of the whole ontology.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self, bound: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 33) % bound as u64) as usize
        }

        fn chance(&mut self, percent: usize) -> bool {
            self.next(100) < percent
        }
    }

    fn random_ontology(seed: u64) -> Vec<Value> {
        let mut random = Lcg(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let classes = 3 + random.next(5);
        let name = |index: usize| format!("C{index}");
        let mut bodies: Vec<Value> = Vec::new();
        for index in 0..classes {
            bodies.push(
                json!({"entityKind": "Class", "iri": iri(&name(index)), "kind": "Declaration"}),
            );
        }
        for _ in 0..random.next(classes + 2) {
            let (sub, sup) = (random.next(classes), random.next(classes));
            if sub != sup {
                bodies.push(json!({"kind": "SubClassOf", "subClass": class(&name(sub)), "superClass": class(&name(sup))}));
            }
        }
        if random.chance(30) {
            let (left, right) = (random.next(classes), random.next(classes));
            if left != right {
                let mut pair = [iri(&name(left)), iri(&name(right))];
                pair.sort();
                bodies.push(json!({"classes": pair.iter().map(|iri| json!({"iri": iri, "kind": "NamedClass"})).collect::<Vec<_>>(), "kind": "EquivalentClasses"}));
            }
        }
        for _ in 0..random.next(3) {
            let (left, right) = (random.next(classes), random.next(classes));
            if left != right {
                let mut pair = [iri(&name(left)), iri(&name(right))];
                pair.sort();
                bodies.push(json!({"classes": pair.iter().map(|iri| json!({"iri": iri, "kind": "NamedClass"})).collect::<Vec<_>>(), "kind": "DisjointClasses"}));
            }
        }
        if random.chance(20) {
            bodies.push(json!({"kind": "SubClassOf", "subClass": {"iri": OWL_THING, "kind": "NamedClass"}, "superClass": class(&name(random.next(classes)))}));
        }
        let properties = 1 + random.next(3);
        for property in 0..properties {
            let p = iri(&format!("p{property}"));
            bodies.push(json!({"entityKind": "ObjectProperty", "iri": p, "kind": "Declaration"}));
            if random.chance(60) {
                let mut operands: Vec<String> = (0..2 + random.next(2))
                    .map(|_| iri(&name(random.next(classes))))
                    .collect();
                operands.sort();
                operands.dedup();
                if operands.len() > 1 {
                    bodies.push(json!({"domain": {"kind": "ObjectUnionOf", "operands": operands}, "kind": "PropertyDomain", "property": p, "propertyKind": "ObjectProperty"}));
                }
            }
            if random.chance(30) {
                bodies.push(json!({"domain": class(&name(random.next(classes))), "kind": "PropertyDomain", "property": p, "propertyKind": "ObjectProperty"}));
            }
            if random.chance(30) {
                bodies.push(json!({"kind": "PropertyRange", "property": p, "propertyKind": "ObjectProperty", "range": iri(&name(random.next(classes)))}));
            }
        }
        if properties > 1 && random.chance(20) {
            bodies.push(
                json!({"kind": "InverseObjectProperties", "left": iri("p0"), "right": iri("p1")}),
            );
        }
        if random.chance(20) {
            bodies.push(json!({"kind": "TransitiveObjectProperty", "property": iri("p0")}));
        }
        let individuals = 1 + random.next(4);
        for individual in 0..individuals {
            for _ in 0..random.next(3) {
                bodies.push(json!({"classExpression": class(&name(random.next(classes))), "individual": iri(&format!("i{individual}")), "kind": "ClassAssertion"}));
            }
        }
        for _ in 0..random.next(5) {
            bodies.push(json!({"kind": "ObjectPropertyAssertion", "object": iri(&format!("i{}", random.next(individuals))), "property": iri(&format!("p{}", random.next(properties))), "subject": iri(&format!("i{}", random.next(individuals)))}));
        }
        if random.chance(20) {
            bodies.push(
                json!({"entityKind": "NamedIndividual", "iri": iri("lone"), "kind": "Declaration"}),
            );
        }
        let mut seen = BTreeSet::new();
        bodies.retain(|body| seen.insert(body.to_string()));
        bodies
            .into_iter()
            .enumerate()
            .map(|(index, body)| axiom(&format!("a{index:03}"), body))
            .collect()
    }

    /// The whole ontology as one PurRDF dataset, as the 0.1 engine built it.
    fn whole_dataset(axioms: &[Value]) -> Arc<RdfDataset> {
        let mut builder = RdfDatasetBuilder::new();
        for (index, axiom) in axioms.iter().enumerate() {
            match axiom["kind"].as_str().unwrap() {
                "Declaration" => {
                    let kind = match axiom["entityKind"].as_str().unwrap() {
                        "Class" => OWL_CLASS,
                        "ObjectProperty" => "http://www.w3.org/2002/07/owl#ObjectProperty",
                        _ => "http://www.w3.org/2002/07/owl#NamedIndividual",
                    };
                    push_iri(&mut builder, axiom["iri"].as_str().unwrap(), RDF_TYPE, kind);
                }
                "SubClassOf" => push_iri(
                    &mut builder,
                    axiom["subClass"]["iri"].as_str().unwrap(),
                    RDFS_SUBCLASS,
                    axiom["superClass"]["iri"].as_str().unwrap(),
                ),
                "EquivalentClasses" | "DisjointClasses" => {
                    let predicate = if axiom["kind"] == "EquivalentClasses" {
                        OWL_EQUIVALENT
                    } else {
                        OWL_DISJOINT
                    };
                    let classes = axiom["classes"].as_array().unwrap();
                    push_iri(
                        &mut builder,
                        classes[0]["iri"].as_str().unwrap(),
                        predicate,
                        classes[1]["iri"].as_str().unwrap(),
                    );
                }
                "ClassAssertion" => push_iri(
                    &mut builder,
                    axiom["individual"].as_str().unwrap(),
                    RDF_TYPE,
                    axiom["classExpression"]["iri"].as_str().unwrap(),
                ),
                "PropertyDomain" if axiom["domain"]["kind"] == "NamedClass" => push_iri(
                    &mut builder,
                    axiom["property"].as_str().unwrap(),
                    RDFS_DOMAIN,
                    axiom["domain"]["iri"].as_str().unwrap(),
                ),
                "PropertyDomain" => {
                    let property = builder.intern_iri(axiom["property"].as_str().unwrap());
                    let domain = builder.intern_iri(RDFS_DOMAIN);
                    let expression =
                        builder.intern_blank(&format!("domain_{index}"), BlankScope::DEFAULT);
                    builder.push_quad(property, domain, expression, None);
                    let union = builder.intern_iri(OWL_UNION);
                    let operands = axiom["domain"]["operands"].as_array().unwrap();
                    let mut cell =
                        builder.intern_blank(&format!("list_{index}_0"), BlankScope::DEFAULT);
                    builder.push_quad(expression, union, cell, None);
                    for (offset, operand) in operands.iter().enumerate() {
                        let first = builder.intern_iri(RDF_FIRST);
                        let member = builder.intern_iri(operand.as_str().unwrap());
                        builder.push_quad(cell, first, member, None);
                        let rest = builder.intern_iri(RDF_REST);
                        let next = if offset + 1 == operands.len() {
                            builder.intern_iri(RDF_NIL)
                        } else {
                            builder.intern_blank(
                                &format!("list_{index}_{}", offset + 1),
                                BlankScope::DEFAULT,
                            )
                        };
                        builder.push_quad(cell, rest, next, None);
                        cell = next;
                    }
                }
                "PropertyRange" => push_iri(
                    &mut builder,
                    axiom["property"].as_str().unwrap(),
                    RDFS_RANGE,
                    axiom["range"].as_str().unwrap(),
                ),
                "InverseObjectProperties" => push_iri(
                    &mut builder,
                    axiom["left"].as_str().unwrap(),
                    OWL_INVERSE,
                    axiom["right"].as_str().unwrap(),
                ),
                "TransitiveObjectProperty" => push_iri(
                    &mut builder,
                    axiom["property"].as_str().unwrap(),
                    RDF_TYPE,
                    OWL_TRANSITIVE,
                ),
                "ObjectPropertyAssertion" => push_iri(
                    &mut builder,
                    axiom["subject"].as_str().unwrap(),
                    axiom["property"].as_str().unwrap(),
                    axiom["object"].as_str().unwrap(),
                ),
                other => panic!("generator made {other}"),
            }
        }
        builder.freeze().unwrap()
    }

    /// Each individual's named types in a decided result: its asserted and inferred types.
    fn engine_types(result: &Value) -> BTreeMap<String, BTreeSet<String>> {
        let mut types: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for key in ["asserted", "inferred"] {
            for statement in result[key].as_array().expect("statements") {
                if statement["predicate"] == RDF_TYPE {
                    types
                        .entry(statement["subject"].as_str().unwrap().to_owned())
                        .or_default()
                        .insert(statement["object"].as_str().unwrap().to_owned());
                }
            }
        }
        types
    }

    /// The completeness guard the runtime no longer pays for: on generated ontologies that use
    /// every V1 construct, the engine lists exactly the named types PurRDF's realization of the
    /// whole ontology finds, and decides consistency as PurRDF does.
    #[test]
    fn every_entailed_named_type_is_listed_as_purrdf_realizes_it() {
        let mut decided = 0;
        let mut others: BTreeMap<String, usize> = BTreeMap::new();
        let mut reached: BTreeMap<String, usize> = BTreeMap::new();
        for seed in 0..400 {
            let axioms = random_ontology(seed);
            let result = reason(&request_with(axioms.clone()), std::time::Instant::now());
            let dataset = whole_dataset(&axioms);
            let reasoner = Reasoner::new(&dataset).expect("open the whole ontology");
            let consistent = matches!(*reasoner.consistency().answer(), Verdict::True);
            match (result["outcome"].as_str(), result["consistency"].as_str()) {
                (Some("decided"), Some("consistent")) => {
                    assert!(
                        consistent,
                        "seed {seed}: PurRDF finds the ontology inconsistent"
                    );
                    let realization = reasoner.realize().expect("realize");
                    let mut expected: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
                    for (individual, class) in realization.answer().types() {
                        if let (Some(individual), Some(class)) =
                            (individual.as_iri(), class.as_iri())
                            && class != OWL_THING
                        {
                            expected
                                .entry(individual.to_owned())
                                .or_default()
                                .insert(class.to_owned());
                        }
                    }
                    assert_eq!(engine_types(&result), expected, "seed {seed}: {axioms:?}");
                    decided += 1;
                    for statement in result["inferred"].as_array().expect("inferred") {
                        let rule = statement["provenance"]["rule"].as_str().unwrap_or("");
                        if ["union-domain-type", "thing-subclass-type"].contains(&rule) {
                            *reached.entry(rule.to_owned()).or_default() += 1;
                        }
                    }
                }
                (Some("decided"), Some("inconsistent")) => {
                    assert!(!consistent, "seed {seed}");
                    *others.entry("decided inconsistent".into()).or_default() += 1;
                }
                _ => {
                    let code = result["diagnostics"][0]["code"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                    if code == "uncheckable-inconsistency" {
                        // PurRDF accepts an unsatisfiable `owl:Thing` on an empty domain, which
                        // OWL 2 Direct Semantics does not have.
                        let thing_unsatisfiable = || {
                            reasoner.classify().is_ok_and(|hierarchy| {
                                hierarchy
                                    .answer()
                                    .unsatisfiable()
                                    .iter()
                                    .any(|class| class.as_iri() == Some(OWL_THING))
                            })
                        };
                        assert!(
                            !consistent || thing_unsatisfiable(),
                            "seed {seed}: refused a consistent ontology"
                        );
                    }
                    assert!(
                        [
                            "uncheckable-inconsistency",
                            "uncheckable-unsatisfiable-class"
                        ]
                        .contains(&code.as_str()),
                        "seed {seed}: {result}"
                    );
                    *others.entry(code).or_default() += 1;
                }
            }
        }
        eprintln!(
            "decided consistent {decided}, others {others:?}, case-analysis types {reached:?}"
        );
        assert!(
            decided >= 200,
            "decided consistent {decided}, others {others:?}"
        );
        // The generator reaches both rules often enough for the comparison to have teeth.
        assert!(
            reached.get("union-domain-type").copied().unwrap_or(0) >= 20,
            "{reached:?}"
        );
        assert!(
            reached.get("thing-subclass-type").copied().unwrap_or(0) >= 20,
            "{reached:?}"
        );
    }

    #[test]
    fn signatures_are_checked_for_consistency_with_the_hierarchy() {
        let axioms = vec![
            axiom(
                "h1",
                json!({"kind": "SubClassOf", "subClass": class("A"), "superClass": class("D")}),
            ),
            axiom(
                "h2",
                json!({"kind": "SubClassOf", "subClass": class("B"), "superClass": class("D")}),
            ),
            axiom(
                "h3",
                json!({"classes": [class("A"), class("B")], "kind": "DisjointClasses"}),
            ),
        ];
        let (hierarchy, thing) = hierarchy_of(&axioms);
        let consistent = |types: &[&str], unions: &[&[&str]]| {
            signatures_consistent(&hierarchy, thing, vec![signature(types, unions)])
        };
        assert!(consistent(&[], &[&["A", "B"]]));
        assert!(consistent(&["A", "D"], &[&["A", "B"]]));
        assert!(!consistent(&["A", "B", "D"], &[]));
        assert!(!consistent(&["A"], &[&["B"]]));
        assert!(consistent(&[], &[]));
        // Many signatures share one copy of the hierarchy; each is still asked on its own.
        let fine = || {
            vec![
                signature(&["A", "D"], &[]),
                signature(&["B", "D"], &[]),
                signature(&["D"], &[]),
            ]
        };
        assert!(signatures_consistent(&hierarchy, thing, fine()));
        let mut one_bad = fine();
        one_bad.push(signature(&["A", "B"], &[]));
        assert!(!signatures_consistent(&hierarchy, thing, one_bad));
        let many: Vec<Signature> = (0..300)
            .map(|index| signature(&["D", &format!("E{index}")], &[]))
            .collect();
        assert!(signatures_consistent(&hierarchy, thing, many));
    }

    #[test]
    fn the_classification_answers_a_signature_of_one_class_and_its_superclasses() {
        let mut axioms: Vec<Value> = ["A", "B", "D", "U"].into_iter().map(declared).collect();
        axioms.extend([
            subclass("h1", "A", "D"),
            subclass("h2", "B", "D"),
            subclass("h3", "U", "A"),
            subclass("h4", "U", "B"),
            disjoint("h5", &["A", "B"]),
        ]);
        let hierarchy = hierarchy_axioms(&axioms);
        let dataset = hierarchy_dataset(&hierarchy).expect("dataset");
        let reasoner = open_reasoner(&dataset).expect("reasoner");
        let classification = reasoner.classify().expect("classification");
        let thing = thing_has_superclass(classification.answer());
        let (_, mut facts) = initial_facts(&axioms);
        close_facts(&axioms, &mut facts, 1_000).expect("closure");
        let closed = Hierarchy::collect(&axioms, &facts);
        let classified = Classified::new(&axioms, &closed, classification.answer());
        type Case<'a> = (&'a [&'a str], &'a [&'a [&'a str]], Option<bool>);
        let cases: [Case<'_>; 6] = [
            (&["A", "D"], &[], Some(true)),
            (&["D"], &[], Some(true)),
            (&["U", "A", "B", "D"], &[], Some(false)),
            // No one type implies the others, or a union: PurRDF is asked.
            (&["A", "B", "D"], &[], None),
            (&["A", "D"], &[&["A", "B"]], None),
            // An undeclared class is left to PurRDF.
            (&["E"], &[], None),
        ];
        for (types, unions, expected) in cases {
            let asked = signature(types, unions);
            assert_eq!(
                classified.satisfiable(&asked),
                expected,
                "{types:?} {unions:?}"
            );
            if let Some(answer) = expected {
                assert_eq!(
                    signatures_consistent(&hierarchy, thing, vec![asked]),
                    answer,
                    "{types:?}: PurRDF agrees"
                );
            }
        }
        // owl:Thing, as the empty signature is asked, is always classified.
        let thing_only = Signature {
            types: BTreeSet::from([OWL_THING.to_owned()]),
            unions: BTreeSet::new(),
        };
        assert_eq!(classified.satisfiable(&thing_only), Some(true));
        assert!(signatures_consistent(&hierarchy, thing, vec![thing_only]));
        // An individual typed with the unsatisfiable class is refused without asking PurRDF again.
        let mut typed = axioms.clone();
        typed.push(axiom("i1", json!({"classExpression": class("U"), "individual": iri("i"), "kind": "ClassAssertion"})));
        let result = reason(&request_with(typed), std::time::Instant::now());
        assert_eq!(
            result["diagnostics"][0]["code"],
            "uncheckable-inconsistency"
        );
    }

    #[test]
    fn an_untyped_individual_meets_an_unsatisfiable_owl_thing() {
        let axioms = vec![
            axiom(
                "h1",
                json!({"kind": "SubClassOf", "subClass": {"iri": OWL_THING, "kind": "NamedClass"}, "superClass": class("A")}),
            ),
            axiom(
                "h2",
                json!({"kind": "SubClassOf", "subClass": {"iri": OWL_THING, "kind": "NamedClass"}, "superClass": class("B")}),
            ),
            axiom(
                "h3",
                json!({"classes": [class("A"), class("B")], "kind": "DisjointClasses"}),
            ),
        ];
        let (hierarchy, thing) = hierarchy_of(&axioms);
        assert!(thing);
        assert!(!signatures_consistent(
            &hierarchy,
            thing,
            vec![Signature::default()]
        ));
        let mut request = axioms.clone();
        request.push(axiom(
            "h4",
            json!({"kind": "ObjectPropertyAssertion", "object": iri("j"), "property": iri("p"), "subject": iri("i")}),
        ));
        let result = reason(&request_with(request), std::time::Instant::now());
        assert_eq!(result["outcome"], "refused");
        assert_eq!(
            result["diagnostics"][0]["code"],
            "uncheckable-inconsistency"
        );
    }

    #[test]
    fn an_unsatisfiable_owl_thing_has_no_model_even_without_individuals() {
        // OWL 2 Direct Semantics needs a non-empty domain. With no individual there is no
        // signature to check, and PurRDF accepts the hierarchy on an empty domain, so this was
        // decided consistent (by 0.1.0 as well).
        let thing = || json!({"iri": OWL_THING, "kind": "NamedClass"});
        let equivalent = vec![
            axiom(
                "e1",
                json!({"classes": [thing(), class("A")], "kind": "EquivalentClasses"}),
            ),
            axiom(
                "e2",
                json!({"classes": [thing(), class("B")], "kind": "EquivalentClasses"}),
            ),
            axiom(
                "e3",
                json!({"classes": [class("A"), class("B")], "kind": "DisjointClasses"}),
            ),
        ];
        let below = vec![
            axiom(
                "h1",
                json!({"kind": "SubClassOf", "subClass": thing(), "superClass": class("A")}),
            ),
            axiom(
                "h2",
                json!({"kind": "SubClassOf", "subClass": thing(), "superClass": class("B")}),
            ),
            axiom(
                "h3",
                json!({"classes": [class("A"), class("B")], "kind": "DisjointClasses"}),
            ),
        ];
        for axioms in [equivalent, below] {
            let result = reason(&request_with(axioms), std::time::Instant::now());
            assert_eq!(result["outcome"], "refused", "{result}");
            assert_eq!(result["reason"], "incomplete-certificate");
            assert_eq!(
                result["diagnostics"][0]["code"],
                "uncheckable-inconsistency"
            );
        }
    }

    #[test]
    fn literals_are_checked_against_each_range_of_their_property_or_alone_without_one() {
        let assertion = |id: &str, value: Value| {
            axiom(
                id,
                json!({"kind": "DataPropertyAssertion", "property": iri("amount"), "subject": iri("i"), "value": value}),
            )
        };
        let ranged = axiom(
            "r1",
            json!({"kind": "PropertyRange", "property": iri("amount"), "propertyKind": "DataProperty", "range": "http://www.w3.org/2001/XMLSchema#integer"}),
        );
        let property = "urn:erden-reasoner:check:property";
        let individual = "urn:erden-reasoner:check:individual";
        assert!(
            check_literals(
                &[ranged.clone(), assertion("d1", integer("1"))],
                property,
                individual
            )
            .expect("in range")
            .is_empty()
        );
        let text = json!({"datatype": "http://www.w3.org/2001/XMLSchema#string", "kind": "Literal", "language": null, "lexicalForm": "x"});
        let clashes = check_literals(
            &[ranged, assertion("d1", text.clone())],
            property,
            individual,
        )
        .expect("out of range");
        assert_eq!(clashes.len(), 1);
        assert_eq!(
            clashes[0].range.as_deref(),
            Some("http://www.w3.org/2001/XMLSchema#integer")
        );
        assert_eq!(clashes[0].literal.as_ref(), Some(&text));
        assert!(
            check_literals(&[assertion("d1", text)], property, individual)
                .expect("no range")
                .is_empty()
        );
        let clashes = check_literals(&[assertion("d1", integer("x"))], property, individual)
            .expect("ill-typed");
        assert_eq!(clashes.len(), 1);
        assert_eq!(clashes[0].range, None);
        assert_eq!(clashes[0].literal.as_ref(), Some(&integer("x")));
    }

    #[test]
    fn many_literals_share_a_bounded_number_of_checks() {
        let mut axioms = vec![axiom(
            "r1",
            json!({"kind": "PropertyRange", "property": iri("amount"), "propertyKind": "DataProperty", "range": "http://www.w3.org/2001/XMLSchema#integer"}),
        )];
        for i in 0..(LITERALS_PER_CHECK * 2 + 1) {
            axioms.push(axiom(&format!("d{i:05}"), json!({"kind": "DataPropertyAssertion", "property": iri("amount"), "subject": iri(&format!("i{i}")), "value": integer(&i.to_string())})));
        }
        assert!(
            check_literals(&axioms, "urn:p", "urn:i")
                .expect("all integers")
                .is_empty()
        );
        axioms.push(axiom("d99999", json!({"kind": "DataPropertyAssertion", "property": iri("amount"), "subject": iri("last"), "value": integer("not-a-number")})));
        let clashes = check_literals(&axioms, "urn:p", "urn:i").expect("one ill-typed");
        assert_eq!(clashes.len(), 1);
        assert_eq!(clashes[0].literal.as_ref(), Some(&integer("not-a-number")));
    }

    #[test]
    fn every_literal_outside_its_range_is_found_among_many_up_to_the_limit() {
        let mut axioms = vec![axiom(
            "r1",
            json!({"kind": "PropertyRange", "property": iri("amount"), "propertyKind": "DataProperty", "range": "http://www.w3.org/2001/XMLSchema#integer"}),
        )];
        let text = |lexical: &str| json!({"datatype": "http://www.w3.org/2001/XMLSchema#string", "kind": "Literal", "language": null, "lexicalForm": lexical});
        for i in 0..LITERALS_PER_CHECK {
            axioms.push(axiom(&format!("d{i:05}"), json!({"kind": "DataPropertyAssertion", "property": iri("amount"), "subject": iri(&format!("i{i}")), "value": integer(&i.to_string())})));
        }
        for name in ["first", "second"] {
            axioms.push(axiom(&format!("t-{name}"), json!({"kind": "DataPropertyAssertion", "property": iri("amount"), "subject": iri(name), "value": text(name)})));
        }
        let found: BTreeSet<String> = check_literals(&axioms, "urn:p", "urn:i")
            .expect("two strings")
            .into_iter()
            .map(|clash| {
                clash.literal.expect("isolated")["lexicalForm"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(
            found,
            BTreeSet::from(["first".to_owned(), "second".to_owned()])
        );
        for i in 0..MAX_EXPLAINED_CLASHES {
            axioms.push(axiom(&format!("u{i:05}"), json!({"kind": "DataPropertyAssertion", "property": iri("amount"), "subject": iri("many"), "value": text(&format!("u{i}"))})));
        }
        assert_eq!(
            check_literals(&axioms, "urn:p", "urn:i")
                .expect("many strings")
                .len(),
            MAX_EXPLAINED_CLASHES
        );
    }

    #[test]
    fn fresh_check_terms_never_collide_with_the_request() {
        let axioms = [axiom(
            "c1",
            json!({"entityKind": "Class", "iri": "urn:erden-reasoner:check:individual", "kind": "Declaration"}),
        )];
        let used: BTreeSet<&str> = axioms.iter().flat_map(axiom_iris).collect();
        assert_eq!(
            fresh_iri(&used, "urn:erden-reasoner:check:individual"),
            "urn:erden-reasoner:check:individual-"
        );
        assert_eq!(
            fresh_iri(&used, "urn:erden-reasoner:check:property"),
            "urn:erden-reasoner:check:property"
        );
        let numbered = BTreeSet::from([
            "urn:erden-reasoner:check:individual:7",
            "urn:erden-reasoner:check:individual-:x",
        ]);
        assert_eq!(
            fresh_prefix(&numbered, "urn:erden-reasoner:check:individual:"),
            "urn:erden-reasoner:check:individual--:"
        );
        assert_eq!(
            fresh_prefix(&used, "urn:erden-reasoner:check:individual:"),
            "urn:erden-reasoner:check:individual:"
        );
    }

    #[test]
    fn the_hierarchy_keeps_only_class_axioms_and_vocabulary_declarations() {
        let axioms = rich_axioms(4, 2);
        let kinds: BTreeSet<&str> = hierarchy_axioms(&axioms)
            .iter()
            .map(|axiom| axiom["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, BTreeSet::from(["EquivalentClasses", "SubClassOf"]));
    }

    fn request_with(axioms: Vec<Value>) -> Request {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../protocol/fixtures/known-answer/subclass-type.request.json");
        let mut request: Request =
            serde_json::from_slice(&fs::read(path).expect("fixture")).expect("request");
        request.ontology.axioms = axioms;
        request
    }

    #[test]
    fn an_inconsistency_only_the_closure_reveals_refuses_like_the_old_engine() {
        let axioms = vec![
            axiom(
                "a1",
                json!({"classes": [class("A"), class("B")], "kind": "DisjointClasses"}),
            ),
            axiom(
                "a2",
                json!({"kind": "PropertyRange", "property": iri("p"), "propertyKind": "ObjectProperty", "range": iri("A")}),
            ),
            axiom(
                "a3",
                json!({"kind": "PropertyRange", "property": iri("q"), "propertyKind": "ObjectProperty", "range": iri("B")}),
            ),
            axiom(
                "a4",
                json!({"kind": "ObjectPropertyAssertion", "object": iri("j"), "property": iri("p"), "subject": iri("i")}),
            ),
            axiom(
                "a5",
                json!({"kind": "ObjectPropertyAssertion", "object": iri("j"), "property": iri("q"), "subject": iri("i")}),
            ),
        ];
        let result = reason(&request_with(axioms), std::time::Instant::now());
        assert_eq!(result["outcome"], "refused");
        assert_eq!(result["reason"], "incomplete-certificate");
        assert_eq!(
            result["diagnostics"][0]["code"],
            "uncheckable-inconsistency"
        );
    }

    fn string(lexical: &str) -> Value {
        json!({"datatype": "http://www.w3.org/2001/XMLSchema#string", "kind": "Literal", "language": null, "lexicalForm": lexical})
    }

    /// The refusal's diagnostics as (axiom IDs, message), in the response's order.
    fn refusal_diagnostics(result: &Value) -> Vec<(Vec<String>, String)> {
        assert_eq!(result["outcome"], "refused", "{result}");
        assert_eq!(result["reason"], "incomplete-certificate");
        result["diagnostics"]
            .as_array()
            .expect("diagnostics")
            .iter()
            .map(|item| {
                assert_eq!(item["code"], "uncheckable-inconsistency");
                (
                    item["axiomIds"]
                        .as_array()
                        .expect("axiom IDs")
                        .iter()
                        .map(|id| id.as_str().expect("ID").to_owned())
                        .collect(),
                    item["message"].as_str().expect("message").to_owned(),
                )
            })
            .collect()
    }

    #[test]
    fn a_literal_outside_its_range_is_refused_naming_each_statement_that_clashes() {
        let date_time = "http://www.w3.org/2001/XMLSchema#dateTime";
        let assertion = |id: &str, subject: &str, value: Value| {
            axiom(
                id,
                json!({"kind": "DataPropertyAssertion", "property": iri("modified"), "subject": iri(subject), "value": value}),
            )
        };
        let axioms = vec![
            axiom(
                "r1",
                json!({"kind": "PropertyRange", "property": iri("modified"), "propertyKind": "DataProperty", "range": date_time}),
            ),
            assertion("d1", "report", string("2026-09-03")),
            assertion(
                "d2",
                "summary",
                json!({"datatype": date_time, "kind": "Literal", "language": null, "lexicalForm": "2026-09-03T00:00:00"}),
            ),
            assertion("d3", "notes", string("2011-06-29")),
        ];
        let diagnostics =
            refusal_diagnostics(&reason(&request_with(axioms), std::time::Instant::now()));
        assert_eq!(
            diagnostics,
            vec![
                (
                    vec!["d3".to_owned(), "r1".to_owned()],
                    format!(
                        "<{X}notes> <{X}modified> \"2011-06-29\"^^xsd:string, but <{X}modified> has range xsd:dateTime, and \"2011-06-29\"^^xsd:string is not a value of xsd:dateTime, so the ontology is inconsistent; Erden's proof checker cannot certify this kind of inconsistency yet, so reasoning is refused"
                    )
                ),
                (
                    vec!["d1".to_owned(), "r1".to_owned()],
                    format!(
                        "<{X}report> <{X}modified> \"2026-09-03\"^^xsd:string, but <{X}modified> has range xsd:dateTime, and \"2026-09-03\"^^xsd:string is not a value of xsd:dateTime, so the ontology is inconsistent; Erden's proof checker cannot certify this kind of inconsistency yet, so reasoning is refused"
                    )
                ),
            ]
        );
    }

    #[test]
    fn an_ill_typed_literal_is_refused_naming_its_assertion() {
        let axioms = vec![axiom(
            "d1",
            json!({"kind": "DataPropertyAssertion", "property": iri("count"), "subject": iri("i"), "value": integer("many")}),
        )];
        let diagnostics =
            refusal_diagnostics(&reason(&request_with(axioms), std::time::Instant::now()));
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].0, vec!["d1".to_owned()]);
        assert!(
            diagnostics[0].1.starts_with(&format!(
                "<{X}i> <{X}count> \"many\"^^xsd:integer, but \"many\"^^xsd:integer is not a valid value of its datatype xsd:integer, so the ontology is inconsistent"
            )),
            "{}",
            diagnostics[0].1
        );
    }

    #[test]
    fn a_literal_reaching_a_range_through_a_sub_property_names_the_sub_property_axiom() {
        // A sub-property puts the request beyond V1, so the Horn saturation decides it.
        let axioms = vec![
            axiom(
                "s1",
                json!({"kind": "SubDataPropertyOf", "subProperty": iri("shoeSize"), "superProperty": iri("size")}),
            ),
            axiom(
                "r1",
                json!({"kind": "PropertyRange", "property": iri("size"), "propertyKind": "DataProperty", "range": "http://www.w3.org/2001/XMLSchema#integer"}),
            ),
            axiom(
                "d1",
                json!({"kind": "DataPropertyAssertion", "property": iri("shoeSize"), "subject": iri("a"), "value": string("large")}),
            ),
        ];
        let diagnostics =
            refusal_diagnostics(&reason(&request_with(axioms), std::time::Instant::now()));
        assert_eq!(
            diagnostics,
            vec![(
                vec!["d1".to_owned(), "r1".to_owned(), "s1".to_owned()],
                format!(
                    "<{X}a> <{X}shoeSize> \"large\"^^xsd:string, so it has that value for <{X}size> too, of which <{X}shoeSize> is a sub-property, but <{X}size> has range xsd:integer, and \"large\"^^xsd:string is not a value of xsd:integer, so the ontology is inconsistent; Erden's proof checker cannot certify this kind of inconsistency yet, so reasoning is refused"
                )
            )]
        );
    }

    #[test]
    fn an_individual_asserted_in_disjoint_classes_is_decided_inconsistent() {
        let axioms = vec![
            axiom(
                "a1",
                json!({"classes": [class("A"), class("B")], "kind": "DisjointClasses"}),
            ),
            axiom(
                "a2",
                json!({"classExpression": class("A"), "individual": iri("i"), "kind": "ClassAssertion"}),
            ),
            axiom(
                "a3",
                json!({"classExpression": class("B"), "individual": iri("i"), "kind": "ClassAssertion"}),
            ),
        ];
        let result = reason(&request_with(axioms), std::time::Instant::now());
        assert_eq!(result["outcome"], "decided");
        assert_eq!(result["consistency"], "inconsistent");
        assert_eq!(
            result["diagnostics"][0]["axiomIds"],
            json!(["a1", "a2", "a3"])
        );
    }

    #[test]
    fn the_indexed_disjointness_scan_finds_the_pairwise_scans_first_witness() {
        fn pairwise(axioms: &[Value]) -> Option<Value> {
            for disjoint in axioms
                .iter()
                .filter(|axiom| axiom["kind"] == "DisjointClasses")
            {
                let classes: BTreeSet<_> = disjoint["classes"]
                    .as_array()?
                    .iter()
                    .filter_map(|class| class["iri"].as_str())
                    .collect();
                let assertions = || {
                    axioms
                        .iter()
                        .filter(|axiom| axiom["kind"] == "ClassAssertion")
                };
                for left in assertions() {
                    for right in assertions() {
                        if left["id"] == right["id"] || left["individual"] != right["individual"] {
                            continue;
                        }
                        let (l, r) = (
                            left["classExpression"]["iri"].as_str()?,
                            right["classExpression"]["iri"].as_str()?,
                        );
                        if classes.contains(l) && classes.contains(r) && l != r {
                            let mut ids = vec![
                                disjoint["id"].as_str()?.to_owned(),
                                left["id"].as_str()?.to_owned(),
                                right["id"].as_str()?.to_owned(),
                            ];
                            sort_dedup_utf16(&mut ids);
                            return Some(json!(ids));
                        }
                    }
                }
            }
            None
        }
        let mut axioms = vec![
            axiom(
                "d2",
                json!({"classes": [class("C"), class("D")], "kind": "DisjointClasses"}),
            ),
            axiom(
                "d1",
                json!({"classes": [class("A"), class("B"), class("C")], "kind": "DisjointClasses"}),
            ),
        ];
        for (id, individual, class_name) in [
            ("c9", "k", "D"),
            ("c1", "i", "A"),
            ("c5", "j", "C"),
            ("c2", "j", "B"),
            ("c7", "k", "C"),
            ("c3", "i", "A"),
            ("c4", "i", "C"),
        ] {
            axioms.push(axiom(id, json!({"classExpression": class(class_name), "individual": iri(individual), "kind": "ClassAssertion"})));
        }
        for rotation in 0..axioms.len() {
            let mut rotated = axioms.clone();
            rotated.rotate_left(rotation);
            assert_eq!(
                direct_inconsistency(&rotated).map(|diagnostic| diagnostic["axiomIds"].clone()),
                pairwise(&rotated),
                "rotation {rotation}"
            );
        }
    }
}
