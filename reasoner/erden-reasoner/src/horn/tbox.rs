//! The request's axioms, read once into the indexes the saturation looks rules up in.
//!
//! Every index entry keeps the position of the axiom it comes from, so each step can cite it. The
//! property hierarchies keep, for every pair `R ⊑* S`, one path of axioms that shows it: the proof
//! checker accepts a step only if the cited axioms connect the two properties the same way.

use super::model::{Expr, ExprId, Model, OWL_NOTHING, OWL_THING, PropId, Sym};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

/// An axiom's position in the request.
pub(crate) type AxiomIx = u32;

/// One path of axioms from a property to each property it reaches (`R ⊑* S`), found breadth first.
pub(crate) struct Reach {
    /// The properties reached, the start first, in the order found.
    pub(crate) order: Vec<u32>,
    /// For each reached property but the start: the property it was reached from, and the axiom.
    parent: HashMap<u32, (u32, AxiomIx)>,
}

impl Reach {
    fn new(start: u32, edges: &[Vec<(u32, AxiomIx)>]) -> Self {
        let mut order = vec![start];
        let mut parent = HashMap::new();
        let mut queue = VecDeque::from([start]);
        while let Some(next) = queue.pop_front() {
            for &(to, axiom) in &edges[next as usize] {
                if to != start && !parent.contains_key(&to) {
                    parent.insert(to, (next, axiom));
                    order.push(to);
                    queue.push_back(to);
                }
            }
        }
        Self { order, parent }
    }

    pub(crate) fn reaches(&self, to: u32) -> bool {
        to == self.order[0] || self.parent.contains_key(&to)
    }

    /// The axioms of the path to `to`; empty for the start itself.
    pub(crate) fn path(&self, to: u32, out: &mut Vec<AxiomIx>) {
        let mut at = to;
        while let Some(&(from, axiom)) = self.parent.get(&at) {
            out.push(axiom);
            at = from;
        }
    }
}

/// A sub-property graph with the reach of every node computed once.
pub(crate) struct Hierarchy {
    reach: Vec<Reach>,
}

impl Hierarchy {
    fn new(edges: &[Vec<(u32, AxiomIx)>]) -> Self {
        Self {
            reach: (0..edges.len() as u32)
                .map(|start| Reach::new(start, edges))
                .collect(),
        }
    }

    pub(crate) fn sub(&self, from: u32, to: u32) -> bool {
        self.reach[from as usize].reaches(to)
    }

    pub(crate) fn supers(&self, from: u32) -> &[u32] {
        &self.reach[from as usize].order
    }

    pub(crate) fn path(&self, from: u32, to: u32, out: &mut Vec<AxiomIx>) {
        self.reach[from as usize].path(to, out);
    }
}

/// An individual's assertions.
pub(crate) struct ClassAssertion {
    pub(crate) axiom: AxiomIx,
    pub(crate) individual: Sym,
    pub(crate) expression: ExprId,
}

pub(crate) struct EdgeAssertion {
    pub(crate) axiom: AxiomIx,
    pub(crate) subject: Sym,
    pub(crate) property: Sym,
    pub(crate) object: Sym,
}

/// `SubObjectPropertyOf(ObjectPropertyChain(P₁ … Pₙ), S)`, or its inverse
/// `SubObjectPropertyOf(ObjectPropertyChain(Pₙ⁻ … P₁⁻), S⁻)`.
pub(crate) struct Chain {
    pub(crate) axiom: AxiomIx,
    pub(crate) properties: Vec<PropId>,
    pub(crate) target: PropId,
}

/// What a union domain is the domain of.
#[derive(Clone, Copy)]
pub(crate) enum UnionTarget {
    /// An object property `S`, by `∃S.⊤`, which marks an element with an `S`-successor.
    Object(ExprId),
    /// A data property (index into `data_props`).
    Data(u32),
}

/// `PropertyDomain(S, A₁ ⊔ … ⊔ Aₙ)`: decided by case analysis.
pub(crate) struct UnionDomain {
    pub(crate) axiom: AxiomIx,
    pub(crate) target: UnionTarget,
    pub(crate) operands: Vec<ExprId>,
}

