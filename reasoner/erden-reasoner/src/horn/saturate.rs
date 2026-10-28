//! The Horn saturation: every conclusion about every context and individual, each recorded with
//! the rule and premises that give it, so the answer's proofs are read off and never derived again.
//!
//! A node is a context (a set of class expressions, read as their intersection) or a named
//! individual. A link `X -R-> K` is a fact `X ⊑ ∃R.K` whose filler `K` is a context: the anonymous
//! element the existential asks for. Facts are processed in first-in, first-out order; the rules
//! that look at a node and all of its successors at once (refinement, functionality) run on a node
//! when nothing else is pending, so they see as much as is known and add one larger context instead
//! of many small ones. Every collection that is iterated is a vector in insertion order, so a
//! request is always saturated the same way: hash maps are only looked up.

use super::literal::comparable_value;
use super::model::{Expr, ExprId, Model, PropId, Sym};
use super::tbox::{AxiomIx, Tbox};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

pub(crate) type NodeId = u32;
pub(crate) type StepId = u32;
pub(crate) type LinkId = u32;

/// A cited premise: an axiom of the request, or an earlier step.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Prem {
    Axiom(AxiomIx),
    Step(StepId),
}

/// Why a fact holds: an axiom or a step, or nothing to cite (`owl:Thing`, and a context's own parts).
pub(crate) type Why = Option<Prem>;

#[derive(Clone, Debug)]
pub(crate) enum Conclusion {
    Class(NodeId, ExprId),
    /// A property assertion between individuals: subject, property IRI, object.
    Edge(Sym, Sym, Sym),
    Same(NodeId, NodeId),
    /// A data property assertion: subject, data property (index), literal (index).
    Data(NodeId, u32, u32),
}

pub(crate) struct Step {
    pub(crate) rule: &'static str,
    pub(crate) premises: Vec<Prem>,
    pub(crate) conclusion: Conclusion,
}

pub(crate) enum NodeKind {
    Context {
        expression: ExprId,
        parts: Vec<ExprId>,
    },
    Individual(Sym),
}

pub(crate) struct Node {
    pub(crate) kind: NodeKind,
    pub(crate) facts: HashMap<ExprId, Why>,
    pub(crate) order: Vec<ExprId>,
    alls: Vec<ExprId>,
    maxes: Vec<ExprId>,
    out: Vec<LinkId>,
    inc: Vec<LinkId>,
    /// An individual's named neighbours, in both directions: the property from this individual to
    /// the neighbour (inverse for an incoming edge), the neighbour and the edge.
    named: Vec<(PropId, NodeId, Prem)>,
    /// Individuals this one is the same as, and the individuals the same as this one.
    same: Vec<(NodeId, Prem)>,
    same_in: Vec<(NodeId, Prem)>,
    data: Vec<(u32, u32, Prem)>,
    refine_dirty: bool,
    merge_dirty: bool,
}

impl Node {
    fn new(kind: NodeKind) -> Self {
        Self {
            kind,
            facts: HashMap::new(),
            order: Vec::new(),
            alls: Vec::new(),
            maxes: Vec::new(),
            out: Vec::new(),
            inc: Vec::new(),
            named: Vec::new(),
            same: Vec::new(),
            same_in: Vec::new(),
            data: Vec::new(),
            refine_dirty: false,
            merge_dirty: false,
        }
    }

    pub(crate) fn parts(&self) -> &[ExprId] {
        match &self.kind {
            NodeKind::Context { parts, .. } => parts,
            NodeKind::Individual(_) => &[],
        }
    }

    pub(crate) fn out_links(&self) -> &[LinkId] {
        &self.out
    }

    pub(crate) fn named_neighbours(&self) -> &[(PropId, NodeId, Prem)] {
        &self.named
    }

    pub(crate) fn universal_facts(&self) -> &[ExprId] {
        &self.alls
    }

    pub(crate) fn data_facts(&self) -> &[(u32, u32, Prem)] {
        &self.data
    }

    pub(crate) fn why(&self, expression: ExprId) -> Why {
        self.facts.get(&expression).copied().flatten()
    }
}

pub(crate) struct Link {
    pub(crate) from: NodeId,
    pub(crate) prop: PropId,
    pub(crate) to: NodeId,
    pub(crate) why: Why,
    superseded: bool,
}

impl Link {
    pub(crate) fn is_superseded(&self) -> bool {
        self.superseded
    }
}

enum Event {
    Fact(NodeId, ExprId, bool),
    Link(LinkId),
    Edge(Sym, Sym, Sym, Prem),
    Same(NodeId, NodeId, Prem),
    Data(NodeId, u32, u32, Prem),
}

/// How the ontology was shown inconsistent.
pub(crate) enum Inconsistency {
    /// A proved `a ⊑ owl:Nothing` or `owl:Thing ⊑ owl:Nothing`.
    Nothing(NodeId),
    /// Two literals of one individual under a functional data property, with different values.
    DataClash(Vec<Prem>),
}

/// Why the saturation stopped without an answer.
pub(crate) enum Stop {
    /// The wall-time budget ran out.
    Budget,
    /// A union domain's case analysis would have to spread to a neighbour: the axiom and element.
    NotLocal(AxiomIx, NodeId),
    /// More union-domain cases than the proof checker accepts.
    TooManyCases,
    /// Property chains need more path steps than one request may take.
    ChainBudget,
}

pub(crate) struct Saturation<'t> {
    pub(crate) idx: &'t Tbox,
    pub(crate) model: Model,
    pub(crate) nodes: Vec<Node>,
    contexts: HashMap<ExprId, NodeId>,
    pub(crate) individuals: HashMap<Sym, NodeId>,
    pub(crate) links: Vec<Link>,
    link_index: HashMap<(NodeId, PropId, NodeId), LinkId>,
    pub(crate) steps: Vec<Step>,
    pub(crate) edges: HashMap<(Sym, Sym, Sym), Prem>,
    pub(crate) edge_order: Vec<(Sym, Sym, Sym)>,
    pub(crate) sames: HashMap<(NodeId, NodeId), Prem>,
    pub(crate) same_order: Vec<(NodeId, NodeId)>,
    pub(crate) literals: Vec<Value>,
    literal_index: HashMap<String, u32>,
    pub(crate) data: HashMap<(NodeId, u32, u32), Prem>,
    pub(crate) data_order: Vec<(NodeId, u32, u32)>,
    queue: VecDeque<Event>,
    refine_queue: VecDeque<NodeId>,
    merge_queue: VecDeque<NodeId>,
    /// Whether some negative existential's property is above the inverse of each property.
    inverse_relevant: Vec<bool>,
    pub(crate) inconsistency: Option<Inconsistency>,
    /// Pairs of literals of one individual under a functional data property whose values the
    /// checker cannot compare; PurRDF decides whether they are one value.
    pub(crate) undecided_data: Vec<(u32, u32)>,
    pub(crate) thing_node: NodeId,
    pub(crate) analyses: HashMap<(NodeId, AxiomIx), super::union::Analysis>,
    pub(crate) case_count: usize,
}

