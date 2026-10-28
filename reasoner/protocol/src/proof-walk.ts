// The proof checker's walk over a decided answer: every inferred statement and lemma is checked once its premises
// are, by its V1 rule (proof.ts) or its Horn rule (proof-horn-rules.ts), and then the unsatisfiability and
// inconsistency evidence is checked against the proved steps.
import { distinctComparableValues } from './literal-values.js';
import { ERDEN_PROOF_CHECKER_SPEC } from './profile.js';
import { hornEntails } from './proof-horn-rules.js';
import { axiomFact, HornPremises, lemmaFact, statementFact, type HornFact } from './proof-horn.js';
import {
    atomicFromAxiom,
    hasValidInconsistencyEvidence,
    hasValidUnsatisfiableEvidence,
    v1RuleEntails,
    type AtomicStatement,
    type DecidedEvidence,
    type ProofValidationIssue,
} from './proof.js';
import type { NormalizedAxiom, ReasonerRequest } from './schema.js';

const OWL_THING = 'http://www.w3.org/2002/07/owl#Thing';
const OWL_NOTHING = 'http://www.w3.org/2002/07/owl#Nothing';

type Inferred = DecidedEvidence['inferred'][number];

const V1_RULES: ReadonlySet<string> = new Set(ERDEN_PROOF_CHECKER_SPEC.rules);
const HORN_RULES: ReadonlySet<string> = new Set(ERDEN_PROOF_CHECKER_SPEC.hornRules);

/** One step of a proof: an inferred statement or a lemma. */
interface ProofStep {
    readonly rule: string;
    readonly premiseIds: ReadonlyArray<string>;
    readonly statement: Inferred | undefined;
    readonly fact: HornFact;
}

/** What a proof's premises resolve to: axioms, asserted statements and proved steps. */
interface ProofContext {
    readonly axioms: ReadonlyMap<string, NormalizedAxiom>;
    readonly asserted: ReadonlyMap<string, DecidedEvidence['asserted'][number]>;
    readonly steps: ReadonlyMap<string, ProofStep>;
    readonly proved: Set<string>;
}

/** The V1 premises of a step: the cited axioms, and the atomic statements of cited axioms and statements. */
function v1Premises(context: ProofContext, premiseIds: ReadonlyArray<string>) {
    const premiseAxioms = premiseIds.flatMap((premiseId) => {
        const axiom = context.axioms.get(premiseId);
        return axiom === undefined ? [] : [axiom];
    });
    const premiseAtoms = premiseIds.flatMap((premiseId): AtomicStatement[] => {
        const axiom = context.axioms.get(premiseId);
        if (axiom !== undefined) {
            const atomic = atomicFromAxiom(axiom);
            return atomic === undefined ? [] : [atomic];
        }
        const assertedStatement = context.asserted.get(premiseId);
        if (assertedStatement !== undefined) {
            return [
                {
                    subject: assertedStatement.subject,
                    predicate: assertedStatement.predicate,
                    object: assertedStatement.object,
                },
            ];
        }
        const step = context.steps.get(premiseId);
        return step?.statement !== undefined && context.proved.has(premiseId)
            ? [{ subject: step.statement.subject, predicate: step.statement.predicate, object: step.statement.object }]
            : [];
    });
    return { premiseAxioms, premiseAtoms };
}

/** The Horn premises of a step: the facts of cited axioms, asserted statements and proved steps, and the axioms. */
function hornPremises(context: ProofContext, premiseIds: ReadonlyArray<string>): HornPremises {
    const facts: HornFact[] = [];
    const axioms: NormalizedAxiom[] = [];
    for (const premiseId of premiseIds) {
        const axiom = context.axioms.get(premiseId);
        if (axiom !== undefined) {
            axioms.push(axiom);
            const fact = axiomFact(axiom);
            if (fact !== undefined) {
                facts.push(fact);
            }
            continue;
        }
        const assertedStatement = context.asserted.get(premiseId);
        if (assertedStatement !== undefined) {
            facts.push(statementFact(assertedStatement));
            continue;
        }
        const step = context.steps.get(premiseId);
        if (step !== undefined && context.proved.has(premiseId)) {
            facts.push(step.fact);
        }
    }
    return new HornPremises(facts, axioms);
}