pub(crate) struct DataAssertion {
    pub(crate) axiom: AxiomIx,
    pub(crate) subject: Sym,
    pub(crate) property: Sym,
    pub(crate) value: Value,
}

#[derive(Default)]
pub(crate) struct Tbox {
    pub(crate) model: Model,
    pub(crate) axiom_ids: Vec<String>,
    /// `SubClassOf(D, E)` and two members of `EquivalentClasses`, by `D`: the axiom and `E`.
    pub(crate) told: HashMap<ExprId, Vec<(AxiomIx, ExprId)>>,
    /// A named `SubClassOf(A, B)` is a fact of context `A` on its own (as V1 lists it, asserted).
    pub(crate) named_told: HashMap<(ExprId, ExprId), AxiomIx>,
    /// Intersections in a negative position, by each operand.
    pub(crate) neg_inter: HashMap<ExprId, Vec<ExprId>>,
    /// Unions in a negative position, by each named operand.
    pub(crate) neg_union: HashMap<ExprId, Vec<ExprId>>,
    /// Existentials in a negative position, by filler: the property and the existential.
    pub(crate) neg_exists: HashMap<ExprId, Vec<(PropId, ExprId)>>,
    /// For a negative `∃S.G` and a transitive `T ⊑* S`: by `G`, the transitivity axiom, `T` and
    /// `∃T.G`, which `transitive-exists` carries along chains of `T`-successors (and which is
    /// itself indexed as negative, so a direct successor in `G` introduces it).
    pub(crate) transitive_exists: HashMap<ExprId, Vec<(AxiomIx, PropId, ExprId)>>,
    /// The fillers of a maximum cardinality anywhere: a successor reaching one may now count.
    pub(crate) limit_fillers: HashMap<ExprId, ()>,
    /// `DisjointClasses` axioms, by member: the axiom and its members.
    pub(crate) disjoint: HashMap<ExprId, Vec<(AxiomIx, Vec<ExprId>)>>,
    /// `¬C` for every complement in the ontology, by `C`.
    pub(crate) complement: HashMap<ExprId, ExprId>,
    /// Universal restrictions that hold of every element, by property: `PropertyRange(S, F)` is
    /// `∀S.F`, `PropertyDomain(S, F)` is `∀S⁻.F`.
    pub(crate) universals: HashMap<PropId, Vec<(AxiomIx, ExprId)>>,
    /// Functionality that holds of every element, by property: `FunctionalObjectProperty(S)` is
    /// `≤1 S.⊤`, `InverseFunctionalObjectProperty(S)` is `≤1 S⁻.⊤`.
    pub(crate) functional: HashMap<PropId, Vec<AxiomIx>>,
    /// `TransitiveObjectProperty(q)`: the axiom and `q`.
    pub(crate) transitive: Vec<(AxiomIx, PropId)>,
    /// Every property a maximum cardinality or a (inverse-)functionality limits, with its axiom: OWL 2 DL
    /// requires each to be simple.
    pub(crate) limited: Vec<(AxiomIx, PropId)>,
    pub(crate) props: Option<Hierarchy>,
    /// The inverse of every property expression.
    pub(crate) inverse: Vec<PropId>,
    /// Data property hierarchy over interned IRIs (indexes into `data_props`).
    pub(crate) data: Option<Hierarchy>,
    pub(crate) data_props: Vec<Sym>,
    pub(crate) data_index: HashMap<Sym, u32>,
    pub(crate) data_domains: HashMap<u32, Vec<(AxiomIx, ExprId)>>,
    pub(crate) functional_data: Vec<(AxiomIx, u32)>,
    /// The named classes the answer classifies, without `owl:Thing` and `owl:Nothing`.
    pub(crate) classes: Vec<Sym>,
    /// Every named individual, in the order first seen.
    pub(crate) individuals: Vec<Sym>,
    pub(crate) class_assertions: Vec<ClassAssertion>,
    pub(crate) edges: Vec<EdgeAssertion>,
    pub(crate) data_assertions: Vec<DataAssertion>,
    pub(crate) union_domains: Vec<UnionDomain>,
    pub(crate) chains: Vec<Chain>,
    /// Whether any maximum cardinality or functionality is in the ontology.
    pub(crate) has_limits: bool,
    /// Axioms the saturation does not decide yet: refused with this diagnostic code.
    pub(crate) unsupported: Vec<(AxiomIx, &'static str)>,
    pub(crate) thing: ExprId,
    pub(crate) nothing: ExprId,
}

fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("axiom field {name} missing"))
}