fn push_why(premises: &mut Vec<Prem>, why: Why) {
    if let Some(prem) = why {
        premises.push(prem);
    }
}

impl<'t> Saturation<'t> {
    pub(crate) fn new(idx: &'t Tbox, model: Model) -> Self {
        let props = idx.props();
        let negative_props: Vec<PropId> = idx
            .neg_exists
            .values()
            .flatten()
            .map(|(prop, _)| *prop)
            .collect();
        let inverse_relevant = (0..idx.inverse.len() as PropId)
            .map(|prop| {
                negative_props
                    .iter()
                    .any(|&target| props.sub(idx.inv(prop), target))
            })
            .collect();
        let mut saturation = Self {
            idx,
            model,
            nodes: Vec::new(),
            contexts: HashMap::new(),
            individuals: HashMap::new(),
            links: Vec::new(),
            link_index: HashMap::new(),
            steps: Vec::new(),
            edges: HashMap::new(),
            edge_order: Vec::new(),
            sames: HashMap::new(),
            same_order: Vec::new(),
            literals: Vec::new(),
            literal_index: HashMap::new(),
            data: HashMap::new(),
            data_order: Vec::new(),
            queue: VecDeque::new(),
            refine_queue: VecDeque::new(),
            merge_queue: VecDeque::new(),
            inverse_relevant,
            inconsistency: None,
            undecided_data: Vec::new(),
            thing_node: 0,
            analyses: HashMap::new(),
            case_count: 0,
        };
        saturation.thing_node = saturation.context(&[idx.thing]);
        saturation
    }

    // #region Nodes, facts and links

    /// The node of the context with these parts, created (with its own facts queued) if new.
    pub(crate) fn context(&mut self, parts: &[ExprId]) -> NodeId {
        let (parts, expression) = self.model.context(parts);
        if let Some(&node) = self.contexts.get(&expression) {
            return node;
        }
        let node = self.nodes.len() as NodeId;
        self.nodes.push(Node::new(NodeKind::Context {
            expression,
            parts: parts.clone(),
        }));
        self.contexts.insert(expression, node);
        let thing = self.idx.thing;
        self.implicit(node, thing);
        self.implicit(node, expression);
        for part in parts {
            self.implicit(node, part);
        }
        node
    }

    pub(crate) fn context_of(&self, expression: ExprId) -> Option<NodeId> {
        self.contexts.get(&expression).copied()
    }

    pub(crate) fn individual(&mut self, sym: Sym) -> NodeId {
        if let Some(&node) = self.individuals.get(&sym) {
            return node;
        }
        let node = self.nodes.len() as NodeId;
        self.nodes.push(Node::new(NodeKind::Individual(sym)));
        self.individuals.insert(sym, node);
        let thing = self.idx.thing;
        self.implicit(node, thing);
        node
    }

    fn implicit(&mut self, node: NodeId, expression: ExprId) {
        self.insert_fact(node, expression, None, true);
    }

    fn insert_fact(&mut self, node: NodeId, expression: ExprId, why: Why, generate: bool) -> bool {
        let entry = &mut self.nodes[node as usize];
        if entry.facts.contains_key(&expression) {
            return false;
        }
        entry.facts.insert(expression, why);
        entry.order.push(expression);
        match self.model.expr(expression) {
            Expr::All(..) => entry.alls.push(expression),
            Expr::Max(..) => entry.maxes.push(expression),
            _ => {}
        }
        self.queue
            .push_back(Event::Fact(node, expression, generate));
        true
    }

    fn step(
        &mut self,
        rule: &'static str,
        mut premises: Vec<Prem>,
        conclusion: Conclusion,
    ) -> Prem {
        premises.sort_unstable_by_key(|prem| match prem {
            Prem::Axiom(ix) => (0, *ix),
            Prem::Step(id) => (1, *id),
        });
        premises.dedup();
        let id = self.steps.len() as StepId;
        self.steps.push(Step {
            rule,
            premises,
            conclusion,
        });
        Prem::Step(id)
    }

    /// Adds `node ⊑ expression` by `rule` unless it is known. `generate`: an existential conclusion
    /// gets an element of its own (a link); `exists-intro` conclusions have one already.
    fn add_fact(
        &mut self,
        node: NodeId,
        expression: ExprId,
        rule: &'static str,
        premises: Vec<Prem>,
        generate: bool,
    ) -> bool {
        if self.nodes[node as usize].facts.contains_key(&expression) {
            return false;
        }
        let prem = self.step(rule, premises, Conclusion::Class(node, expression));
        self.insert_fact(node, expression, Some(prem), generate)
    }

    pub(crate) fn assert_fact(&mut self, node: NodeId, expression: ExprId, axiom: AxiomIx) {
        self.insert_fact(node, expression, Some(Prem::Axiom(axiom)), true);
    }

    pub(crate) fn holds(&self, node: NodeId, expression: ExprId) -> bool {
        self.nodes[node as usize].facts.contains_key(&expression)
    }

    fn path(&self, from: PropId, to: PropId, premises: &mut Vec<Prem>) {
        let mut axioms = Vec::new();
        self.idx.props().path(from, to, &mut axioms);
        premises.extend(axioms.into_iter().map(Prem::Axiom));
    }

    fn sub(&self, from: PropId, to: PropId) -> bool {
        self.idx.props().sub(from, to)
    }

    /// The link of a generating existential `node ⊑ ∃R.F`; a filler that is not in context form
    /// is first rewritten to it by a refinement that adds nothing.
    fn link_from_fact(&mut self, node: NodeId, prop: PropId, filler: ExprId, why: Why) {
        let (_, expression) = self.model.context(&[filler]);
        if expression != filler {
            let canonical = self.model.intern(Expr::Some(prop, expression));
            let mut premises = Vec::new();
            push_why(&mut premises, why);
            if !self.add_fact(node, canonical, "forall-filler", premises, true) {
                let why = self.nodes[node as usize].why(canonical);
                self.link(node, prop, expression, why);
            }
            return;
        }
        self.link(node, prop, expression, why);
    }

    fn link(&mut self, from: NodeId, prop: PropId, context: ExprId, why: Why) {
        let to = match self.contexts.get(&context) {
            Some(&node) => node,
            None => {
                let parts = match self.model.expr(context) {
                    Expr::Inter(operands) => operands.clone(),
                    _ => vec![context],
                };
                self.context(&parts)
            }
        };
        if self.link_index.contains_key(&(from, prop, to)) {
            return;
        }
        let id = self.links.len() as LinkId;
        self.links.push(Link {
            from,
            prop,
            to,
            why,
            superseded: false,
        });
        self.link_index.insert((from, prop, to), id);
        self.nodes[from as usize].out.push(id);
        self.nodes[to as usize].inc.push(id);
        self.queue.push_back(Event::Link(id));
    }

