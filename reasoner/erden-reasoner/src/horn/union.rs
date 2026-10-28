//! Union domains beside Horn axioms: the one non-Horn construct, decided by case analysis.
//!
//! An element (an individual, or a context) with a successor under a property whose domain is
//! `A₁ ⊔ … ⊔ Aₙ`, and in none of the `Aᵢ`, gets one case per operand: a context of what is known of
//! it plus `Aᵢ`. Cases are contexts of the same saturation, shared with anything else that needs
//! them. A case that reaches `owl:Nothing` is closed; what every open case reaches holds of the
//! element (`union-case`). A conclusion only some cases reach must stay inside the element: if a
//! neighbour could read it, the disjunction would have to spread, which the Horn calculus cannot do,
//! and the request is refused `union-domain-not-local`.

use super::model::{Expr, ExprId};
use super::saturate::{NodeId, NodeKind, Prem, Saturation};
use super::tbox::{AxiomIx, UnionTarget};

/// The largest number of case contexts one request may create, as V1's `MAX_UNION_CASES`.
const MAX_CASES: usize = 4_096;

/// Why the case analysis stopped.
pub(crate) enum UnionStop {
    /// A conclusion of some cases would reach a neighbour: the domain axiom and the element.
    NotLocal(AxiomIx, NodeId),
    TooManyCases,
}

/// One element's analysis for one domain: its fact count when analysed, and its cases.
pub(crate) struct Analysis {
    facts: usize,
    cases: Vec<NodeId>,
    done: bool,
}