impl Tbox {
    pub(crate) fn props(&self) -> &Hierarchy {
        self.props.as_ref().expect("built")
    }

    pub(crate) fn data(&self) -> &Hierarchy {
        self.data.as_ref().expect("built")
    }

    fn data_prop(&mut self, iri: &str) -> u32 {
        let sym = self.model.iri(iri);
        if let Some(&index) = self.data_index.get(&sym) {
            return index;
        }
        let index = self.data_props.len() as u32;
        self.data_props.push(sym);
        self.data_index.insert(sym, index);
        index
    }

    fn class(&mut self, sym: Sym, seen: &mut HashMap<Sym, ()>) {
        if seen.insert(sym, ()).is_none() {
            self.classes.push(sym);
        }
    }

    fn individual(&mut self, iri: &str, seen: &mut HashMap<Sym, ()>) -> Sym {
        let sym = self.model.iri(iri);
        if seen.insert(sym, ()).is_none() {
            self.individuals.push(sym);
        }
        sym
    }

    /// Indexes an expression and its parts at a polarity: negative ones may be introduced.
    fn polarity(&mut self, expression: ExprId, positive: bool) {
        match self.model.expr(expression).clone() {
            Expr::Named(_) => {}
            Expr::Union(operands) => {
                if !positive {
                    for operand in operands {
                        let named = self.model.intern(Expr::Named(operand));
                        push_unique(self.neg_union.entry(named).or_default(), expression);
                    }
                }
            }
            Expr::Inter(operands) => {
                for &operand in &operands {
                    self.polarity(operand, positive);
                    if !positive {
                        push_unique(self.neg_inter.entry(operand).or_default(), expression);
                    }
                }
            }
            Expr::Some(prop, filler) => {
                self.polarity(filler, positive);
                if !positive {
                    let entry = self.neg_exists.entry(filler).or_default();
                    if !entry.iter().any(|(_, item)| *item == expression) {
                        entry.push((prop, expression));
                    }
                }
            }
            Expr::All(_, filler) => self.polarity(filler, true),
            Expr::Max(_, _, filler) => {
                self.has_limits = true;
                self.limit_fillers.insert(filler, ());
                self.polarity(filler, false);
            }
            Expr::Not(operand) => {
                self.complement.insert(operand, expression);
                self.polarity(operand, false);
            }
        }
    }

    fn named_classes(&mut self, expression: ExprId, seen: &mut HashMap<Sym, ()>) {
        match self.model.expr(expression).clone() {
            Expr::Named(sym) => self.class(sym, seen),
            Expr::Union(operands) => operands.into_iter().for_each(|sym| self.class(sym, seen)),
            Expr::Inter(operands) => operands
                .into_iter()
                .for_each(|operand| self.named_classes(operand, seen)),
            Expr::Some(_, filler) | Expr::All(_, filler) | Expr::Max(_, _, filler) => {
                self.named_classes(filler, seen);
            }
            Expr::Not(operand) => self.named_classes(operand, seen),
        }
    }