    fn context_expression(&self, node: NodeId) -> ExprId {
        match &self.nodes[node as usize].kind {
            NodeKind::Context { expression, .. } => *expression,
            NodeKind::Individual(_) => unreachable!("links end at contexts"),
        }
    }

    /// An element for a diagnostic: an individual's IRI, or the class expression of a context.
    pub(crate) fn element_name(&self, node: NodeId) -> String {
        match self.nodes[node as usize].kind {
            NodeKind::Individual(sym) => self.model.iri_text(sym).to_owned(),
            NodeKind::Context { expression, .. } => {
                format!("an element of {}", self.model.key(expression))
            }
        }
    }

    fn individual_sym(&self, node: NodeId) -> Option<Sym> {
        match self.nodes[node as usize].kind {
            NodeKind::Individual(sym) => Some(sym),
            NodeKind::Context { .. } => None,
        }
    }

    fn add_edge(
        &mut self,
        subject: Sym,
        property: Sym,
        object: Sym,
        rule: &'static str,
        premises: Vec<Prem>,
    ) {
        if self.edges.contains_key(&(subject, property, object)) {
            return;
        }
        let prem = self.step(rule, premises, Conclusion::Edge(subject, property, object));
        self.insert_edge(subject, property, object, prem);
    }

    pub(crate) fn insert_edge(&mut self, subject: Sym, property: Sym, object: Sym, prem: Prem) {
        if self.edges.contains_key(&(subject, property, object)) {
            return;
        }
        self.edges.insert((subject, property, object), prem);
        self.edge_order.push((subject, property, object));
        self.queue
            .push_back(Event::Edge(subject, property, object, prem));
    }

    fn add_same(&mut self, left: NodeId, right: NodeId, rule: &'static str, premises: Vec<Prem>) {
        if left == right || self.sames.contains_key(&(left, right)) {
            return;
        }
        let prem = self.step(rule, premises, Conclusion::Same(left, right));
        self.sames.insert((left, right), prem);
        self.same_order.push((left, right));
        self.queue.push_back(Event::Same(left, right, prem));
    }

    pub(crate) fn literal(&mut self, value: &Value) -> u32 {
        let key = serde_json::to_string(value).expect("JSON values serialize");
        if let Some(&index) = self.literal_index.get(&key) {
            return index;
        }
        let index = self.literals.len() as u32;
        self.literals.push(value.clone());
        self.literal_index.insert(key, index);
        index
    }

    fn add_data(
        &mut self,
        node: NodeId,
        property: u32,
        literal: u32,
        rule: &'static str,
        premises: Vec<Prem>,
    ) {
        if self.data.contains_key(&(node, property, literal)) {
            return;
        }
        let prem = self.step(rule, premises, Conclusion::Data(node, property, literal));
        self.insert_data(node, property, literal, prem);
    }

    pub(crate) fn insert_data(&mut self, node: NodeId, property: u32, literal: u32, prem: Prem) {
        if self.data.contains_key(&(node, property, literal)) {
            return;
        }
        self.data.insert((node, property, literal), prem);
        self.data_order.push((node, property, literal));
        self.queue
            .push_back(Event::Data(node, property, literal, prem));
    }

    pub(crate) fn path_into(&self, from: PropId, to: PropId, premises: &mut Vec<Prem>) {
        self.path(from, to, premises);
    }

    pub(crate) fn add_chain_fact(
        &mut self,
        node: NodeId,
        expression: ExprId,
        rule: &'static str,
        premises: Vec<Prem>,
        generate: bool,
    ) -> bool {
        self.add_fact(node, expression, rule, premises, generate)
    }

    /// Adds a `chain-edge` statement; whether it is new.
    pub(crate) fn add_chain_edge(
        &mut self,
        subject: Sym,
        property: Sym,
        object: Sym,
        premises: Vec<Prem>,
    ) -> bool {
        let before = self.edge_order.len();
        self.add_edge(subject, property, object, "chain-edge", premises);
        self.edge_order.len() > before
    }

    pub(crate) fn queue_is_empty(&self) -> bool {
        self.queue.is_empty() && self.refine_queue.is_empty() && self.merge_queue.is_empty()
    }

    pub(crate) fn add_union_fact(
        &mut self,
        node: NodeId,
        expression: ExprId,
        premises: Vec<Prem>,
    ) -> bool {
        self.add_fact(node, expression, "union-case", premises, true)
    }

    fn mark_refine(&mut self, node: NodeId) {
        let entry = &mut self.nodes[node as usize];
        if !entry.refine_dirty {
            entry.refine_dirty = true;
            self.refine_queue.push_back(node);
        }
    }

    fn mark_merge_one(&mut self, node: NodeId) {
        let entry = &mut self.nodes[node as usize];
        if !entry.merge_dirty {
            entry.merge_dirty = true;
            self.merge_queue.push_back(node);
        }
    }

    /// Something a functionality rule reads changed at `node`: its own limits and successors, and,
    /// as a successor or a successor's successor, its predecessors' and theirs.
    fn mark_merge(&mut self, node: NodeId) {
        if !self.idx.has_limits {
            return;
        }
        self.mark_merge_one(node);
        for first in self.predecessors(node) {
            self.mark_merge_one(first);
            for second in self.predecessors(first) {
                self.mark_merge_one(second);
            }
        }
    }

    fn predecessors(&self, node: NodeId) -> Vec<NodeId> {
        let entry = &self.nodes[node as usize];
        let mut found: Vec<NodeId> = entry
            .inc
            .iter()
            .filter(|&&link| !self.links[link as usize].superseded)
            .map(|&link| self.links[link as usize].from)
            .collect();
        found.extend(entry.named.iter().map(|(_, neighbour, _)| *neighbour));
        found
    }

    // #endregion

    // #region The loop