function stepEntails(context: ProofContext, step: ProofStep): boolean {
    if (V1_RULES.has(step.rule)) {
        if (step.statement === undefined) {
            return false;
        }
        const { premiseAxioms, premiseAtoms } = v1Premises(context, step.premiseIds);
        return v1RuleEntails(step.statement, premiseAxioms, premiseAtoms);
    }
    return HORN_RULES.has(step.rule) && hornEntails(step.rule, step.fact, hornPremises(context, step.premiseIds));
}

function proofSteps(evidence: DecidedEvidence): Map<string, ProofStep> {
    const steps = new Map<string, ProofStep>();
    for (const statement of evidence.inferred) {
        steps.set(statement.id, {
            rule: statement.provenance.rule,
            premiseIds: statement.provenance.premiseIds,
            statement,
            fact: statementFact(statement),
        });
    }
    for (const lemma of evidence.lemmas ?? []) {
        steps.set(lemma.id, {
            rule: lemma.rule,
            premiseIds: lemma.premiseIds,
            statement: undefined,
            fact: lemmaFact(lemma),
        });
    }
    return steps;
}

/** Walks the premise graph of every step, depth first, checking each step once its premises are proved. */
function checkSteps(context: ProofContext, issues: Set<ProofValidationIssue>): void {
    const state = new Map<string, 'visiting' | 'visited'>();
    function visit(id: string): boolean {
        const current = state.get(id);
        if (current === 'visiting') {
            issues.add('derivation-cycle');
            return false;
        }
        const step = context.steps.get(id);
        if (current === 'visited' || step === undefined) {
            return context.proved.has(id);
        }
        state.set(id, 'visiting');
        let dependenciesValid = true;
        for (const premiseId of step.premiseIds) {
            if (context.steps.has(premiseId)) {
                dependenciesValid = visit(premiseId) && dependenciesValid;
            } else if (!context.axioms.has(premiseId) && !context.asserted.has(premiseId)) {
                issues.add('missing-proof-premise');
                dependenciesValid = false;
            }
        }
        const knownRule = V1_RULES.has(step.rule) || HORN_RULES.has(step.rule);
        if (!knownRule) {
            issues.add('unknown-proof-rule');
        }
        if (!dependenciesValid || !knownRule || !stepEntails(context, step)) {
            issues.add('not-entailed');
        } else {
            context.proved.add(id);
        }
        state.set(id, 'visited');
        return context.proved.has(id);
    }
    for (const id of context.steps.keys()) {
        visit(id);
    }
}

function provesNothing(context: ProofContext, id: string, subject: (fact: HornFact) => boolean): boolean {
    const step = context.steps.get(id);
    return (
        step !== undefined &&
        context.proved.has(id) &&
        step.fact.kind === 'class' &&
        step.fact.expression.kind === 'NamedClass' &&
        step.fact.expression.iri === OWL_NOTHING &&
        subject(step.fact)
    );
}

/** A Horn unsatisfiable class: a cited, proved step concluding `C ⊑ owl:Nothing`. */
function hasHornUnsatisfiableEvidence(
    context: ProofContext,
    item: DecidedEvidence['unsatisfiableClasses'][number],
): boolean {
    return item.premiseIds.some((id) =>
        provesNothing(
            context,
            id,
            (fact) =>
                fact.kind === 'class' &&
                fact.subject.kind === 'context' &&
                fact.subject.context.kind === 'NamedClass' &&
                fact.subject.context.iri === item.classIri,
        ),
    );
}

/** The data facts a diagnostic cites: asserted data property assertions and proved inferred data statements. */
function citedDataFacts(context: ProofContext, ids: ReadonlyArray<string>) {
    return ids.flatMap((id) => {
        const axiom = context.axioms.get(id);
        if (axiom?.kind === 'DataPropertyAssertion') {
            return [{ subject: axiom.subject, property: axiom.property, value: axiom.value }];
        }
        const step = context.steps.get(id);
        return step !== undefined && context.proved.has(id) && step.fact.kind === 'data' ? [step.fact] : [];
    });
}