    /// Reads every axiom of a request that passed preflight.
    pub(crate) fn read(axioms: &[Value]) -> Result<Self, String> {
        let mut tbox = Self::default();
        tbox.thing = tbox.model.named(OWL_THING);
        tbox.nothing = tbox.model.named(OWL_NOTHING);
        let mut prop_edges: Vec<(PropId, PropId, AxiomIx)> = Vec::new();
        let mut data_edges: Vec<(u32, u32, AxiomIx)> = Vec::new();
        let mut class_seen = HashMap::new();
        let mut individual_seen = HashMap::new();
        for (position, axiom) in axioms.iter().enumerate() {
            let ix = position as AxiomIx;
            tbox.axiom_ids.push(text(axiom, "id")?.to_owned());
            let kind = text(axiom, "kind")?;
            let mut expressions: Vec<(ExprId, bool, bool)> = Vec::new();
            match kind {
                "Declaration" => match text(axiom, "entityKind")? {
                    "Class" => {
                        let sym = tbox.model.iri(text(axiom, "iri")?);
                        tbox.class(sym, &mut class_seen);
                    }
                    "NamedIndividual" => {
                        tbox.individual(text(axiom, "iri")?, &mut individual_seen);
                    }
                    "DataProperty" => {
                        tbox.data_prop(text(axiom, "iri")?);
                    }
                    "ObjectProperty" => {
                        let sym = tbox.model.iri(text(axiom, "iri")?);
                        tbox.model.prop(sym, false);
                    }
                    _ => {}
                },
                "SubClassOf" => {
                    let sub = tbox.model.parse(&axiom["subClass"])?;
                    let sup = tbox.model.parse(&axiom["superClass"])?;
                    tbox.told.entry(sub).or_default().push((ix, sup));
                    if matches!(tbox.model.expr(sub), Expr::Named(_))
                        && matches!(tbox.model.expr(sup), Expr::Named(_))
                    {
                        tbox.named_told.entry((sub, sup)).or_insert(ix);
                    }
                    expressions.push((sub, false, true));
                    expressions.push((sup, true, false));
                }
                "EquivalentClasses" | "DisjointClasses" => {
                    let mut members = Vec::new();
                    for class in axiom["classes"].as_array().ok_or("classes")? {
                        members.push(tbox.model.parse(class)?);
                    }
                    if kind == "EquivalentClasses" {
                        for &left in &members {
                            for &right in &members {
                                if left != right {
                                    tbox.told.entry(left).or_default().push((ix, right));
                                }
                            }
                            expressions.push((left, true, true));
                        }
                    } else {
                        for &member in &members {
                            tbox.disjoint
                                .entry(member)
                                .or_default()
                                .push((ix, members.clone()));
                            expressions.push((member, false, true));
                        }
                    }
                }
                "ClassAssertion" => {
                    let individual =
                        tbox.individual(text(axiom, "individual")?, &mut individual_seen);
                    let expression = tbox.model.parse(&axiom["classExpression"])?;
                    tbox.class_assertions.push(ClassAssertion {
                        axiom: ix,
                        individual,
                        expression,
                    });
                    expressions.push((expression, true, false));
                }
                "PropertyDomain" | "PropertyRange" => {
                    let property = text(axiom, "property")?;
                    let property_kind = text(axiom, "propertyKind")?;
                    let value = if kind == "PropertyDomain" {
                        &axiom["domain"]
                    } else {
                        &axiom["range"]
                    };
                    match property_kind {
                        "ObjectProperty" => {
                            let filler = match value.as_str() {
                                Some(iri) => tbox.model.named(iri),
                                None => tbox.model.parse(value)?,
                            };
                            if let Expr::Union(operands) = tbox.model.expr(filler).clone() {
                                let sym = tbox.model.iri(property);
                                let prop = tbox.model.prop(sym, false);
                                let thing = tbox.thing;
                                let witness = tbox.model.intern(Expr::Some(prop, thing));
                                let negative = tbox.neg_exists.entry(thing).or_default();
                                if !negative.iter().any(|item| item.1 == witness) {
                                    negative.push((prop, witness));
                                }
                                let operands = operands
                                    .into_iter()
                                    .map(|operand| tbox.model.intern(Expr::Named(operand)))
                                    .collect();
                                tbox.union_domains.push(UnionDomain {
                                    axiom: ix,
                                    target: UnionTarget::Object(witness),
                                    operands,
                                });
                                expressions.push((filler, false, true));
                            } else {
                                let sym = tbox.model.iri(property);
                                let prop = tbox.model.prop(sym, kind == "PropertyDomain");
                                tbox.universals.entry(prop).or_default().push((ix, filler));
                                expressions.push((filler, true, false));
                            }
                        }
                        "DataProperty" if kind == "PropertyDomain" => {
                            let filler = tbox.model.parse(value)?;
                            if let Expr::Union(operands) = tbox.model.expr(filler).clone() {
                                let data = tbox.data_prop(property);
                                let operands = operands
                                    .into_iter()
                                    .map(|operand| tbox.model.intern(Expr::Named(operand)))
                                    .collect();
                                tbox.union_domains.push(UnionDomain {
                                    axiom: ix,
                                    target: UnionTarget::Data(data),
                                    operands,
                                });
                                expressions.push((filler, false, true));
                            } else {
                                let data = tbox.data_prop(property);
                                tbox.data_domains
                                    .entry(data)
                                    .or_default()
                                    .push((ix, filler));
                                expressions.push((filler, true, false));
                            }
                        }
                        "DataProperty" => {
                            tbox.data_prop(property);
                        }
                        _ => {}
                    }
                }
                "InverseObjectProperties" => {
                    let left = tbox.model.iri(text(axiom, "left")?);
                    let right = tbox.model.iri(text(axiom, "right")?);
                    let (l, r) = (tbox.model.prop(left, false), tbox.model.prop(right, false));
                    let (li, ri) = (tbox.model.prop(left, true), tbox.model.prop(right, true));
                    prop_edges.extend([(l, ri, ix), (r, li, ix)]);
                }
                "SymmetricObjectProperty" => {
                    let sym = tbox.model.iri(text(axiom, "property")?);
                    let (p, pi) = (tbox.model.prop(sym, false), tbox.model.prop(sym, true));
                    prop_edges.push((p, pi, ix));
                }
                "TransitiveObjectProperty" => {
                    let sym = tbox.model.iri(text(axiom, "property")?);
                    let prop = tbox.model.prop(sym, false);
                    tbox.model.prop(sym, true);
                    tbox.transitive.push((ix, prop));
                }
                "SubObjectPropertyOf" => {
                    let sub = &axiom["subProperty"];
                    if sub.get("kind").and_then(Value::as_str) == Some("ObjectPropertyChain") {
                        let mut properties = Vec::new();
                        for property in sub["properties"].as_array().ok_or("chain")? {
                            properties.push(tbox.model.parse_prop(property)?);
                        }
                        let target = tbox.model.parse_prop(&axiom["superProperty"])?;
                        tbox.chains.push(Chain {
                            axiom: ix,
                            properties,
                            target,
                        });
                    } else {
                        let from = tbox.model.parse_prop(sub)?;
                        let to = tbox.model.parse_prop(&axiom["superProperty"])?;
                        prop_edges.push((from, to, ix));
                    }
                }
                "EquivalentObjectProperties" => {
                    let mut properties = Vec::new();
                    for property in axiom["properties"].as_array().ok_or("properties")? {
                        properties.push(tbox.model.parse_prop(property)?);
                    }
                    for &left in &properties {
                        for &right in &properties {
                            if left != right {
                                prop_edges.push((left, right, ix));
                            }
                        }
                    }
                }
                "FunctionalObjectProperty" | "InverseFunctionalObjectProperty" => {
                    let mut prop = tbox.model.parse_prop(&axiom["property"])?;
                    if kind == "InverseFunctionalObjectProperty" {
                        prop = tbox.model.inverse(prop);
                    }
                    tbox.functional.entry(prop).or_default().push(ix);
                    tbox.limited.push((ix, prop));
                    tbox.has_limits = true;
                }
                "SubDataPropertyOf" => {
                    let from = tbox.data_prop(text(axiom, "subProperty")?);
                    let to = tbox.data_prop(text(axiom, "superProperty")?);
                    data_edges.push((from, to, ix));
                }
                "EquivalentDataProperties" => {
                    let mut properties = Vec::new();
                    for property in axiom["properties"].as_array().ok_or("properties")? {
                        properties.push(tbox.data_prop(property.as_str().ok_or("property")?));
                    }
                    for &left in &properties {
                        for &right in &properties {
                            if left != right {
                                data_edges.push((left, right, ix));
                            }
                        }
                    }
                }
                "FunctionalDataProperty" => {
                    let data = tbox.data_prop(text(axiom, "property")?);
                    tbox.functional_data.push((ix, data));
                }
                "ObjectPropertyAssertion" => {
                    let subject = tbox.individual(text(axiom, "subject")?, &mut individual_seen);
                    let object = tbox.individual(text(axiom, "object")?, &mut individual_seen);
                    let property = tbox.model.iri(text(axiom, "property")?);
                    tbox.model.prop(property, false);
                    tbox.edges.push(EdgeAssertion {
                        axiom: ix,
                        subject,
                        property,
                        object,
                    });
                }
                "DataPropertyAssertion" => {
                    let subject = tbox.individual(text(axiom, "subject")?, &mut individual_seen);
                    let property = text(axiom, "property")?;
                    tbox.data_prop(property);
                    let property = tbox.model.iri(property);
                    tbox.data_assertions.push(DataAssertion {
                        axiom: ix,
                        subject,
                        property,
                        value: axiom["value"].clone(),
                    });
                }
                _ => {}
            }
            for (expression, positive, negative) in expressions {
                let mut limited = Vec::new();
                tbox.max_props(expression, &mut limited);
                tbox.limited
                    .extend(limited.into_iter().map(|prop| (ix, prop)));
                tbox.named_classes(expression, &mut class_seen);
                if positive {
                    tbox.polarity(expression, true);
                }
                if negative {
                    tbox.polarity(expression, false);
                }
            }
        }
        // Every property's inverse, so the property set is closed and fixed from here on.
        for prop in 0..tbox.model.prop_count() as PropId {
            tbox.model.inverse(prop);
        }
        let count = tbox.model.prop_count();
        tbox.inverse = (0..count as PropId)
            .map(|prop| {
                let (sym, inverse) = tbox.model.prop_parts(prop);
                tbox.model
                    .find_prop(sym, !inverse)
                    .expect("inverses interned")
            })
            .collect();
        let mut adjacency: Vec<Vec<(u32, AxiomIx)>> = vec![Vec::new(); count];
        for (from, to, ix) in prop_edges {
            adjacency[from as usize].push((to, ix));
            let (from_inverse, to_inverse) =
                (tbox.inverse[from as usize], tbox.inverse[to as usize]);
            adjacency[from_inverse as usize].push((to_inverse, ix));
        }
        tbox.props = Some(Hierarchy::new(&adjacency));
        let mut data_adjacency: Vec<Vec<(u32, AxiomIx)>> = vec![Vec::new(); tbox.data_props.len()];
        for (from, to, ix) in data_edges {
            data_adjacency[from as usize].push((to, ix));
        }
        tbox.data = Some(Hierarchy::new(&data_adjacency));
        // Each chain's inverse, so paths are followed in either direction.
        let inverses: Vec<Chain> = tbox
            .chains
            .iter()
            .map(|chain| Chain {
                axiom: chain.axiom,
                properties: chain
                    .properties
                    .iter()
                    .rev()
                    .map(|&prop| tbox.inv(prop))
                    .collect(),
                target: tbox.inv(chain.target),
            })
            .collect();
        tbox.chains.extend(inverses);
        if let Some(axiom) = tbox.irregular_chain() {
            tbox.unsupported
                .push((axiom, "non-regular-property-hierarchy"));
        }
        if let Some(axiom) = tbox.non_simple_limit() {
            tbox.unsupported
                .push((axiom, "non-simple-property-in-cardinality"));
        }
        if !tbox.transitive.is_empty() {
            let mut fillers: Vec<ExprId> = tbox.neg_exists.keys().copied().collect();
            fillers.sort_unstable();
            for filler in fillers {
                let existing = tbox.neg_exists[&filler].clone();
                for (target, _) in existing {
                    for (axiom, transitive) in tbox.transitive.clone() {
                        for through in [transitive, tbox.inv(transitive)] {
                            if !tbox.props().sub(through, target) {
                                continue;
                            }
                            let existential = tbox.model.intern(Expr::Some(through, filler));
                            let entry = tbox.transitive_exists.entry(filler).or_default();
                            if !entry.iter().any(|item| item.1 == through) {
                                entry.push((axiom, through, existential));
                            }
                            let negative = tbox.neg_exists.entry(filler).or_default();
                            if !negative.iter().any(|item| item.1 == existential) {
                                negative.push((through, existential));
                            }
                        }
                    }
                }
            }
        }
        let (thing, nothing) = (tbox.model.iri(OWL_THING), tbox.model.iri(OWL_NOTHING));
        tbox.classes.retain(|sym| *sym != thing && *sym != nothing);
        Ok(tbox)
    }