    /// Saturates. `tick` is asked now and then whether time is left.
    pub(crate) fn run(&mut self, mut tick: impl FnMut() -> bool) -> Result<(), Stop> {
        let mut work: u64 = 0;
        loop {
            if let Some(event) = self.queue.pop_front() {
                work += 1;
                if work.is_multiple_of(4096) && !tick() {
                    return Err(Stop::Budget);
                }
                self.event(event);
                if self.inconsistency.is_some() {
                    return Ok(());
                }
                continue;
            }
            if let Some(node) = self.refine_queue.pop_front() {
                self.nodes[node as usize].refine_dirty = false;
                self.refine(node);
                continue;
            }
            if let Some(node) = self.merge_queue.pop_front() {
                self.nodes[node as usize].merge_dirty = false;
                self.merge(node);
                continue;
            }
            if !tick() {
                return Err(Stop::Budget);
            }
            match self.union_round() {
                Ok(true) => continue,
                Ok(false) => {}
                Err(super::union::UnionStop::NotLocal(axiom, node)) => {
                    return Err(Stop::NotLocal(axiom, node));
                }
                Err(super::union::UnionStop::TooManyCases) => return Err(Stop::TooManyCases),
            }
            match self.chain_round() {
                Ok(true) => continue,
                Ok(false) => return Ok(()),
                Err(super::chain::ChainBudget) => return Err(Stop::ChainBudget),
            }
        }
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::Fact(node, expression, generate) => self.fact(node, expression, generate),
            Event::Link(link) => self.new_link(link),
            Event::Edge(subject, property, object, prem) => {
                self.edge(subject, property, object, prem);
            }
            Event::Same(left, right, prem) => self.same(left, right, prem),
            Event::Data(node, property, literal, prem) => {
                self.data_fact(node, property, literal, prem)
            }
        }
    }

    // #endregion

    // #region Facts

    fn fact(&mut self, node: NodeId, expression: ExprId, generate: bool) {
        let idx = self.idx;
        let why = self.nodes[node as usize].why(expression);
        let premise = |extra: &[Prem]| {
            let mut premises = Vec::with_capacity(extra.len() + 1);
            push_why(&mut premises, why);
            premises.extend_from_slice(extra);
            premises
        };
        // told
        if let Some(list) = idx.told.get(&expression) {
            let own = match &self.nodes[node as usize].kind {
                NodeKind::Context {
                    expression: own, ..
                } => Some(*own),
                NodeKind::Individual(_) => None,
            };
            for &(axiom, superclass) in list {
                if own == Some(expression)
                    && idx.named_told.get(&(expression, superclass)) == Some(&axiom)
                {
                    // `SubClassOf(A, B)` is itself the fact `A ⊑ B`, as V1 states it (asserted).
                    self.insert_fact(node, superclass, Some(Prem::Axiom(axiom)), true);
                } else {
                    self.add_fact(
                        node,
                        superclass,
                        "told",
                        premise(&[Prem::Axiom(axiom)]),
                        true,
                    );
                }
            }
        }
        let shape = self.model.expr(expression).clone();
        match &shape {
            Expr::Inter(operands) => {
                for &operand in operands {
                    self.add_fact(node, operand, "and-elim", premise(&[]), true);
                }
            }
            Expr::Some(prop, filler) if generate => {
                self.link_from_fact(node, *prop, *filler, why);
            }
            Expr::All(prop, filler) => {
                self.mark_refine(node);
                self.named_universal(node, *prop, *filler, why);
            }
            Expr::Max(..) => self.mark_merge(node),
            Expr::Not(operand) if self.holds(node, *operand) => {
                let mut premises = premise(&[]);
                push_why(&mut premises, self.nodes[node as usize].why(*operand));
                self.add_fact(node, idx.nothing, "complement", premises, true);
            }
            _ => {}
        }
        if let Some(&complement) = idx.complement.get(&expression)
            && self.holds(node, complement)
        {
            let mut premises = premise(&[]);
            push_why(&mut premises, self.nodes[node as usize].why(complement));
            self.add_fact(node, idx.nothing, "complement", premises, true);
        }
        // and-intro
        if let Some(intersections) = idx.neg_inter.get(&expression) {
            for &intersection in intersections {
                let Expr::Inter(operands) = self.model.expr(intersection) else {
                    continue;
                };
                if operands.iter().all(|operand| self.holds(node, *operand)) {
                    let mut premises = Vec::new();
                    for operand in operands {
                        push_why(&mut premises, self.nodes[node as usize].why(*operand));
                    }
                    self.add_fact(node, intersection, "and-intro", premises, true);
                }
            }
        }
        // union-intro
        if let Some(unions) = idx.neg_union.get(&expression) {
            for &union in unions {
                self.add_fact(node, union, "union-intro", premise(&[]), true);
            }
        }
        // disjoint
        if let Some(list) = idx.disjoint.get(&expression) {
            for (axiom, members) in list {
                for &member in members {
                    if member != expression && self.holds(node, member) {
                        let mut premises = premise(&[Prem::Axiom(*axiom)]);
                        push_why(&mut premises, self.nodes[node as usize].why(member));
                        self.add_fact(node, idx.nothing, "disjoint", premises, true);
                    }
                }
            }
        }
        if expression == idx.nothing
            && (self.individual_sym(node).is_some() || node == self.thing_node)
            && self.inconsistency.is_none()
        {
            self.inconsistency = Some(Inconsistency::Nothing(node));
            return;
        }
        // Back to every predecessor.
        let incoming = self.nodes[node as usize].inc.clone();
        for link in incoming {
            if !self.links[link as usize].superseded {
                self.backprop(link, expression);
            }
        }
        // Across every named edge.
        let neighbours = self.nodes[node as usize].named.clone();
        for (prop, neighbour, edge) in neighbours {
            self.exists_intro(neighbour, idx.inv(prop), Some(edge), expression, why);
            if let Expr::Some(next, filler) = &shape {
                self.transitive_exists(neighbour, idx.inv(prop), Some(edge), *next, *filler, why);
            }
        }
        if idx.has_limits && idx.limit_fillers.contains_key(&expression) {
            self.mark_merge(node);
        }
        // inverse-filler
        if idx.neg_exists.contains_key(&expression)
            && self.nodes[node as usize].out.iter().any(|&link| {
                let link = &self.links[link as usize];
                !link.superseded && self.inverse_relevant[link.prop as usize]
            })
        {
            self.mark_refine(node);
        }
        // same-as-copy
        let partners = self.nodes[node as usize].same.clone();
        for (partner, same) in partners {
            self.add_fact(
                partner,
                expression,
                "same-as-copy",
                premise(&[same]),
                generate,
            );
        }
    }

    /// `from ⊑ ∃S.G` for each negative `∃S.G` with `prop ⊑* S`, the successor (through `prop`,
    /// shown by `link`) being in `G`.
    fn exists_intro(
        &mut self,
        from: NodeId,
        prop: PropId,
        link: Why,
        filler: ExprId,
        filler_why: Why,
    ) {
        let idx = self.idx;
        let Some(list) = idx.neg_exists.get(&filler) else {
            return;
        };
        for &(target, existential) in list {
            if !self.sub(prop, target) || self.holds(from, existential) {
                continue;
            }
            let mut premises = Vec::new();
            push_why(&mut premises, link);
            push_why(&mut premises, filler_why);
            self.path(prop, target, &mut premises);
            self.add_fact(from, existential, "exists-intro", premises, false);
        }
    }

    /// `transitive-exists`: `from` has a `prop`-successor with a `next`-successor in `filler`; for a
    /// transitive `T` above both (with a negative existential over `T` and `filler`), `from ⊑ ∃T.filler`.
    fn transitive_exists(
        &mut self,
        from: NodeId,
        prop: PropId,
        link: Why,
        next: PropId,
        filler: ExprId,
        fact_why: Why,
    ) {
        let idx = self.idx;
        let Some(list) = idx.transitive_exists.get(&filler) else {
            return;
        };
        for &(axiom, transitive, existential) in list {
            if self.holds(from, existential)
                || !self.sub(prop, transitive)
                || !self.sub(next, transitive)
            {
                continue;
            }
            let mut premises = vec![Prem::Axiom(axiom)];
            push_why(&mut premises, link);
            push_why(&mut premises, fact_why);
            self.path(prop, transitive, &mut premises);
            self.path(next, transitive, &mut premises);
            self.add_fact(from, existential, "transitive-exists", premises, false);
        }
    }

    /// What a new fact `G` of a link's target tells the link's source.
    fn backprop(&mut self, link: LinkId, fact: ExprId) {
        let idx = self.idx;
        let Link {
            from,
            prop,
            to,
            why,
            ..
        } = self.links[link as usize];
        let fact_why = self.nodes[to as usize].why(fact);
        self.exists_intro(from, prop, why, fact, fact_why);
        let base = || {
            let mut premises = Vec::new();
            push_why(&mut premises, why);
            push_why(&mut premises, fact_why);
            premises
        };
        if fact == idx.nothing {
            self.add_fact(from, idx.nothing, "exists-bottom", base(), true);
        }
        if let Expr::Some(next, filler) = *self.model.expr(fact) {
            self.transitive_exists(from, prop, why, next, filler, fact_why);
        }
        if let Expr::All(universal, filler) = *self.model.expr(fact) {
            let inverse = idx.inv(prop);
            if self.sub(inverse, universal) {
                let mut premises = base();
                self.path(inverse, universal, &mut premises);
                self.add_fact(from, filler, "inverse-pushback", premises, true);
            }
            for &(axiom, transitive) in &idx.transitive {
                for through in [transitive, idx.inv(transitive)] {
                    if self.sub(inverse, through) && self.sub(through, universal) {
                        let mut premises = base();
                        premises.push(Prem::Axiom(axiom));
                        self.path(inverse, through, &mut premises);
                        self.path(through, universal, &mut premises);
                        let conclusion = self.model.intern(Expr::All(through, filler));
                        self.add_fact(from, conclusion, "transitive-pushback", premises, true);
                    }
                }
            }
        }
        if idx.has_limits
            && (matches!(self.model.expr(fact), Expr::Max(..))
                || idx.limit_fillers.contains_key(&fact))
        {
            self.mark_merge(from);
        }
    }

    /// A universal `∀S.F` of an individual, along its named edges: `forall-filler` and
    /// `transitive-filler` on each neighbour.
    fn named_universal(&mut self, node: NodeId, universal: PropId, filler: ExprId, why: Why) {
        let idx = self.idx;
        let neighbours = self.nodes[node as usize].named.clone();
        for (prop, neighbour, edge) in neighbours {
            if self.sub(prop, universal) {
                let mut premises = vec![edge];
                push_why(&mut premises, why);
                self.path(prop, universal, &mut premises);
                self.add_fact(neighbour, filler, "forall-filler", premises, true);
            }
            for &(axiom, transitive) in &idx.transitive {
                for through in [transitive, idx.inv(transitive)] {
                    if self.sub(prop, through) && self.sub(through, universal) {
                        let mut premises = vec![edge, Prem::Axiom(axiom)];
                        push_why(&mut premises, why);
                        self.path(prop, through, &mut premises);
                        self.path(through, universal, &mut premises);
                        let conclusion = self.model.intern(Expr::All(through, filler));
                        self.add_fact(neighbour, conclusion, "transitive-filler", premises, true);
                    }
                }
            }
        }
    }

    fn new_link(&mut self, link: LinkId) {
        let idx = self.idx;
        let Link {
            from,
            prop,
            to,
            why,
            ..
        } = self.links[link as usize];
        let facts = self.nodes[to as usize].order.clone();
        for fact in facts {
            if self.links[link as usize].superseded {
                break;
            }
            self.backprop(link, fact);
        }
        // Domains (`∀S⁻.F` everywhere) of the link's property: the source is in `F`.
        let inverse = idx.inv(prop);
        for &over in idx.props().supers(inverse) {
            if let Some(list) = idx.universals.get(&over) {
                for &(axiom, filler) in list {
                    let mut premises = vec![Prem::Axiom(axiom)];
                    push_why(&mut premises, why);
                    self.path(inverse, over, &mut premises);
                    self.add_fact(from, filler, "inverse-pushback", premises, true);
                }
            }
        }
        self.mark_refine(from);
        self.mark_merge(from);
    }

    // #endregion

    // #region Refinement

    /// Refines each current link of `node` with what `node` says about its successors: the
    /// fillers of universals over the link's property (`forall-filler`), universals over a
    /// transitive property between (`transitive-filler`), and `∃S.D` for a negative existential
    /// with `R⁻ ⊑* S` and `node ⊑ D` (`inverse-filler`). Each kind is one step; the last one's
    /// context is the new link, and the old link is superseded.
    fn refine(&mut self, node: NodeId) {
        let idx = self.idx;
        let links: Vec<LinkId> = self.nodes[node as usize].out.clone();
        for link in links {
            let Link {
                prop,
                to,
                why,
                superseded,
                ..
            } = self.links[link as usize];
            if superseded {
                continue;
            }
            let mut groups: [(&'static str, Vec<ExprId>, Vec<Prem>); 3] = [
                ("forall-filler", Vec::new(), Vec::new()),
                ("transitive-filler", Vec::new(), Vec::new()),
                ("inverse-filler", Vec::new(), Vec::new()),
            ];
            let wanted = |saturation: &Self, added: &[ExprId], part: ExprId| {
                !saturation.holds(to, part) && !added.contains(&part)
            };
            // Universals of the node, and those that hold everywhere.
            let alls = self.nodes[node as usize].alls.clone();
            for &universal_fact in &alls {
                let Expr::All(universal, filler) = *self.model.expr(universal_fact) else {
                    continue;
                };
                let fact_why = self.nodes[node as usize].why(universal_fact);
                if self.sub(prop, universal) {
                    let (parts, _) = self.model.context(&[filler]);
                    let mut used = false;
                    for part in parts {
                        if wanted(self, &groups[0].1, part) {
                            groups[0].1.push(part);
                            used = true;
                        }
                    }
                    if used {
                        push_why(&mut groups[0].2, fact_why);
                        self.path(prop, universal, &mut groups[0].2);
                    }
                }
                for &(axiom, transitive) in &idx.transitive {
                    for through in [transitive, idx.inv(transitive)] {
                        if self.sub(prop, through) && self.sub(through, universal) {
                            let part = self.model.intern(Expr::All(through, filler));
                            if wanted(self, &groups[1].1, part) {
                                groups[1].1.push(part);
                                groups[1].2.push(Prem::Axiom(axiom));
                                push_why(&mut groups[1].2, fact_why);
                                self.path(prop, through, &mut groups[1].2);
                                self.path(through, universal, &mut groups[1].2);
                            }
                        }
                    }
                }
            }
            for &over in idx.props().supers(prop) {
                if let Some(list) = idx.universals.get(&over) {
                    for &(axiom, filler) in list {
                        let (parts, _) = self.model.context(&[filler]);
                        let mut used = false;
                        for part in parts {
                            if wanted(self, &groups[0].1, part) {
                                groups[0].1.push(part);
                                used = true;
                            }
                        }
                        if used {
                            groups[0].2.push(Prem::Axiom(axiom));
                            self.path(prop, over, &mut groups[0].2);
                        }
                    }
                }
            }
            if self.inverse_relevant[prop as usize] {
                let inverse = idx.inv(prop);
                let facts = self.nodes[node as usize].order.clone();
                for fact in facts {
                    let Some(list) = idx.neg_exists.get(&fact) else {
                        continue;
                    };
                    for &(target, existential) in list {
                        if self.sub(inverse, target) && wanted(self, &groups[2].1, existential) {
                            groups[2].1.push(existential);
                            push_why(&mut groups[2].2, self.nodes[node as usize].why(fact));
                            self.path(inverse, target, &mut groups[2].2);
                        }
                    }
                }
            }
            if groups.iter().all(|(_, added, _)| added.is_empty()) {
                continue;
            }
            let last = groups
                .iter()
                .rposition(|(_, added, _)| !added.is_empty())
                .expect("one group is not empty");
            let mut parts: Vec<ExprId> = self.nodes[to as usize].parts().to_vec();
            let mut current_why = why;
            let mut conclusion = 0;
            for (position, (rule, added, justification)) in groups.into_iter().enumerate() {
                if added.is_empty() {
                    continue;
                }
                parts.extend(added);
                let (flat, expression) = self.model.context(&parts);
                parts = flat;
                conclusion = self.model.intern(Expr::Some(prop, expression));
                let mut premises = justification;
                push_why(&mut premises, current_why);
                self.add_fact(node, conclusion, rule, premises, position == last);
                current_why = self.nodes[node as usize].why(conclusion);
            }
            self.links[link as usize].superseded = true;
            // The refined link, even if the conclusion was known before without one.
            if let Expr::Some(_, filler) = *self.model.expr(conclusion) {
                self.link(node, prop, filler, current_why);
            }
        }
    }

    // #endregion

    // #region Functionality

    /// The maximum cardinalities on `node`: its own `≤n S.F` facts, and the functionality axioms
    /// over a property above one of its successors' (`≤1 S.⊤`).
    fn limits(&self, node: NodeId) -> Vec<(u8, PropId, ExprId, Vec<Prem>)> {
        let idx = self.idx;
        let entry = &self.nodes[node as usize];
        let mut limits = Vec::new();
        for &fact in &entry.maxes {
            if let Expr::Max(cardinality, prop, filler) = *self.model.expr(fact) {
                let mut premises = Vec::new();
                push_why(&mut premises, entry.why(fact));
                limits.push((cardinality, prop, filler, premises));
            }
        }
        if idx.functional.is_empty() {
            return limits;
        }
        let mut props: Vec<PropId> = entry
            .out
            .iter()
            .filter(|&&link| !self.links[link as usize].superseded)
            .map(|&link| self.links[link as usize].prop)
            .chain(entry.named.iter().map(|(prop, _, _)| *prop))
            .collect();
        props.sort_unstable();
        props.dedup();
        let mut seen: Vec<AxiomIx> = Vec::new();
        for prop in props {
            for &over in idx.props().supers(prop) {
                for &axiom in idx.functional.get(&over).into_iter().flatten() {
                    if !seen.contains(&axiom) {
                        seen.push(axiom);
                        limits.push((1, over, idx.thing, vec![Prem::Axiom(axiom)]));
                    }
                }
            }
        }
        limits
    }

    fn merge(&mut self, node: NodeId) {
        let idx = self.idx;
        for (cardinality, limit, filler, limit_premises) in self.limits(node) {
            // The successors under the limit, anonymous and named.
            let mut anonymous: Vec<LinkId> = Vec::new();
            for &link in &self.nodes[node as usize].out {
                let entry = &self.links[link as usize];
                if !entry.superseded && self.sub(entry.prop, limit) && self.holds(entry.to, filler)
                {
                    anonymous.push(link);
                }
            }
            let named: Vec<(PropId, NodeId, Prem)> = self.nodes[node as usize]
                .named
                .iter()
                .filter(|(prop, neighbour, _)| {
                    self.sub(*prop, limit) && self.holds(*neighbour, filler)
                })
                .copied()
                .collect();
            let base = |saturation: &Self, prop: PropId, target: NodeId, why: Why| {
                let mut premises = limit_premises.clone();
                push_why(&mut premises, why);
                push_why(&mut premises, saturation.nodes[target as usize].why(filler));
                saturation.path(prop, limit, &mut premises);
                premises
            };
            if cardinality == 0 {
                if let Some(&link) = anonymous.first() {
                    let Link { prop, to, why, .. } = self.links[link as usize];
                    let premises = base(self, prop, to, why);
                    self.add_fact(node, idx.nothing, "max-zero", premises, true);
                } else if let Some(&(prop, neighbour, edge)) = named.first() {
                    let premises = base(self, prop, neighbour, Some(edge));
                    self.add_fact(node, idx.nothing, "max-zero", premises, true);
                }
                continue;
            }
            if let Some(&(first_prop, first, first_edge)) = named.first() {
                let first_premises = base(self, first_prop, first, Some(first_edge));
                for &(prop, neighbour, edge) in &named[1..] {
                    if neighbour == first {
                        continue;
                    }
                    let mut premises = first_premises.clone();
                    premises.extend(base(self, prop, neighbour, Some(edge)));
                    self.add_same(first, neighbour, "functional-same-as", premises);
                }
                let first_sym = self
                    .individual_sym(first)
                    .expect("named neighbours are individuals");
                let own_sym = self
                    .individual_sym(node)
                    .expect("named neighbours are individuals");
                for link in anonymous {
                    let Link { prop, to, why, .. } = self.links[link as usize];
                    let mut premises = first_premises.clone();
                    premises.extend(base(self, prop, to, why));
                    let parts = self.nodes[to as usize].parts().to_vec();
                    for part in parts {
                        self.add_fact(first, part, "functional-filler", premises.clone(), true);
                    }
                    let (sym, inverse) = self.model.prop_parts(prop);
                    if inverse {
                        self.add_edge(first_sym, sym, own_sym, "functional-filler", premises);
                    } else {
                        self.add_edge(own_sym, sym, first_sym, "functional-filler", premises);
                    }
                    self.links[link as usize].superseded = true;
                }
                continue;
            }
            if anonymous.len() < 2 {
                continue;
            }
            // Merge into the largest target: the others' subsets join it; one other adds a context.
            let largest = *anonymous
                .iter()
                .max_by_key(|&&link| {
                    (
                        self.nodes[self.links[link as usize].to as usize]
                            .parts()
                            .len(),
                        std::cmp::Reverse(link),
                    )
                })
                .expect("two links");
            let Link {
                prop: big_prop,
                to: big,
                why: big_why,
                ..
            } = self.links[largest as usize];
            let big_parts = self.nodes[big as usize].parts().to_vec();
            let big_expression = self.context_expression(big);
            for &link in &anonymous {
                if link == largest {
                    continue;
                }
                let Link { prop, to, why, .. } = self.links[link as usize];
                let parts = self.nodes[to as usize].parts().to_vec();
                let mut premises = base(self, big_prop, big, big_why);
                premises.extend(base(self, prop, to, why));
                if parts.iter().all(|part| big_parts.contains(part)) {
                    if to != big {
                        let conclusion = self.model.intern(Expr::Some(prop, big_expression));
                        self.add_fact(node, conclusion, "functional-merge", premises, true);
                        self.links[link as usize].superseded = true;
                    }
                    continue;
                }
                let mut merged = big_parts.clone();
                merged.extend(parts);
                let (_, expression) = self.model.context(&merged);
                let conclusion = self.model.intern(Expr::Some(big_prop, expression));
                self.add_fact(node, conclusion, "functional-merge", premises, true);
                self.links[largest as usize].superseded = true;
                break;
            }
        }
        self.pushback(node);
    }

    /// `functional-pushback`: a successor `K₁` of `node` (through `R₁`) with `≤1 S.F`, `R₁⁻ ⊑* S`
    /// and `node ⊑ F` has at most one `S`-successor in `F`, which is `node` itself: so each other
    /// `S`-successor of `K₁` in `F` is `node`, and `node` has an `R₂⁻`-successor in `K₁`.
    fn pushback(&mut self, node: NodeId) {
        let links: Vec<LinkId> = self.nodes[node as usize].out.clone();
        for first in links {
            let Link {
                prop: first_prop,
                to: middle,
                why: first_why,
                superseded,
                ..
            } = self.links[first as usize];
            if superseded {
                continue;
            }
            let inverse = self.idx.inv(first_prop);
            let middle_expression = self.context_expression(middle);
            for (cardinality, limit, filler, limit_premises) in self.limits(middle) {
                if !self.sub(inverse, limit) || !self.holds(node, filler) {
                    continue;
                }
                if cardinality == 0 {
                    // `max-zero-pushback`: `K₁` has no `S`-successor in `F`, yet `node` is one.
                    let mut premises = limit_premises.clone();
                    push_why(&mut premises, first_why);
                    push_why(&mut premises, self.nodes[node as usize].why(filler));
                    self.path(inverse, limit, &mut premises);
                    let nothing = self.idx.nothing;
                    self.add_fact(node, nothing, "max-zero-pushback", premises, true);
                    continue;
                }
                let seconds: Vec<LinkId> = self.nodes[middle as usize].out.clone();
                for second in seconds {
                    let Link {
                        prop: second_prop,
                        to: target,
                        why: second_why,
                        superseded,
                        ..
                    } = self.links[second as usize];
                    if superseded || !self.sub(second_prop, limit) || !self.holds(target, filler) {
                        continue;
                    }
                    let mut premises = limit_premises.clone();
                    push_why(&mut premises, first_why);
                    push_why(&mut premises, second_why);
                    push_why(&mut premises, self.nodes[node as usize].why(filler));
                    push_why(&mut premises, self.nodes[target as usize].why(filler));
                    self.path(inverse, limit, &mut premises);
                    self.path(second_prop, limit, &mut premises);
                    let parts = self.nodes[target as usize].parts().to_vec();
                    for part in parts {
                        self.add_fact(node, part, "functional-pushback", premises.clone(), true);
                    }
                    let back = self.idx.inv(second_prop);
                    let conclusion = self.model.intern(Expr::Some(back, middle_expression));
                    self.add_fact(node, conclusion, "functional-pushback", premises, true);
                }
            }
        }
    }

    // #endregion

    // #region Individuals

    fn edge(&mut self, subject: Sym, property: Sym, object: Sym, prem: Prem) {
        let idx = self.idx;
        let (from, to) = (self.individual(subject), self.individual(object));
        let prop = self
            .model
            .find_prop(property, false)
            .expect("edge properties are interned");
        let inverse = idx.inv(prop);
        self.nodes[from as usize].named.push((prop, to, prem));
        self.nodes[to as usize].named.push((inverse, from, prem));
        // sub-property
        for &over in idx.props().supers(prop) {
            if over == prop {
                continue;
            }
            let mut premises = vec![prem];
            self.path(prop, over, &mut premises);
            let (sym, inverted) = self.model.prop_parts(over);
            if inverted {
                self.add_edge(object, sym, subject, "sub-property", premises);
            } else {
                self.add_edge(subject, sym, object, "sub-property", premises);
            }
        }
        // transitive-edge
        for &(axiom, transitive) in &idx.transitive {
            let transitive_sym = self.model.prop_parts(transitive).0;
            for (x, via, y) in [(from, prop, to), (to, inverse, from)] {
                if !self.sub(via, transitive) {
                    continue;
                }
                let (x_sym, y_sym) = (
                    self.individual_sym(x).unwrap(),
                    self.individual_sym(y).unwrap(),
                );
                let after = self.nodes[y as usize].named.clone();
                for (next, z, next_edge) in after {
                    if self.sub(next, transitive) {
                        let mut premises = vec![prem, next_edge, Prem::Axiom(axiom)];
                        self.path(via, transitive, &mut premises);
                        self.path(next, transitive, &mut premises);
                        let z_sym = self.individual_sym(z).unwrap();
                        self.add_edge(x_sym, transitive_sym, z_sym, "transitive-edge", premises);
                    }
                }
                let before = self.nodes[x as usize].named.clone();
                for (back, w, back_edge) in before {
                    let previous = idx.inv(back);
                    if self.sub(previous, transitive) {
                        let mut premises = vec![back_edge, prem, Prem::Axiom(axiom)];
                        self.path(previous, transitive, &mut premises);
                        self.path(via, transitive, &mut premises);
                        let w_sym = self.individual_sym(w).unwrap();
                        self.add_edge(w_sym, transitive_sym, y_sym, "transitive-edge", premises);
                    }
                }
            }
        }
        for (x, via, y) in [(from, prop, to), (to, inverse, from)] {
            // Universals that hold everywhere.
            for &over in idx.props().supers(via) {
                if let Some(list) = idx.universals.get(&over) {
                    for &(axiom, filler) in list {
                        let mut premises = vec![prem, Prem::Axiom(axiom)];
                        self.path(via, over, &mut premises);
                        self.add_fact(y, filler, "forall-filler", premises, true);
                    }
                }
            }
            // The individual's own universals.
            let alls = self.nodes[x as usize].alls.clone();
            for universal_fact in alls {
                let Expr::All(universal, filler) = *self.model.expr(universal_fact) else {
                    continue;
                };
                let why = self.nodes[x as usize].why(universal_fact);
                if self.sub(via, universal) {
                    let mut premises = vec![prem];
                    push_why(&mut premises, why);
                    self.path(via, universal, &mut premises);
                    self.add_fact(y, filler, "forall-filler", premises, true);
                }
                for &(axiom, transitive) in &idx.transitive {
                    for through in [transitive, idx.inv(transitive)] {
                        if self.sub(via, through) && self.sub(through, universal) {
                            let mut premises = vec![prem, Prem::Axiom(axiom)];
                            push_why(&mut premises, why);
                            self.path(via, through, &mut premises);
                            self.path(through, universal, &mut premises);
                            let conclusion = self.model.intern(Expr::All(through, filler));
                            self.add_fact(y, conclusion, "transitive-filler", premises, true);
                        }
                    }
                }
            }
            // exists-intro from the neighbour's facts.
            let facts = self.nodes[y as usize].order.clone();
            for fact in facts {
                let why = self.nodes[y as usize].why(fact);
                self.exists_intro(x, via, Some(prem), fact, why);
                if let Expr::Some(next, filler) = *self.model.expr(fact) {
                    self.transitive_exists(x, via, Some(prem), next, filler, why);
                }
            }
        }
        self.mark_merge(from);
        self.mark_merge(to);
        // same-as-copy
        let partners = self.nodes[from as usize].same.clone();
        for (partner, same) in partners {
            let partner_sym = self.individual_sym(partner).unwrap();
            self.add_edge(
                partner_sym,
                property,
                object,
                "same-as-copy",
                vec![same, prem],
            );
        }
        let partners = self.nodes[to as usize].same.clone();
        for (partner, same) in partners {
            let partner_sym = self.individual_sym(partner).unwrap();
            self.add_edge(
                subject,
                property,
                partner_sym,
                "same-as-copy",
                vec![same, prem],
            );
        }
    }

    fn same(&mut self, left: NodeId, right: NodeId, prem: Prem) {
        self.nodes[left as usize].same.push((right, prem));
        self.nodes[right as usize].same_in.push((left, prem));
        self.add_same(right, left, "same-as-symmetric", vec![prem]);
        let after = self.nodes[right as usize].same.clone();
        for (next, next_prem) in after {
            self.add_same(left, next, "same-as-transitive", vec![prem, next_prem]);
        }
        let before = self.nodes[left as usize].same_in.clone();
        for (previous, previous_prem) in before {
            self.add_same(
                previous,
                right,
                "same-as-transitive",
                vec![previous_prem, prem],
            );
        }
        // Everything known about `left` holds of `right`.
        let facts = self.nodes[left as usize].order.clone();
        for fact in facts {
            let why = self.nodes[left as usize].why(fact);
            let mut premises = vec![prem];
            push_why(&mut premises, why);
            self.add_fact(right, fact, "same-as-copy", premises, true);
        }
        let (left_sym, right_sym) = (
            self.individual_sym(left).unwrap(),
            self.individual_sym(right).unwrap(),
        );
        let neighbours = self.nodes[left as usize].named.clone();
        for (prop, neighbour, edge) in neighbours {
            let neighbour_sym = self.individual_sym(neighbour).unwrap();
            let (sym, inverse) = self.model.prop_parts(prop);
            if inverse {
                self.add_edge(
                    neighbour_sym,
                    sym,
                    right_sym,
                    "same-as-copy",
                    vec![prem, edge],
                );
            } else {
                self.add_edge(
                    right_sym,
                    sym,
                    neighbour_sym,
                    "same-as-copy",
                    vec![prem, edge],
                );
            }
        }
        let data = self.nodes[left as usize].data.clone();
        for (property, literal, data_prem) in data {
            self.add_data(
                right,
                property,
                literal,
                "same-as-copy",
                vec![prem, data_prem],
            );
        }
        let _ = left_sym;
    }

    fn data_fact(&mut self, node: NodeId, property: u32, literal: u32, prem: Prem) {
        let idx = self.idx;
        let data = idx.data();
        self.nodes[node as usize]
            .data
            .push((property, literal, prem));
        let data_path = |from: u32, to: u32, premises: &mut Vec<Prem>| {
            let mut axioms = Vec::new();
            data.path(from, to, &mut axioms);
            premises.extend(axioms.into_iter().map(Prem::Axiom));
        };
        for &over in data.supers(property) {
            if over != property {
                let mut premises = vec![prem];
                data_path(property, over, &mut premises);
                self.add_data(node, over, literal, "sub-property", premises);
            }
            if let Some(list) = idx.data_domains.get(&over) {
                for &(axiom, domain) in list {
                    let mut premises = vec![prem, Prem::Axiom(axiom)];
                    data_path(property, over, &mut premises);
                    self.add_fact(node, domain, "data-domain", premises, true);
                }
            }
        }
        for &(axiom, functional) in &idx.functional_data {
            if !data.sub(property, functional) || self.inconsistency.is_some() {
                continue;
            }
            let others = self.nodes[node as usize].data.clone();
            for (other_property, other_literal, other_prem) in others {
                if other_literal == literal || !data.sub(other_property, functional) {
                    continue;
                }
                let left = comparable_value(&self.literals[literal as usize]);
                let right = comparable_value(&self.literals[other_literal as usize]);
                match (left, right) {
                    (Some(left), Some(right)) if left != right => {
                        let mut premises = vec![Prem::Axiom(axiom), prem, other_prem];
                        data_path(property, functional, &mut premises);
                        data_path(other_property, functional, &mut premises);
                        self.inconsistency = Some(Inconsistency::DataClash(premises));
                        return;
                    }
                    (Some(_), Some(_)) => {}
                    _ => {
                        let pair = (literal.min(other_literal), literal.max(other_literal));
                        if !self.undecided_data.contains(&pair) {
                            self.undecided_data.push(pair);
                        }
                    }
                }
            }
        }
        let partners = self.nodes[node as usize].same.clone();
        for (partner, same) in partners {
            self.add_data(partner, property, literal, "same-as-copy", vec![same, prem]);
        }
    }

    // #endregion
}