impl Saturation<'_> {
    /// Where the union domain applies to `node`: the cited witness of a successor under it.
    fn union_witness(&self, node: NodeId, target: UnionTarget) -> Option<Vec<Prem>> {
        match target {
            UnionTarget::Object(witness) => self
                .holds(node, witness)
                .then(|| self.nodes[node as usize].why(witness).into_iter().collect()),
            UnionTarget::Data(property) => {
                let data = self.idx.data();
                self.nodes[node as usize]
                    .data_facts()
                    .iter()
                    .find(|(asserted, _, _)| data.sub(*asserted, property))
                    .map(|&(asserted, _, prem)| {
                        let mut premises = vec![prem];
                        let mut axioms = Vec::new();
                        data.path(asserted, property, &mut axioms);
                        premises.extend(axioms.into_iter().map(Prem::Axiom));
                        premises
                    })
            }
        }
    }

    /// The parts every case of `node` shares: a context's own parts, or an individual's facts.
    fn case_base(&self, node: NodeId) -> Vec<ExprId> {
        let entry = &self.nodes[node as usize];
        match entry.kind {
            NodeKind::Context { .. } => entry.parts().to_vec(),
            NodeKind::Individual(_) => entry
                .order
                .iter()
                .copied()
                .filter(|&fact| fact != self.idx.thing)
                .collect(),
        }
    }

    /// Whether a neighbour of `node` could read the fact `fact` (conservatively: any rule that
    /// looks at a successor's or predecessor's facts might).
    fn read_by_neighbours(&self, fact: ExprId) -> bool {
        let idx = self.idx;
        match self.model.expr(fact) {
            Expr::All(..) | Expr::Max(..) => return true,
            Expr::Some(..) if idx.has_limits => return true,
            _ => {}
        }
        idx.neg_exists.contains_key(&fact)
            || idx.limit_fillers.contains_key(&fact)
            || idx.transitive_exists.contains_key(&fact)
    }

    /// Whether every union domain on `node` is settled: satisfied, or analysed on its current facts.
    fn settled(&self, node: NodeId) -> bool {
        self.idx.union_domains.iter().all(|domain| {
            self.union_witness(node, domain.target).is_none()
                || domain
                    .operands
                    .iter()
                    .any(|&operand| self.holds(node, operand))
                || self
                    .analyses
                    .get(&(node, domain.axiom))
                    .is_some_and(|analysis| {
                        analysis.done && analysis.facts == self.nodes[node as usize].order.len()
                    })
        })
    }

    /// One round of case analysis over every node. Returns whether anything changed.
    pub(crate) fn union_round(&mut self) -> Result<bool, UnionStop> {
        let idx = self.idx;
        if idx.union_domains.is_empty() {
            return Ok(false);
        }
        let mut progress = false;
        let count = self.nodes.len() as NodeId;
        for node in 0..count {
            for domain in &idx.union_domains {
                let Some(witness) = self.union_witness(node, domain.target) else {
                    continue;
                };
                if domain
                    .operands
                    .iter()
                    .any(|&operand| self.holds(node, operand))
                {
                    continue;
                }
                let facts = self.nodes[node as usize].order.len();
                let key = (node, domain.axiom);
                let current = self.analyses.get(&key);
                if current.is_some_and(|analysis| analysis.done && analysis.facts == facts) {
                    continue;
                }
                let cases = match current {
                    Some(analysis) if analysis.facts == facts => analysis.cases.clone(),
                    _ => {
                        let base = self.case_base(node);
                        let before = self.nodes.len();
                        let cases: Vec<NodeId> = domain
                            .operands
                            .iter()
                            .map(|&operand| {
                                let mut parts = base.clone();
                                parts.push(operand);
                                self.context(&parts)
                            })
                            .collect();
                        self.case_count += self.nodes.len() - before;
                        if self.case_count > MAX_CASES {
                            return Err(UnionStop::TooManyCases);
                        }
                        progress |= self.nodes.len() > before;
                        self.analyses.insert(
                            key,
                            Analysis {
                                facts,
                                cases: cases.clone(),
                                done: false,
                            },
                        );
                        cases
                    }
                };
                // Wait for the cases' own case analyses (and their saturation) to settle.
                if !self.queue_is_empty() || !cases.iter().all(|&case| self.settled(case)) {
                    continue;
                }
                progress = true;
                self.conclude(node, domain.axiom, &cases, witness)?;
                let facts_after = self.nodes[node as usize].order.len();
                self.analyses.insert(
                    key,
                    Analysis {
                        facts: facts_after,
                        cases,
                        done: true,
                    },
                );
            }
        }
        Ok(progress)
    }

    /// Adds what every open case of `node` reaches, citing the axiom, the witness, the cases and,
    /// for an individual, the facts its cases are made of.
    fn conclude(
        &mut self,
        node: NodeId,
        axiom: AxiomIx,
        cases: &[NodeId],
        witness: Vec<Prem>,
    ) -> Result<bool, UnionStop> {
        let nothing = self.idx.nothing;
        let open: Vec<NodeId> = cases
            .iter()
            .copied()
            .filter(|&case| !self.holds(case, nothing))
            .collect();
        let mut base_premises = vec![Prem::Axiom(axiom)];
        base_premises.extend(witness);
        if matches!(self.nodes[node as usize].kind, NodeKind::Individual(_)) {
            for fact in self.case_base(node) {
                base_premises.extend(self.nodes[node as usize].why(fact));
            }
        }
        let case_premises = |saturation: &Self, fact: ExprId| -> Vec<Prem> {
            cases
                .iter()
                .filter_map(|&case| {
                    let entry = &saturation.nodes[case as usize];
                    if entry.facts.contains_key(&nothing) {
                        entry.why(nothing)
                    } else {
                        entry.why(fact)
                    }
                })
                .collect()
        };
        let Some(&first) = open.first() else {
            let mut premises = base_premises;
            premises.extend(case_premises(self, nothing));
            return Ok(self.add_union_fact(node, nothing, premises));
        };
        let held = |saturation: &Self, fact: ExprId| saturation.holds(node, fact);
        let mut common = Vec::new();
        for &case in &open {
            for &fact in &self.nodes[case as usize].order {
                if fact == self.idx.thing || held(self, fact) {
                    continue;
                }
                let everywhere = open.iter().all(|&other| self.holds(other, fact));
                if everywhere {
                    if case == first {
                        common.push(fact);
                    }
                } else if self.read_by_neighbours(fact) {
                    return Err(UnionStop::NotLocal(axiom, node));
                }
            }
        }
        let mut progress = false;
        for fact in common {
            let mut premises = base_premises.clone();
            premises.extend(case_premises(self, fact));
            progress |= self.add_union_fact(node, fact, premises);
        }
        Ok(progress)
    }
}
