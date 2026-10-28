//! Property chains: `SubObjectPropertyOf(ObjectPropertyChain(P₁ … Pₙ), S)`.
//!
//! Three rules, applied when the saturation is otherwise quiet, over the current successors:
//! `chain-edge` (a path of named edges gives the `S` edge), `chain-exists` (a path of successors
//! whose last one is in `G` gives a negative `∃S'.G` with `S ⊑* S'`), and `chain-forall` (`∀S'.F`
//! gives `∀P₁.∀P₂.…∀Pₙ.F`, which the universal rules carry along the links). As for transitivity
//! (a chain `S ∘ S ⊑ S`), this is complete for regular hierarchies; a non-regular one is refused.

use super::model::{Expr, ExprId, PropId};
use super::saturate::{NodeId, NodeKind, Prem, Saturation};

/// The most path steps one chain round may take before the request is refused as too large.
const MAX_CHAIN_STEPS: usize = 4_000_000;

pub(crate) struct ChainBudget;

/// A path being followed: where it is, its premises, and whether every step is a named edge.
struct Walk {
    at: NodeId,
    premises: Vec<Prem>,
    named: bool,
}

impl Saturation<'_> {
    /// Every successor of `node`: its current links and, for an individual, its named neighbours.
    fn chain_successors(&self, node: NodeId) -> Vec<(PropId, NodeId, Option<Prem>, bool)> {
        let entry = &self.nodes[node as usize];
        let mut found: Vec<(PropId, NodeId, Option<Prem>, bool)> = entry
            .out_links()
            .iter()
            .map(|&link| &self.links[link as usize])
            .filter(|link| !link.is_superseded())
            .map(|link| (link.prop, link.to, link.why, false))
            .collect();
        found.extend(
            entry
                .named_neighbours()
                .iter()
                .map(|&(prop, neighbour, prem)| (prop, neighbour, Some(prem), true)),
        );
        found
    }

    fn nested_universal(&mut self, properties: &[PropId], filler: ExprId) -> ExprId {
        properties.iter().rev().fold(filler, |inner, &prop| {
            self.model.intern(Expr::All(prop, inner))
        })
    }

    /// One round of the chain rules over every node. Returns whether anything was added.
    pub(crate) fn chain_round(&mut self) -> Result<bool, ChainBudget> {
        let idx = self.idx;
        if idx.chains.is_empty() {
            return Ok(false);
        }
        let mut progress = false;
        let mut steps = 0usize;
        let count = self.nodes.len() as NodeId;
        for chain in &idx.chains {
            // The negative existentials a chain can introduce: `∃S'.G` with `S ⊑* S'`.
            let negatives: Vec<(PropId, ExprId, ExprId)> = idx
                .neg_exists
                .iter()
                .flat_map(|(&filler, list)| {
                    list.iter()
                        .map(move |&(prop, existential)| (prop, filler, existential))
                })
                .filter(|&(prop, _, _)| self.idx.props().sub(chain.target, prop))
                .collect();
            let mut negatives = negatives;
            negatives.sort_unstable();
            let first = chain.properties[0];
            for node in 0..count {
                let successors = self.chain_successors(node);
                if !successors
                    .iter()
                    .any(|&(prop, ..)| self.idx.props().sub(prop, first))
                {
                    continue;
                }
                // chain-forall: universals of the node over a property above the target.
                let mut universals: Vec<(ExprId, Vec<Prem>)> = Vec::new();
                for &fact in self.nodes[node as usize].universal_facts() {
                    if let Expr::All(prop, filler) = *self.model.expr(fact)
                        && idx.props().sub(chain.target, prop)
                    {
                        let mut premises: Vec<Prem> =
                            self.nodes[node as usize].why(fact).into_iter().collect();
                        self.path_into(chain.target, prop, &mut premises);
                        universals.push((filler, premises));
                    }
                }
                for &over in idx.props().supers(chain.target) {
                    for &(axiom, filler) in idx.universals.get(&over).into_iter().flatten() {
                        let mut premises = vec![Prem::Axiom(axiom)];
                        self.path_into(chain.target, over, &mut premises);
                        universals.push((filler, premises));
                    }
                }
                for (filler, mut premises) in universals {
                    let conclusion = self.nested_universal(&chain.properties, filler);
                    premises.push(Prem::Axiom(chain.axiom));
                    progress |=
                        self.add_chain_fact(node, conclusion, "chain-forall", premises, true);
                }
                // chain-exists and chain-edge: every path along the chain.
                let mut walks = vec![Walk {
                    at: node,
                    premises: vec![Prem::Axiom(chain.axiom)],
                    named: true,
                }];
                for &wanted in &chain.properties {
                    let mut next = Vec::new();
                    for walk in walks {
                        for (prop, to, why, named) in self.chain_successors(walk.at) {
                            steps += 1;
                            if steps > MAX_CHAIN_STEPS {
                                return Err(ChainBudget);
                            }
                            if !idx.props().sub(prop, wanted) {
                                continue;
                            }
                            let mut premises = walk.premises.clone();
                            premises.extend(why);
                            self.path_into(prop, wanted, &mut premises);
                            next.push(Walk {
                                at: to,
                                premises,
                                named: walk.named && named,
                            });
                        }
                    }
                    walks = next;
                }
                for walk in walks {
                    for &(prop, filler, existential) in &negatives {
                        if !self.holds(walk.at, filler) || self.holds(node, existential) {
                            continue;
                        }
                        let mut premises = walk.premises.clone();
                        premises.extend(self.nodes[walk.at as usize].why(filler));
                        self.path_into(chain.target, prop, &mut premises);
                        progress |=
                            self.add_chain_fact(node, existential, "chain-exists", premises, false);
                    }
                    if walk.named
                        && let (NodeKind::Individual(from), NodeKind::Individual(to)) = (
                            &self.nodes[node as usize].kind,
                            &self.nodes[walk.at as usize].kind,
                        )
                    {
                        let (from, to) = (*from, *to);
                        let (sym, inverse) = self.model.prop_parts(chain.target);
                        let (subject, object) = if inverse { (to, from) } else { (from, to) };
                        progress |= self.add_chain_edge(subject, sym, object, walk.premises);
                    }
                }
            }
        }
        Ok(progress)
    }
}