    /// A chain axiom that makes the property hierarchy non-regular (OWL 2 Structural Specification,
    /// section 11.2): a property in a chain's body that depends back on the chain's target, other
    /// than the target itself at the start or end of the chain.
    fn irregular_chain(&self) -> Option<AxiomIx> {
        let count = self.inverse.len();
        let mut edges: Vec<Vec<u32>> = vec![Vec::new(); count];
        let props = self.props();
        for from in 0..count as u32 {
            edges[from as usize]
                .extend(props.supers(from).iter().copied().filter(|&to| to != from));
        }
        let mut chain_edges = Vec::new();
        for chain in &self.chains {
            let last = chain.properties.len() - 1;
            for (position, &prop) in chain.properties.iter().enumerate() {
                // The target itself may open or close its own chain (`S ∘ R ⊑ S`, `R ∘ S ⊑ S`).
                if prop == chain.target && (position == 0 || position == last) {
                    continue;
                }
                if prop == chain.target || prop == self.inv(chain.target) {
                    return Some(chain.axiom);
                }
                edges[prop as usize].push(chain.target);
                chain_edges.push((prop, chain.target, chain.axiom));
            }
        }
        for (from, to, axiom) in chain_edges {
            // A cycle through this dependency: `to` reaches `from` back.
            let mut seen = vec![false; count];
            let mut pending = vec![to];
            while let Some(next) = pending.pop() {
                if next == from {
                    return Some(axiom);
                }
                if std::mem::replace(&mut seen[next as usize], true) {
                    continue;
                }
                pending.extend(edges[next as usize].iter().copied());
            }
        }
        None
    }