function hasFunctionalDataClash(context: ProofContext, axiomIds: ReadonlyArray<string>): boolean {
    const axioms = axiomIds.flatMap((id) => {
        const axiom = context.axioms.get(id);
        return axiom === undefined ? [] : [axiom];
    });
    const premises = new HornPremises([], axioms);
    const data = citedDataFacts(context, axiomIds);
    return axioms.some(
        (functional) =>
            functional.kind === 'FunctionalDataProperty' &&
            data.some((left) =>
                data.some(
                    (right) =>
                        left.subject === right.subject &&
                        premises.subDataProperty(left.property, functional.property) &&
                        premises.subDataProperty(right.property, functional.property) &&
                        distinctComparableValues(left.value, right.value),
                ),
            ),
    );
}

/**
 * A Horn inconsistency: a proved step concluding that an individual, or every element (`owl:Thing`), is in
 * `owl:Nothing`; or two literals of one subject under a functional data property (through cited sub-property axioms)
 * whose values the checker itself shows to be different.
 */
function hasHornInconsistencyEvidence(context: ProofContext, evidence: DecidedEvidence): boolean {
    return evidence.diagnostics.some((diagnostic) => {
        if (diagnostic.code === 'derived-inconsistency') {
            return diagnostic.axiomIds.some((id) =>
                provesNothing(
                    context,
                    id,
                    (fact) =>
                        fact.kind === 'class' &&
                        (fact.subject.kind === 'individual' ||
                            (fact.subject.context.kind === 'NamedClass' && fact.subject.context.iri === OWL_THING)),
                ),
            );
        }
        return diagnostic.code === 'functional-data-clash' && hasFunctionalDataClash(context, diagnostic.axiomIds);
    });
}

/** Verifies the derivation DAG of statements and lemmas, every V1 and Horn proof rule, and the evidence. */
export function getProofValidationIssues(
    request: ReasonerRequest,
    evidence: DecidedEvidence,
): ReadonlyArray<ProofValidationIssue> {
    const issues = new Set<ProofValidationIssue>();
    const inferredIds = evidence.inferred.map((statement) => statement.id);
    const lemmaIds = (evidence.lemmas ?? []).map((lemma) => lemma.id);
    if (new Set([...inferredIds, ...lemmaIds]).size !== inferredIds.length + lemmaIds.length) {
        issues.add('duplicate-inferred-id');
    }
    const context: ProofContext = {
        axioms: new Map(request.ontology.axioms.map((axiom) => [axiom.id, axiom])),
        asserted: new Map(evidence.asserted.map((statement) => [statement.id, statement])),
        steps: proofSteps(evidence),
        proved: new Set<string>(),
    };
    checkSteps(context, issues);
    const inferred = new Map(evidence.inferred.map((statement) => [statement.id, statement]));
    if (
        evidence.consistency === 'inconsistent' &&
        !hasValidInconsistencyEvidence(context.axioms, evidence) &&
        !hasHornInconsistencyEvidence(context, evidence)
    ) {
        issues.add('invalid-inconsistency-evidence');
    }
    if (
        evidence.unsatisfiableClasses.some(
            (item) =>
                !hasValidUnsatisfiableEvidence(item, context.axioms, inferred) &&
                !hasHornUnsatisfiableEvidence(context, item),
        ) ||
        // OWL 2 Direct Semantics needs a non-empty domain: an unsatisfiable owl:Thing leaves the
        // ontology without a model, so a consistent answer cannot list it.
        (evidence.consistency === 'consistent' &&
            evidence.unsatisfiableClasses.some((item) => item.classIri === OWL_THING))
    ) {
        issues.add('invalid-unsatisfiable-evidence');
    }
    return [...issues].sort();
}

export function assertValidReasonerProof(request: ReasonerRequest, evidence: DecidedEvidence): void {
    const issues = getProofValidationIssues(request, evidence);
    if (issues.length > 0) {
        throw new TypeError(`Invalid Erden proof: ${issues.join(', ')}`);
    }
}