    /// The properties every maximum cardinality inside `expression` limits.
    fn max_props(&self, expression: ExprId, found: &mut Vec<PropId>) {
        match self.model.expr(expression) {
            Expr::Named(_) | Expr::Union(_) => {}
            Expr::Inter(operands) => {
                for &operand in operands {
                    self.max_props(operand, found);
                }
            }
            Expr::Some(_, filler) | Expr::All(_, filler) => self.max_props(*filler, found),
            Expr::Max(_, prop, filler) => {
                found.push(*prop);
                self.max_props(*filler, found);
            }
            Expr::Not(operand) => self.max_props(*operand, found),
        }
    }

    /// The first cardinality axiom over a property that is not simple (OWL 2 Structural Specification,
    /// section 11.2): one a transitive property or a property chain's target is below, either way
    /// round. The Horn calculus, like OWL 2 DL, decides counting only over simple properties.
    fn non_simple_limit(&self) -> Option<AxiomIx> {
        let mut composite: Vec<PropId> = Vec::new();
        for &(_, transitive) in &self.transitive {
            composite.push(transitive);
            composite.push(self.inv(transitive));
        }
        composite.extend(self.chains.iter().map(|chain| chain.target));
        if composite.is_empty() {
            return None;
        }
        let props = self.props();
        let mut limited = self.limited.clone();
        limited.sort_unstable();
        limited
            .into_iter()
            .find(|&(_, prop)| composite.iter().any(|&c| props.sub(c, prop)))
            .map(|(axiom, _)| axiom)
    }

    pub(crate) fn inv(&self, prop: PropId) -> PropId {
        self.inverse[prop as usize]
    }

    pub(crate) fn id(&self, axiom: AxiomIx) -> &str {
        &self.axiom_ids[axiom as usize]
    }
}

fn push_unique(items: &mut Vec<ExprId>, item: ExprId) {
    if !items.contains(&item) {
        items.push(item);
    }
}
